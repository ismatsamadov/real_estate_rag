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
});

pool.on("error", (err) => {
  log.error({ err }, "Idle Postgres client error");
});

function quoteIdent(name) {
  return `"${name.replace(/"/g, '""')}"`;
}

const TABLE = quoteIdent(config.db.table);
const HNSW_INDEX = quoteIdent(`${config.db.table}_embedding_hnsw_idx`);
const TSV_INDEX = quoteIdent(`${config.db.table}_tsv_gin_idx`);
const DOC_INDEX = quoteIdent(`${config.db.table}_doc_id_idx`);

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
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id BIGSERIAL PRIMARY KEY,
        doc_id TEXT NOT NULL,
        url TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        embedding vector(${config.embedding.dim}) NOT NULL,
        tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (doc_id, chunk_index)
      )
    `);

    // HNSW for high-quality ANN, no training step required.
    await client.query(`
      CREATE INDEX IF NOT EXISTS ${HNSW_INDEX}
      ON ${TABLE}
      USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64)
    `);

    // GIN over the generated tsvector for lexical retrieval.
    await client.query(`
      CREATE INDEX IF NOT EXISTS ${TSV_INDEX}
      ON ${TABLE}
      USING gin (tsv)
    `);

    // Lookup index for doc-level operations (delete by doc, count, etc.).
    await client.query(`
      CREATE INDEX IF NOT EXISTS ${DOC_INDEX}
      ON ${TABLE} (doc_id)
    `);
  });
  log.info({ table: config.db.table, dim: config.embedding.dim }, "schema ready");
}

async function analyze() {
  await pool.query(`ANALYZE ${TABLE}`);
}

async function pingPing() {
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
  analyze,
  ping: pingPing,
  close,
  TABLE,
  quoteIdent,
};
