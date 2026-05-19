#!/usr/bin/env node
"use strict";

/**
 * Self-documenting schema.
 *
 * Applies COMMENT ON TABLE and COMMENT ON COLUMN for every table + column
 * we own. Idempotent — COMMENT statements overwrite, so running this twice
 * is the same as running it once. Safe to invoke on any new DB after
 * migration; DBeaver / pgAdmin / psql `\d+` then render the descriptions
 * inline as you hover columns.
 *
 *   npm run comments
 *
 * Add new tables/columns? Update the maps below; the runner picks them up
 * automatically. Missing entries are skipped with a warning.
 */

const db = require("../src/db");
const logger = require("../src/logger");

const log = logger.child({ component: "comments" });

// ---------------------------------------------------------------------------
// Table-level comments
// ---------------------------------------------------------------------------

const TABLE_COMMENTS = {
  documents: `One row per scraped web page / listing. Holds doc-level metadata
    (title, language, doc_type, jsonb facts) so retrieval filters can run
    without joining individual chunks. Parent of rag_chunks via doc_id.`,

  rag_chunks: `Text chunks from documents, embedded for vector search and
    full-text indexed for lexical search. The canonical retrieval target —
    every [Sn] citation in an assistant answer points to one row here.
    (doc_id, chunk_index) is the natural composite key; id is the
    surrogate PK for joins from sessions/messages.sources JSONB.`,

  sessions: `Chat session = one conversation thread. user_id ties the thread
    to whoever logged in; updated_at drives the sidebar ordering. Deleting
    a session cascades to messages and conversation_memory so erasure is
    one DELETE.`,

  messages: `Append-only chat turns within a session. role is 'user' or
    'assistant'. sources JSONB is the frozen snapshot of the chunks shown
    for that assistant turn (so the audit trail survives even if rag_chunks
    is later re-ingested). metadata holds model id, usage, retrieval mode.`,

  conversation_memory: `Cross-session memory for RAG-over-conversation-history.
    One row per persisted (Q,A) pair, embedded with the same Voyage model
    as the corpus so similarity search composes cleanly. Recalled in new
    sessions to give the LLM continuity context — NEVER cited as a factual
    source ([Mn] in prompts is advisory only).`,

  favorites: `Per-user saved listings ("hearts" in the UI). One row per
    (user_id, doc_id) — UNIQUE constraint makes the "save" action
    idempotent. Cascades on document deletion so a corpus rebuild doesn't
    leave orphaned bookmarks.`,
};

// ---------------------------------------------------------------------------
// Column-level comments — keyed as "table.column"
// ---------------------------------------------------------------------------

