const path = require("node:path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const { Pool } = require("pg");
const Anthropic = require("@anthropic-ai/sdk");
const { pipeline } = require("@xenova/transformers");

const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "Xenova/all-MiniLM-L6-v2";
const VECTOR_DIM = Number(process.env.VECTOR_DIM || 384);
const TABLE_NAME = process.env.PGVECTOR_TABLE || "rag_chunks";
const DEFAULT_TOP_K = Number(process.env.RAG_TOP_K || 8);
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";
const MAX_ANSWER_TOKENS = Number(process.env.RAG_MAX_TOKENS || 900);

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set.");
if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set.");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
let embedderPromise = null;
let fallbackModelsPromise = null;

function toVectorLiteral(vector) {
  return `[${vector.join(",")}]`;
}

function shortSnippet(text, maxLen = 240) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return clean.length <= maxLen ? clean : `${clean.slice(0, maxLen)}...`;
}

function parseMetadata(raw) {
  if (!raw) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function pickFirst(...values) {
  for (const value of values) {
    const v = String(value || "").trim();
    if (v) return v;
  }
  return "";
}

function pageKindFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const first = pathname.split("/").filter(Boolean)[0] || "";
    return first || "homepage";
  } catch {
    return "unknown";
  }
}

function normalizeMetadata(raw, fallbackUrl) {
  const meta = parseMetadata(raw);
  const sourceUrl = pickFirst(meta.sourceURL, meta.url, fallbackUrl);
  const title = pickFirst(meta.title, meta.ogTitle, meta["og:title"], meta["twitter:title"]);
  const description = pickFirst(
    meta.description,
    meta.ogDescription,
    meta["og:description"],
    meta["twitter:description"]
  );
  const language = pickFirst(meta.language, meta.lang).toLowerCase();
  const contentType = pickFirst(meta.contentType);
  const pageKind = pageKindFromUrl(sourceUrl);

  return {
    title,
    description,
    language,
    contentType,
    pageKind,
    statusCode: Number(meta.statusCode) || null,
    scrapeId: pickFirst(meta.scrapeId),
    sourceURL: sourceUrl,
  };
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
    for (let i = 0; i < dims; i += 1) sum[i] += tokenVector[i];
  }

  const mean = sum.map((v) => v / tokenEmbeddings.length);
  const norm = Math.sqrt(mean.reduce((acc, v) => acc + v * v, 0)) || 1;
  return mean.map((v) => v / norm);
}

async function getEmbedder() {
  if (!embedderPromise) {
    embedderPromise = pipeline("feature-extraction", EMBEDDING_MODEL);
  }
  const extractor = await embedderPromise;

  return async (text) => {
    const output = await extractor(text, { pooling: "none", normalize: false });
    const vec = meanPoolEmbeddings(output);
    if (vec.length !== VECTOR_DIM) {
      throw new Error(`Embedding dimension ${vec.length} does not match VECTOR_DIM=${VECTOR_DIM}.`);
    }
    return vec;
  };
}

async function retrieve(queryEmbedding, topK) {
  const quoted = `"${TABLE_NAME.replace(/"/g, "\"\"")}"`;
  const sql = `
    SELECT
      doc_id,
      url,
      chunk_index,
      content,
      metadata,
      1 - (embedding <=> $1::vector) AS score
    FROM ${quoted}
    ORDER BY embedding <=> $1::vector
    LIMIT $2
  `;
  const result = await pool.query(sql, [toVectorLiteral(queryEmbedding), topK]);
  return result.rows;
}

function buildPrompt(question, rows) {
  const sources = rows.map((row, i) => {
    const sid = `S${i + 1}`;
    const metadata = normalizeMetadata(row.metadata, row.url);
    return {
      sid,
      doc_id: row.doc_id,
      url: metadata.sourceURL || row.url,
      chunk_index: row.chunk_index,
      score: Number(row.score),
      content: row.content,
      snippet: shortSnippet(row.content),
      metadata,
    };
  });

  const sourceBlock = sources
    .map(
      (s) =>
        `[${s.sid}] url=${s.url} title=${s.metadata.title || "n/a"} page_kind=${s.metadata.pageKind} doc_id=${s.doc_id} chunk_index=${s.chunk_index} score=${s.score.toFixed(4)}\n${s.content}`
    )
    .join("\n\n---\n\n");

  const userPrompt = [
    "Answer the question using only the provided sources.",
    "Rules:",
    "1) Every factual claim must include citation IDs like [S1] or [S2][S3].",
    "2) If the sources are insufficient, say exactly what is missing.",
    "3) Do not use outside knowledge.",
    "",
    `Question: ${question}`,
    "",
    "Sources:",
    sourceBlock,
  ].join("\n");

  return { userPrompt, sources };
}

function isModelNotFound(err) {
  return err?.status === 404 || err?.error?.type === "not_found_error";
}

async function getFallbackModels() {
  if (!fallbackModelsPromise) {
    fallbackModelsPromise = (async () => {
      const configured = process.env.ANTHROPIC_MODEL_CANDIDATES
        ? process.env.ANTHROPIC_MODEL_CANDIDATES.split(",").map((m) => m.trim()).filter(Boolean)
        : [];
      const localDefaults = [
        "claude-sonnet-4-20250514",
        "claude-3-7-sonnet-20250219",
        "claude-3-5-sonnet-20241022",
      ];

      let listed = [];
      try {
        const modelsResponse = await anthropic.models.list();
        const ids = Array.isArray(modelsResponse?.data)
          ? modelsResponse.data.map((m) => m.id).filter(Boolean)
          : [];
        listed = ids.filter((id) => id.includes("sonnet"));
      } catch {
        listed = [];
      }

      return [...new Set([ANTHROPIC_MODEL, ...configured, ...listed, ...localDefaults])];
    })();
  }
  return fallbackModelsPromise;
}

async function createAnthropicAnswer(userPrompt) {
  const candidates = await getFallbackModels();
  let lastError = null;

  for (const model of candidates) {
    try {
      const response = await anthropic.messages.create({
        model,
        max_tokens: MAX_ANSWER_TOKENS,
        temperature: 0,
        messages: [{ role: "user", content: userPrompt }],
      });

      const answer = response.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim();

      return { answer: answer || "(No text returned)", model };
    } catch (err) {
      lastError = err;
      if (!isModelNotFound(err)) {
        throw err;
      }
    }
  }

  throw lastError || new Error("No available Anthropic model found.");
}

async function askQuestion(question, options = {}) {
  const q = String(question || "").trim();
  if (!q) throw new Error("Question is empty.");

  const topK = Math.min(20, Math.max(1, Number(options.topK || DEFAULT_TOP_K)));
  const embed = await getEmbedder();
  const queryEmbedding = await embed(q);
  const rows = await retrieve(queryEmbedding, topK);

  if (!rows.length) {
    return {
      answer: "I could not find relevant chunks in the vector store for this question.",
      sources: [],
      topK,
      model: ANTHROPIC_MODEL,
    };
  }

  const { userPrompt, sources } = buildPrompt(q, rows);
  const completion = await createAnthropicAnswer(userPrompt);

  return {
    answer: completion.answer,
    sources,
    topK,
    model: completion.model,
  };
}

async function close() {
  await pool.end();
}

module.exports = {
  askQuestion,
  close,
};
