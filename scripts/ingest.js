#!/usr/bin/env node
"use strict";

/**
 * Ingestion pipeline.
 *
 *   JSONL corpus  →  chunkDocument (listing-aware)  →  document upsert
 *                 →  diff existing chunks by content_hash
 *                 →  embed only the changed/new chunks (asymmetric: inputType="document")
 *                 →  chunk upsert  →  prune stale chunks  →  ANALYZE
 *
 * Idempotent: an unchanged corpus re-runs as a no-op. Content hash skips
 * the expensive Voyage call; doc-level upsert refreshes title/metadata
 * cheaply.
 */

const fs = require("node:fs");
const readline = require("node:readline");

const config = require("../src/config");
const logger = require("../src/logger");
const db = require("../src/db");
const { chunkDocument } = require("../src/chunker");
const { embedBatch, toVectorLiteral } = require("../src/embedder");

const log = logger.child({ component: "ingest" });

// ---------------------------------------------------------------------------
// Document + chunk persistence
// ---------------------------------------------------------------------------

async function upsertDocument(client, doc) {
  await client.query(
    `
      INSERT INTO ${db.DOCS_TABLE}
        (doc_id, url, title, doc_type, language, metadata, source_hash, scraped_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, NOW(), NOW())
      ON CONFLICT (doc_id) DO UPDATE SET
        url = EXCLUDED.url,
        title = EXCLUDED.title,
        doc_type = EXCLUDED.doc_type,
        language = EXCLUDED.language,
        metadata = EXCLUDED.metadata,
        source_hash = EXCLUDED.source_hash,
        updated_at = NOW()
    `,
    [
      doc.doc_id,
      doc.url,
      doc.title,
      doc.doc_type,
      doc.language,
      JSON.stringify(doc.metadata || {}),
      doc.source_hash,
    ],
  );
}

async function existingHashes(client, docIds) {
  if (!docIds.length) return new Map();
  const { rows } = await client.query(
    `SELECT doc_id, chunk_index, content_hash
     FROM ${db.CHUNKS_TABLE}
     WHERE doc_id = ANY($1::text[])`,
    [docIds],
  );
  const map = new Map();
  for (const row of rows) {
    map.set(`${row.doc_id}::${row.chunk_index}`, row.content_hash);
  }
  return map;
}

async function pruneStaleChunks(client, docId, keepCount) {
  await client.query(
    `DELETE FROM ${db.CHUNKS_TABLE} WHERE doc_id = $1 AND chunk_index >= $2`,
    [docId, keepCount],
  );
}

