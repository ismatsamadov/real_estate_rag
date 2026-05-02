#!/usr/bin/env node
"use strict";

/**
 * Ingestion pipeline.
 *
 *   JSONL corpus  →  structure-aware chunker  →  batched embeddings
 *                 →  pgvector upserts (idempotent on doc_id, chunk_index)
 *                 →  ANALYZE for the planner.
 *
 * Idempotency: every chunk carries a SHA-256 of its content. On re-run, an
 * unchanged hash skips the (slow) embedding step, so re-ingesting an
 * unchanged corpus is essentially a no-op.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const readline = require("node:readline");

const config = require("../src/config");
const logger = require("../src/logger");
const db = require("../src/db");
const { chunkText, normalize } = require("../src/chunker");
const { embedBatch, toVectorLiteral } = require("../src/embedder");

const log = logger.child({ component: "ingest" });

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

async function existingHashes(client, docIds) {
  if (!docIds.length) return new Map();
  const { rows } = await client.query(
    `SELECT doc_id, chunk_index, content_hash FROM ${db.TABLE} WHERE doc_id = ANY($1::text[])`,
    [docIds]
  );
  const map = new Map();
  for (const row of rows) {
    map.set(`${row.doc_id}::${row.chunk_index}`, row.content_hash);
  }
  return map;
}

async function pruneStaleChunks(client, docId, keepCount) {
  await client.query(
    `DELETE FROM ${db.TABLE} WHERE doc_id = $1 AND chunk_index >= $2`,
    [docId, keepCount]
  );
}

async function upsertBatch(client, rows) {
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
        row.metadata,
        toVectorLiteral(row.embedding)
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}::jsonb, $${base + 7}::vector)`;
    })
    .join(", ");

  await client.query(
    `
      INSERT INTO ${db.TABLE} (doc_id, url, chunk_index, content, content_hash, metadata, embedding)
      VALUES ${placeholders}
      ON CONFLICT (doc_id, chunk_index)
      DO UPDATE SET
        url = EXCLUDED.url,
        content = EXCLUDED.content,
        content_hash = EXCLUDED.content_hash,
        metadata = EXCLUDED.metadata,
        embedding = EXCLUDED.embedding,
        updated_at = NOW()
    `,
    values
  );
}

async function* readJsonl(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  for await (const raw of rl) {
    lineNo += 1;
    const line = raw.trim();
    if (!line) continue;
    try {
      yield { lineNo, doc: JSON.parse(line) };
    } catch (err) {
      log.warn({ lineNo, err: err.message }, "skipping invalid JSONL line");
    }
  }
}

async function main() {
  const inputPath = config.paths.inputJsonl;
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input JSONL not found: ${inputPath}`);
  }

  log.info(
    {
      input: inputPath,
      table: config.db.table,
      chunkSize: config.ingest.chunkSize,
      chunkOverlap: config.ingest.chunkOverlap,
      embeddingModel: config.embedding.model,
    },
    "starting ingest"
  );

  await db.ensureSchema();

  const startedAt = Date.now();
  let totalDocs = 0;
  let totalChunks = 0;
  let embedded = 0;
  let skippedUnchanged = 0;
  let docBatch = [];
  const DOC_BATCH = 8;

  const flushDocBatch = async () => {
    if (!docBatch.length) return;

    await db.withClient(async (client) => {
      const docIds = docBatch.map((d) => d.docId);
      const existing = await existingHashes(client, docIds);

      // Stage all chunks; figure out which need re-embedding.
      const needEmbedding = [];
      const reusableRows = [];
      for (const doc of docBatch) {
        for (let i = 0; i < doc.chunks.length; i += 1) {
          const content = doc.chunks[i];
          const contentHash = sha256(content);
          const key = `${doc.docId}::${i}`;
          if (existing.get(key) === contentHash) {
            skippedUnchanged += 1;
            continue;
          }
          needEmbedding.push({
            docId: doc.docId,
            url: doc.url,
            chunkIndex: i,
            content,
            contentHash,
            metadata: doc.metadata,
          });
        }
      }

      if (needEmbedding.length) {
        const vectors = await embedBatch(
          needEmbedding.map((r) => r.content),
          { batchSize: config.embedding.batchSize }
        );
        for (let i = 0; i < needEmbedding.length; i += 1) {
          needEmbedding[i].embedding = vectors[i];
        }
        embedded += needEmbedding.length;

        // Upsert in DB-batches to keep parameter counts sane.
        for (let i = 0; i < needEmbedding.length; i += config.ingest.batchSize) {
          await upsertBatch(client, needEmbedding.slice(i, i + config.ingest.batchSize));
        }
      }

      // Prune chunks that no longer exist after re-chunking.
      for (const doc of docBatch) {
        await pruneStaleChunks(client, doc.docId, doc.chunks.length);
      }
    });

    docBatch = [];
  };

  for await (const { lineNo, doc } of readJsonl(inputPath)) {
    const text = normalize(doc.text);
    if (!text) {
      log.debug({ lineNo, id: doc.id }, "skip empty doc");
      continue;
    }
    const docId = String(doc.id || doc.url || lineNo);
    const url = String(doc.url || "");
    const metadata = JSON.stringify(doc.metadata || {});
    const chunks = chunkText(text, {
      maxChars: config.ingest.chunkSize,
      overlap: config.ingest.chunkOverlap,
      minChars: config.ingest.minChunkSize,
    });
    if (!chunks.length) continue;

    totalDocs += 1;
    totalChunks += chunks.length;
    docBatch.push({ docId, url, metadata, chunks });

    if (docBatch.length >= DOC_BATCH) {
      await flushDocBatch();
      log.info(
        { docs: totalDocs, chunks: totalChunks, embedded, skippedUnchanged },
        "progress"
      );
    }
  }
  await flushDocBatch();

  log.info("running ANALYZE for planner stats");
  await db.analyze();

  await db.close();

  log.info(
    {
      totalDocs,
      totalChunks,
      embedded,
      skippedUnchanged,
      ms: Date.now() - startedAt,
    },
    "ingest complete"
  );
}

main().catch((err) => {
  log.fatal({ err: err.message, stack: err.stack }, "ingest failed");
  db.close().catch(() => {});
  process.exit(1);
});
