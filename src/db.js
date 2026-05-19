"use strict";

const { Pool } = require("pg");
const config = require("./config");
const logger = require("./logger");

const log = logger.child({ component: "db" });

const pool = new Pool({
  connectionString: config.db.url,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  // Neon requires SSL; keep relaxed verification off in prod environments
  // where the connection string already encodes sslmode=require.
});

pool.on("error", (err) => {
  log.error({ err }, "Idle Postgres client error");
});

function quoteIdent(name) {
  return `"${name.replace(/"/g, '""')}"`;
}

const CHUNKS_TABLE = quoteIdent(config.db.table);
const DOCS_TABLE = quoteIdent("documents");
const SESSIONS_TABLE = quoteIdent("sessions");
const MESSAGES_TABLE = quoteIdent("messages");
const MEMORY_TABLE = quoteIdent("conversation_memory");
const FAVORITES_TABLE = quoteIdent("favorites");
const HNSW_INDEX = quoteIdent(`${config.db.table}_embedding_hnsw_idx`);
const TSV_INDEX = quoteIdent(`${config.db.table}_tsv_gin_idx`);
const DOC_INDEX = quoteIdent(`${config.db.table}_doc_id_idx`);
const CHUNK_META_INDEX = quoteIdent(`${config.db.table}_metadata_gin_idx`);
const DOCS_META_INDEX = quoteIdent("documents_metadata_gin_idx");
const DOCS_TYPE_INDEX = quoteIdent("documents_doc_type_idx");
const DOCS_LANG_INDEX = quoteIdent("documents_language_idx");
const SESSIONS_USER_INDEX = quoteIdent("sessions_user_updated_idx");
const MESSAGES_SESSION_INDEX = quoteIdent("messages_session_created_idx");
const MEMORY_USER_INDEX = quoteIdent("conversation_memory_user_idx");
const MEMORY_HNSW_INDEX = quoteIdent("conversation_memory_embedding_hnsw_idx");
const FAVORITES_USER_INDEX = quoteIdent("favorites_user_created_idx");