async function upsertChunkBatch(client, rows) {
  if (!rows.length) return;
  const values = [];
  const placeholders = rows
    .map((row, i) => {
      const base = i * 7;
      values.push(
        row.docId,
        row.url,
        row.chunkIndex,
        row.content,
        row.contentHash,
        JSON.stringify(row.metadata || {}),
        toVectorLiteral(row.embedding),
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}::jsonb, $${base + 7}::vector)`;
    })
    .join(", ");

  await client.query(
    `
      INSERT INTO ${db.CHUNKS_TABLE}
        (doc_id, url, chunk_index, content, content_hash, metadata, embedding)
      VALUES ${placeholders}
      ON CONFLICT (doc_id, chunk_index) DO UPDATE SET
        url = EXCLUDED.url,
        content = EXCLUDED.content,
        content_hash = EXCLUDED.content_hash,
        metadata = EXCLUDED.metadata,
        embedding = EXCLUDED.embedding,
        updated_at = NOW()
    `,
    values,
  );
}

// ---------------------------------------------------------------------------
// JSONL reader (tolerates both new and legacy record shapes)
// ---------------------------------------------------------------------------

async function* readJsonl(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  for await (const raw of rl) {
    lineNo += 1;
    const line = raw.trim();
    if (!line) continue;
    try {
      yield { lineNo, record: JSON.parse(line) };
    } catch (err) {
      log.warn({ lineNo, err: err.message }, "skipping invalid JSONL line");
    }
  }
}

function normalizeRecord(record, lineNo) {
  // New scraper schema:
  //   { doc_id, url, title, language, doc_type, markdown, html, source_metadata }
  // Legacy schema (for back-compat with old corpus.jsonl files):
  //   { id, url, text, metadata }
  if (record.markdown || record.doc_type) return record;
  return {
    doc_id: String(record.id || record.url || `line-${lineNo}`),
    url: String(record.url || ""),
    title: record.metadata?.title || null,
    language: "en",
    doc_type: "article",
    markdown: record.text || record.content || "",
    html: "",
    source_metadata: record.metadata || {},
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const inputPath = config.paths.inputJsonl;
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input JSONL not found: ${inputPath}`);
  }

  log.info(
    {
      input: inputPath,
      docsTable: "documents",
      chunksTable: config.db.table,
      chunkSize: config.ingest.chunkSize,
      chunkOverlap: config.ingest.chunkOverlap,
      embeddingModel: config.embedding.model,
      vectorDim: config.embedding.dim,
    },
    "starting ingest",
  );

  await db.ensureSchema();

  const startedAt = Date.now();
  const stats = {
    docsTotal: 0,
    docsByType: {},
    docsByLang: {},
    chunksTotal: 0,
    embedded: 0,
    skippedUnchanged: 0,
    skippedEmpty: 0,
  };

  let docBatch = [];
  const DOC_BATCH = 8;

  const flushDocBatch = async () => {
    if (!docBatch.length) return;

    await db.withClient(async (client) => {
      // Documents first (chunks FK them).
      for (const { doc } of docBatch) {
        await upsertDocument(client, doc);
      }

      const docIds = docBatch.map(({ doc }) => doc.doc_id);
      const existing = await existingHashes(client, docIds);

      const needEmbedding = [];
      for (const { doc, chunks } of docBatch) {
        for (const chunk of chunks) {
          const key = `${doc.doc_id}::${chunk.chunk_index}`;
          if (existing.get(key) === chunk.content_hash) {
            stats.skippedUnchanged += 1;
            continue;
          }
          needEmbedding.push({
            docId: doc.doc_id,
            url: doc.url,
            chunkIndex: chunk.chunk_index,
            content: chunk.content,
            contentHash: chunk.content_hash,
            metadata: chunk.metadata,
          });
        }
      }

      if (needEmbedding.length) {
        const vectors = await embedBatch(
          needEmbedding.map((r) => r.content),
          { inputType: "document" },
        );
        for (let i = 0; i < needEmbedding.length; i += 1) {
          needEmbedding[i].embedding = vectors[i];
        }
        stats.embedded += needEmbedding.length;

        for (let i = 0; i < needEmbedding.length; i += config.ingest.batchSize) {
          await upsertChunkBatch(
            client,
            needEmbedding.slice(i, i + config.ingest.batchSize),
          );
        }
      }

      for (const { doc, chunks } of docBatch) {
        await pruneStaleChunks(client, doc.doc_id, chunks.length);
      }
    });

    docBatch = [];
  };

  for await (const { lineNo, record } of readJsonl(inputPath)) {
    const norm = normalizeRecord(record, lineNo);
    const { doc, chunks } = chunkDocument(norm, {
      maxChars: config.ingest.chunkSize,
      overlap: config.ingest.chunkOverlap,
      minChars: config.ingest.minChunkSize,
    });
    if (!chunks.length) {
      stats.skippedEmpty += 1;
      continue;
    }

    stats.docsTotal += 1;
    stats.docsByType[doc.doc_type] = (stats.docsByType[doc.doc_type] || 0) + 1;
    stats.docsByLang[doc.language] = (stats.docsByLang[doc.language] || 0) + 1;
    stats.chunksTotal += chunks.length;

    docBatch.push({ doc, chunks });

    if (docBatch.length >= DOC_BATCH) {
      await flushDocBatch();
      log.info(stats, "progress");
    }
  }
  await flushDocBatch();

  log.info("running ANALYZE for planner stats");
  await db.analyze();

  await db.close();

  log.info({ ...stats, ms: Date.now() - startedAt }, "ingest complete");
}

main().catch((err) => {
  log.fatal({ err: err.message, stack: err.stack }, "ingest failed");
  db.close().catch(() => {});
  process.exit(1);
});
