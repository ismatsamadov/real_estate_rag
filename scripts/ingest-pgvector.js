const path = require("node:path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const fs = require("node:fs");
const readline = require("node:readline");
const { Pool } = require("pg");
const { pipeline } = require("@xenova/transformers");

const DEFAULT_INPUT_JSONL = fs.existsSync(path.resolve(__dirname, "..", "data", "rag-ready.jsonl"))
  ? path.resolve(__dirname, "..", "data", "rag-ready.jsonl")
  : path.resolve(__dirname, "..", "rag-ready.jsonl");
const INPUT_JSONL = process.env.INPUT_JSONL || DEFAULT_INPUT_JSONL;
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "Xenova/all-MiniLM-L6-v2";
const CHUNK_SIZE = Number(process.env.CHUNK_SIZE || 1200);
const MIN_CHUNK_SIZE = Number(process.env.MIN_CHUNK_SIZE || 200);
const VECTOR_DIM = Number(process.env.VECTOR_DIM || 384);
const TABLE_NAME = process.env.PGVECTOR_TABLE || "rag_chunks";
const BATCH_SIZE = Number(process.env.INGEST_BATCH_SIZE || 25);

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set.");
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitSentences(paragraph) {
  return paragraph
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function chunkText(input, maxChars, minChars) {
  const text = normalizeText(input);
  if (!text) return [];

  const blocks = text
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);

  const chunks = [];
  let current = "";

  const flush = () => {
    const out = current.trim();
    if (out) chunks.push(out);
    current = "";
  };

  const pushUnit = (unit) => {
    if (!unit) return;

    if (unit.length > maxChars) {
      const sentences = splitSentences(unit);
      if (sentences.length > 1) {
        for (const sentence of sentences) pushUnit(sentence);
        return;
      }

      let i = 0;
      while (i < unit.length) {
        const slice = unit.slice(i, i + maxChars).trim();
        if (slice) chunks.push(slice);
        i += maxChars;
      }
      return;
    }

    if (!current) {
      current = unit;
      return;
    }

    const candidate = `${current}\n\n${unit}`;
    if (candidate.length <= maxChars) {
      current = candidate;
      return;
    }

    flush();
    current = unit;
  };

  for (const block of blocks) pushUnit(block);
  flush();

  const merged = [];
  for (const chunk of chunks) {
    if (!merged.length) {
      merged.push(chunk);
      continue;
    }
    if (chunk.length < minChars && merged[merged.length - 1].length + chunk.length + 2 <= maxChars) {
      merged[merged.length - 1] = `${merged[merged.length - 1]}\n\n${chunk}`;
    } else {
      merged.push(chunk);
    }
  }

  return merged;
}

function meanPoolEmbeddings(output) {
  const asNested = typeof output?.tolist === "function" ? output.tolist() : output;
  const tokenEmbeddings = Array.isArray(asNested?.[0]?.[0])
    ? asNested[0]
    : Array.isArray(asNested?.[0])
      ? asNested
      : null;

  if (!Array.isArray(tokenEmbeddings) || tokenEmbeddings.length === 0 || !Array.isArray(tokenEmbeddings[0])) {
    throw new Error("Embedding model returned empty output.");
  }

  const dims = tokenEmbeddings[0].length;
  const sum = new Array(dims).fill(0);

  for (const tokenVector of tokenEmbeddings) {
    for (let i = 0; i < dims; i += 1) {
      sum[i] += tokenVector[i];
    }
  }

  const mean = sum.map((v) => v / tokenEmbeddings.length);
  const norm = Math.sqrt(mean.reduce((acc, v) => acc + v * v, 0)) || 1;
  return mean.map((v) => v / norm);
}

async function createEmbedder() {
  const extractor = await pipeline("feature-extraction", EMBEDDING_MODEL);
  return async (text) => {
    const output = await extractor(text, { pooling: "none", normalize: false });
    const vec = meanPoolEmbeddings(output);
    if (vec.length !== VECTOR_DIM) {
      throw new Error(`Embedding dimension ${vec.length} does not match VECTOR_DIM=${VECTOR_DIM}.`);
    }
    return vec;
  };
}

function toVectorLiteral(vector) {
  return `[${vector.join(",")}]`;
}

async function ensureSchema(pool) {
  const quoted = `"${TABLE_NAME.replace(/"/g, "\"\"")}"`;
  const indexName = `${TABLE_NAME.replace(/[^a-zA-Z0-9_]/g, "_")}_embedding_ivfflat_idx`;
  const quotedIndex = `"${indexName}"`;
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${quoted} (
      id BIGSERIAL PRIMARY KEY,
      doc_id TEXT NOT NULL,
      url TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      embedding vector(${VECTOR_DIM}) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (doc_id, chunk_index)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quotedIndex}
    ON ${quoted}
    USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100)
  `);
}

async function upsertBatch(pool, rows) {
  if (!rows.length) return;
  const quoted = `"${TABLE_NAME.replace(/"/g, "\"\"")}"`;
  const values = [];
  const placeholders = rows
    .map((row, i) => {
      const base = i * 6;
      values.push(row.docId, row.url, row.chunkIndex, row.content, row.metadata, toVectorLiteral(row.embedding));
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::jsonb, $${base + 6}::vector)`;
    })
    .join(", ");

  await pool.query(
    `
      INSERT INTO ${quoted} (doc_id, url, chunk_index, content, metadata, embedding)
      VALUES ${placeholders}
      ON CONFLICT (doc_id, chunk_index)
      DO UPDATE SET
        url = EXCLUDED.url,
        content = EXCLUDED.content,
        metadata = EXCLUDED.metadata,
        embedding = EXCLUDED.embedding
    `,
    values
  );
}

async function ingest() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const embed = await createEmbedder();
  await ensureSchema(pool);

  const fileStream = fs.createReadStream(INPUT_JSONL, { encoding: "utf8" });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let totalDocs = 0;
  let totalChunks = 0;
  let batch = [];

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) continue;

    let doc;
    try {
      doc = JSON.parse(line);
    } catch {
      console.log("SKIP invalid JSONL line");
      continue;
    }

    const sourceText = normalizeText(doc.text);
    if (!sourceText) continue;

    totalDocs += 1;
    const chunks = chunkText(sourceText, CHUNK_SIZE, MIN_CHUNK_SIZE);

    for (let i = 0; i < chunks.length; i += 1) {
      const content = chunks[i];
      const embedding = await embed(content);
      batch.push({
        docId: String(doc.id || doc.url || `${totalDocs}`),
        url: String(doc.url || ""),
        chunkIndex: i,
        content,
        metadata: JSON.stringify(doc.metadata || {}),
        embedding,
      });
      totalChunks += 1;

      if (batch.length >= BATCH_SIZE) {
        await upsertBatch(pool, batch);
        batch = [];
      }
    }
  }

  if (batch.length) {
    await upsertBatch(pool, batch);
  }

  await pool.end();
  console.log(`Done. Ingested ${totalDocs} docs and ${totalChunks} chunks into ${TABLE_NAME}.`);
  console.log("Chunking is context-free: no overlap and no adjacent-context concatenation.");
}

ingest().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