async function withClient(fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

async function ensureSchema() {
  await withClient(async (client) => {
    await client.query("CREATE EXTENSION IF NOT EXISTS vector");

    // Parent table — one row per scraped page/listing.
    // Holds doc-level metadata (price, location, language, type) so we can
    // filter at retrieval time without scanning chunks.
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${DOCS_TABLE} (
        doc_id        TEXT PRIMARY KEY,
        url           TEXT NOT NULL UNIQUE,
        title         TEXT,
        doc_type      TEXT NOT NULL DEFAULT 'article',
        language      TEXT NOT NULL DEFAULT 'en',
        metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
        source_hash   TEXT,
        scraped_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS ${DOCS_META_INDEX}
        ON ${DOCS_TABLE} USING gin (metadata jsonb_path_ops)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS ${DOCS_TYPE_INDEX} ON ${DOCS_TABLE} (doc_type)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS ${DOCS_LANG_INDEX} ON ${DOCS_TABLE} (language)
    `);

    // Chunks table — many per document.
    // tsvector uses 'simple' config (no stemming) so multilingual content
    // (Azerbaijani / Russian / English) all index correctly. Stemming would
    // break exact-term matching for addresses, prices, neighborhood names.
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${CHUNKS_TABLE} (
        id            BIGSERIAL PRIMARY KEY,
        doc_id        TEXT NOT NULL REFERENCES ${DOCS_TABLE}(doc_id) ON DELETE CASCADE,
        url           TEXT NOT NULL,
        chunk_index   INTEGER NOT NULL,
        content       TEXT NOT NULL,
        content_hash  TEXT NOT NULL,
        metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
        embedding     vector(${config.embedding.dim}) NOT NULL,
        tsv           tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (doc_id, chunk_index)
      )
    `);

    // HNSW for cosine ANN — m=16 / ef_construction=64 are pgvector's defaults
    // and handle our corpus size (<1M vectors) with no training step.
    await client.query(`
      CREATE INDEX IF NOT EXISTS ${HNSW_INDEX}
        ON ${CHUNKS_TABLE} USING hnsw (embedding vector_cosine_ops)
        WITH (m = 16, ef_construction = 64)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS ${TSV_INDEX} ON ${CHUNKS_TABLE} USING gin (tsv)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS ${DOC_INDEX} ON ${CHUNKS_TABLE} (doc_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS ${CHUNK_META_INDEX}
        ON ${CHUNKS_TABLE} USING gin (metadata jsonb_path_ops)
    `);

    // pgcrypto for gen_random_uuid() — pgvector usually pulls this in, but
    // create explicitly so the migration is self-contained.
    await client.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

    // Chat sessions — one row per conversation thread.
    // user_id is the username from the auth cookie today; trivially widens
    // to a real IdP subject id when production auth lands.
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${SESSIONS_TABLE} (
        session_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     TEXT NOT NULL,
        title       TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS ${SESSIONS_USER_INDEX}
        ON ${SESSIONS_TABLE} (user_id, updated_at DESC)
    `);

    // Messages — user/assistant turns within a session.
    // ON DELETE CASCADE so deleting a session wipes its messages atomically.
    // sources JSONB lives only on assistant rows (the top-K source chunks
    // shown for that turn, frozen at answer time).
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${MESSAGES_TABLE} (
        id           BIGSERIAL PRIMARY KEY,
        session_id   UUID NOT NULL REFERENCES ${SESSIONS_TABLE}(session_id) ON DELETE CASCADE,
        role         TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content      TEXT NOT NULL,
        sources      JSONB,
        metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS ${MESSAGES_SESSION_INDEX}
        ON ${MESSAGES_TABLE} (session_id, created_at)
    `);

    // Cross-session conversation memory.
    // One row per (user-question, assistant-answer) pair, embedded so a new
    // session can semantically recall what was discussed in prior sessions.
    // session_id + message_id are NULLABLE so memory survives if a single
    // message is deleted but the session is preserved (we keep cascade on
    // session deletion for true erasure).
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${MEMORY_TABLE} (
        id           BIGSERIAL PRIMARY KEY,
        user_id      TEXT NOT NULL,
        session_id   UUID REFERENCES ${SESSIONS_TABLE}(session_id) ON DELETE CASCADE,
        message_id   BIGINT REFERENCES ${MESSAGES_TABLE}(id) ON DELETE SET NULL,
        content      TEXT NOT NULL,
        embedding    vector(${config.embedding.dim}) NOT NULL,
        metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS ${MEMORY_USER_INDEX}
        ON ${MEMORY_TABLE} (user_id, created_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS ${MEMORY_HNSW_INDEX}
        ON ${MEMORY_TABLE} USING hnsw (embedding vector_cosine_ops)
        WITH (m = 16, ef_construction = 64)
    `);

    // Favorites — saved listings per user.
    // UNIQUE(user_id, doc_id) makes "save" idempotent (clicking the heart
    // twice in quick succession produces at most one row). ON DELETE
    // CASCADE on doc_id keeps the table clean when the corpus is rebuilt.
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${FAVORITES_TABLE} (
        id          BIGSERIAL PRIMARY KEY,
        user_id     TEXT NOT NULL,
        doc_id      TEXT NOT NULL REFERENCES ${DOCS_TABLE}(doc_id) ON DELETE CASCADE,
        note        TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_id, doc_id)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS ${FAVORITES_USER_INDEX}
        ON ${FAVORITES_TABLE} (user_id, created_at DESC)
    `);
  });
  log.info(
    {
      docsTable: "documents",
      chunksTable: config.db.table,
      sessionsTable: "sessions",
      messagesTable: "messages",
      dim: config.embedding.dim,
    },
    "schema ready",
  );
}

async function dropSchema() {
  await withClient(async (client) => {
    await client.query(`DROP TABLE IF EXISTS ${FAVORITES_TABLE} CASCADE`);
    await client.query(`DROP TABLE IF EXISTS ${MEMORY_TABLE} CASCADE`);
    await client.query(`DROP TABLE IF EXISTS ${MESSAGES_TABLE} CASCADE`);
    await client.query(`DROP TABLE IF EXISTS ${SESSIONS_TABLE} CASCADE`);
    await client.query(`DROP TABLE IF EXISTS ${CHUNKS_TABLE} CASCADE`);
    await client.query(`DROP TABLE IF EXISTS ${DOCS_TABLE} CASCADE`);
  });
  log.warn(
    { tables: ["conversation_memory", "messages", "sessions", config.db.table, "documents"] },
    "schema dropped",
  );
}

async function analyze() {
  await pool.query(`ANALYZE ${CHUNKS_TABLE}`);
  await pool.query(`ANALYZE ${DOCS_TABLE}`);
}

async function ping() {
  const res = await pool.query("SELECT 1 AS ok");
  return res.rows[0]?.ok === 1;
}

async function close() {
  await pool.end();
}

module.exports = {
  pool,
  withClient,
  ensureSchema,
  dropSchema,
  analyze,
  ping,
  close,
  CHUNKS_TABLE,
  DOCS_TABLE,
  SESSIONS_TABLE,
  MESSAGES_TABLE,
  MEMORY_TABLE,
  FAVORITES_TABLE,
  // Back-compat alias used by older modules.
  TABLE: CHUNKS_TABLE,
  quoteIdent,
};