const COLUMN_COMMENTS = {
  // ---- documents ---------------------------------------------------------
  "documents.doc_id":
    "Stable identifier for the page. SHA-1 hash of the URL, truncated to 16 hex chars. Deterministic — same URL produces same doc_id across re-scrapes, which keeps chunks idempotent.",
  "documents.url":
    "Canonical source URL. UNIQUE across the table; one URL = one document row even if it produces many chunks.",
  "documents.title":
    "Page title from <title> or the first H1. Used in source cards and as a debugging label. Nullable for pages with no detectable title.",
  "documents.doc_type":
    "Coarse content classification: 'listing' | 'article' | 'static'. Drives chunker dispatch (listings → 1 atomic chunk, articles → heading splitter) and the doc_type filter at retrieval time.",
  "documents.language":
    "Language tag detected from the URL path prefix (/en, /az, /ru). Used by the retrieval filter and by the LLM as a hint for response language matching.",
  "documents.metadata":
    "Doc-level extracted facts as JSONB. For listings: price, currency, bedrooms, total_rooms, area_sqm, property_type, listing_type, location. Indexed with gin(jsonb_path_ops) so range/equality filters at query time don't scan.",
  "documents.source_hash":
    "SHA-256 of the raw scraped markdown. On re-scrape, an unchanged hash short-circuits chunk re-embedding (Voyage call avoided).",
  "documents.scraped_at": "First time this URL was successfully scraped.",
  "documents.updated_at":
    "Last time the row was upserted (rescrape or metadata refresh). Drives staleness checks.",

  // ---- rag_chunks --------------------------------------------------------
  "rag_chunks.id":
    "Surrogate PK. The most precise way to reference a single chunk from outside (messages.sources JSONB stores this, sidebar trace chips copy this).",
  "rag_chunks.doc_id":
    "FK to documents(doc_id) ON DELETE CASCADE. Deleting a document wipes its chunks atomically.",
  "rag_chunks.url":
    "Denormalized copy of documents.url. Saves a JOIN on every retrieval row shaping (~10% query latency).",
  "rag_chunks.chunk_index":
    "0-based position of this chunk within its document. UNIQUE with doc_id — composite natural key. chunk_index=0 is the first chunk of the page.",
  "rag_chunks.content":
    "The chunk's text content, post-normalization (whitespace collapsed, image refs stripped, link wrappers reduced to anchor text). What the LLM actually reads.",
  "rag_chunks.content_hash":
    "SHA-256 of content. The ingest pipeline reads existing hashes per (doc_id, chunk_index) and skips embedding for unchanged rows — re-running ingest on an unchanged corpus is a near no-op.",
  "rag_chunks.metadata":
    "Chunk-level JSONB. Inherits doc-level facts (so retrieval can filter without joining documents) plus any chunk-specific extractions. Indexed with gin(jsonb_path_ops).",
  "rag_chunks.embedding":
    "1024-d dense vector from Voyage voyage-4-large with inputType='document'. HNSW index (m=16, ef_construction=64) on vector_cosine_ops for ANN search.",
  "rag_chunks.tsv":
    "Generated tsvector from content using the 'simple' Postgres FTS config (no stemming). 'simple' chosen for multilingual robustness (AZ/RU/EN all index correctly without language-specific stemmers).",
  "rag_chunks.created_at": "Row insertion time.",
  "rag_chunks.updated_at": "Last upsert time (re-embedding or metadata refresh).",

  // ---- sessions ----------------------------------------------------------
  "sessions.session_id":
    "UUID PK (gen_random_uuid). Used in the URL (?c=<uuid>) so a tab can be reloaded or shared without losing context.",
  "sessions.user_id":
    "Owner. Today the configured DEMO_USERNAME; when real auth lands this becomes the JWT subject claim. Every session/message/memory query is scoped by user_id.",
  "sessions.title":
    "Auto-derived from the first user message (truncated to 80 chars). Editable when the user wants to rename a chat (UI hook pending).",
  "sessions.created_at": "Session creation time.",
  "sessions.updated_at":
    "Bumped on every new message. Drives the sidebar sort order (most-recent-first).",

  // ---- messages ----------------------------------------------------------
  "messages.id":
    "Append-only auto-increment PK. Stable per-message handle used by conversation_memory.message_id (ON DELETE SET NULL — memory survives single-message deletion).",
  "messages.session_id":
    "FK to sessions(session_id) ON DELETE CASCADE. Drops all messages when the session is deleted.",
  "messages.role":
    "Conversation role — CHECK (role IN ('user','assistant')). System turns are not persisted (the system prompt is regenerated server-side per turn from cache).",
  "messages.content":
    "Raw text of the message. For assistant rows: the full streamed answer; for user rows: the user's question.",
  "messages.sources":
    "JSONB snapshot of the source chunks shown for this assistant turn — frozen at answer time so the audit trail survives even if the corpus is later re-ingested. NULL for user rows.",
  "messages.metadata":
    "JSONB with model id, token usage (input/output/cache), retrieval metadata (mode, reranked, fallback, cached), and stop_reason. Useful for cost attribution and debugging.",
  "messages.created_at":
    "Message timestamp. ORDER BY created_at gives the conversation in correct order.",

  // ---- conversation_memory ----------------------------------------------
  "conversation_memory.id":
    "Append-only PK for a single memory row (Q+A pair).",
  "conversation_memory.user_id":
    "Owner of the memory. Recall queries always include WHERE user_id = $1 — memory never leaks across users.",
  "conversation_memory.session_id":
    "FK to sessions(session_id) ON DELETE CASCADE. Deleting a session also forgets its memory — matches user intuition ('delete this chat = forget this chat').",
  "conversation_memory.message_id":
    "FK to messages(id) ON DELETE SET NULL. Survives single-message deletion (rare, but lets you redact one Q/A pair without losing its retrievable memory).",
  "conversation_memory.content":
    "Concatenated 'Q: …\\nA: …' pair (each side truncated to MEMORY_CHAR_CAP=700 chars). What gets embedded; what gets shown to the LLM as the [Mn] body.",
  "conversation_memory.embedding":
    "1024-d Voyage embedding of content, with inputType='document'. Same vector space as the corpus, so a single retrieval design works for both. HNSW indexed.",
  "conversation_memory.metadata":
    "JSONB with previews of the original question/answer (for inspection — full content lives in the 'content' column).",
  "conversation_memory.created_at":
    "Memory write time. Used in the recency-boosted recall score (newer memories edge out same-similarity older ones; ~14d half-life).",

  // ---- favorites ---------------------------------------------------------
  "favorites.id":
    "Surrogate PK. Used by the DELETE endpoint to unsave a specific bookmark.",
  "favorites.user_id":
    "Owner. UNIQUE(user_id, doc_id) prevents duplicate saves and makes the POST endpoint idempotent.",
  "favorites.doc_id":
    "FK to documents(doc_id) ON DELETE CASCADE. Favoriting points at the WHOLE page, not a specific chunk — saving a listing across re-chunking is the right granularity.",
  "favorites.note":
    "Optional user-written note attached to the bookmark (\"good price\", \"check sea view\", etc.). NULL by default.",
  "favorites.created_at":
    "When the user saved this listing. Used to order the Saved panel (most-recently-saved first).",
};

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

// Postgres requires COMMENT IS to take a literal string — parameterized
// placeholders ($1, $2) are NOT allowed in the IS clause. We inline the
// value with single-quote escaping (double the quote).
function quoteLiteral(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

async function applyComments() {
  let tablesApplied = 0;
  let columnsApplied = 0;
  const skipped = [];

  await db.withClient(async (client) => {
    // 1) Tables
    for (const [table, raw] of Object.entries(TABLE_COMMENTS)) {
      const comment = raw.replace(/\s+/g, " ").trim();
      try {
        await client.query(
          `COMMENT ON TABLE ${quoteIdent(table)} IS ${quoteLiteral(comment)}`,
        );
        tablesApplied += 1;
      } catch (err) {
        skipped.push({ kind: "table", name: table, err: err.message });
      }
    }

    // 2) Columns
    for (const [key, raw] of Object.entries(COLUMN_COMMENTS)) {
      const [table, col] = key.split(".");
      if (!table || !col) {
        skipped.push({ kind: "column", name: key, err: "malformed key" });
        continue;
      }
      const comment = raw.replace(/\s+/g, " ").trim();
      try {
        await client.query(
          `COMMENT ON COLUMN ${quoteIdent(table)}.${quoteIdent(col)} IS ${quoteLiteral(comment)}`,
        );
        columnsApplied += 1;
      } catch (err) {
        skipped.push({ kind: "column", name: key, err: err.message });
      }
    }
  });

  log.info({ tablesApplied, columnsApplied, skippedCount: skipped.length }, "comments applied");
  if (skipped.length) {
    for (const s of skipped) log.warn(s, "skipped");
  }
  return { tablesApplied, columnsApplied, skipped };
}

async function main() {
  log.info({ tables: Object.keys(TABLE_COMMENTS).length, columns: Object.keys(COLUMN_COMMENTS).length }, "starting comment-schema");
  await applyComments();
  await db.close();
}

if (require.main === module) {
  main().catch((err) => {
    log.fatal({ err: err.message, stack: err.stack }, "comment-schema failed");
    db.close().catch(() => {});
    process.exit(1);
  });
}

module.exports = { applyComments, TABLE_COMMENTS, COLUMN_COMMENTS };
