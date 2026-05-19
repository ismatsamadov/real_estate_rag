"use strict";

/**
 * Voyage AI embedder.
 *
 *   - Asymmetric retrieval: `embed(text, "query")` for queries,
 *     `embedBatch(docs, "document")` for ingest. Voyage's models are trained
 *     with this asymmetry and quality drops measurably if you use the same
 *     input_type for both.
 *   - Batch size is capped at Voyage's documented per-request limit (128
 *     for v4 models, 120K total tokens per request).
 *   - Retries with exponential backoff on 429 / 5xx.
 *   - Returns plain Float32-equivalent JS arrays so the rest of the pipeline
 *     stays SDK-agnostic.
 */

const { VoyageAIClient } = require("voyageai");
const config = require("./config");
const logger = require("./logger");

const log = logger.child({ component: "embedder" });

const MAX_BATCH = 128;
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 524]);
// Generous retry budget at startup so free-tier 3-RPM accounts can wait
// through the 60s window for their next slot.
const MAX_ATTEMPTS = 8;
const MAX_BACKOFF_MS = 60_000;

let clientInstance = null;
function client() {
  if (!clientInstance) {
    clientInstance = new VoyageAIClient({ apiKey: config.voyage.apiKey });
  }
  return clientInstance;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ----- Request throttle -----------------------------------------------------
// When VOYAGE_RPM > 0 we serialize Voyage requests and enforce a minimum
// gap of (60_000 / rpm) ms between them. Lets free-tier accounts (3 RPM)
// ingest reliably without hitting 429s.
let _gate = Promise.resolve();
async function throttleGate() {
  if (!config.voyage.rpm) return;
  const minIntervalMs = Math.ceil(60_000 / config.voyage.rpm);
  const prev = _gate;
  let release;
  _gate = new Promise((r) => {
    release = r;
  });
  await prev;
  const start = Date.now();
  // Release the gate after the interval elapses, regardless of when the
  // actual API call finishes — slow calls don't double-penalize the queue.
  setTimeout(() => release(), minIntervalMs);
  return start;
}

async function callWithRetry(fn, what, maxAttempts = MAX_ATTEMPTS) {
  let attempt = 0;
  while (true) {
    attempt += 1;
    await throttleGate();
    try {
      return await fn();
    } catch (err) {
      const status = err?.statusCode ?? err?.status ?? err?.response?.status;
      const retryable = !status || RETRYABLE.has(status);
      if (!retryable || attempt >= maxAttempts) {
        log.error({ err: err.message, status, attempt, what }, "voyage call failed");
        throw err;
      }
      // 429 from Voyage's free-tier gate: their docs say "after several
      // minutes" for limits to lift. Use longer backoff for 429 than for 5xx.
      const isRateLimit = status === 429;
      const base = isRateLimit ? 5_000 : 500;
      const backoff = Math.min(MAX_BACKOFF_MS, base * 2 ** attempt + Math.random() * 250);
      log.warn({ err: err.message, status, attempt, backoff, what }, "voyage retrying");
      await sleep(backoff);
    }
  }
}

function validateDim(vec) {
  if (vec.length !== config.embedding.dim) {
    throw new Error(
      `Voyage returned ${vec.length}-d vector but VECTOR_DIM=${config.embedding.dim}`,
    );
  }
  return vec;
}

/**
 * Embed a single text. `inputType` is "query" for question embeddings or
 * "document" for ingested chunks. Defaults to "query" since this entry
 * point is mostly used at retrieval time.
 */
async function embed(text, inputType = "query") {
  const input = String(text || "").trim() || " ";
  const res = await callWithRetry(
    () =>
      client().embed({
        input,
        model: config.voyage.embedModel,
        inputType,
      }),
    `embed(${inputType})`,
  );
  const vec = res?.data?.[0]?.embedding;
  if (!Array.isArray(vec)) {
    throw new Error("Voyage embed returned no vector");
  }
  return validateDim(vec);
}

/**
 * Embed many texts. We chunk into MAX_BATCH-sized requests; Voyage handles
 * up to 128 inputs per call but also has a token cap so very long docs may
 * need smaller batches in practice.
 */
async function embedBatch(texts, { inputType = "document", batchSize } = {}) {
  const bs = Math.min(batchSize ?? config.embedding.batchSize ?? MAX_BATCH, MAX_BATCH);
  const out = new Array(texts.length);

  for (let start = 0; start < texts.length; start += bs) {
    const slice = texts.slice(start, start + bs).map((t) => String(t || "").trim() || " ");
    const res = await callWithRetry(
      () =>
        client().embed({
          input: slice,
          model: config.voyage.embedModel,
          inputType,
        }),
      `embedBatch[${start}/${texts.length}]`,
    );
    const data = res?.data || [];
    if (data.length !== slice.length) {
      throw new Error(
        `Voyage returned ${data.length} embeddings for ${slice.length} inputs`,
      );
    }
    for (let i = 0; i < data.length; i += 1) {
      out[start + i] = validateDim(data[i].embedding);
    }
    log.debug(
      {
        from: start,
        to: start + slice.length,
        total: texts.length,
        usage: res.usage,
      },
      "embed batch",
    );
  }
  return out;
}

function toVectorLiteral(vector) {
  return `[${vector.join(",")}]`;
}

async function warmup() {
  await embed("warmup", "query");
}

/**
 * Rerank `documents` against `query` using Voyage's cross-encoder.
 * Returns an array of { index, relevance_score } sorted by score desc.
 * `topK` lets the API short-circuit transfer of low-ranked items.
 */
async function rerank({ query, documents, topK, model } = {}) {
  if (!Array.isArray(documents) || documents.length === 0) return [];
  const safeQuery = String(query || "").trim() || " ";
  const res = await callWithRetry(
    () =>
      client().rerank({
        query: safeQuery,
        documents: documents.map((d) => String(d || "").trim() || " "),
        model: model || config.voyage.rerankModel,
        topK: topK ?? documents.length,
        returnDocuments: false,
      }),
    `rerank(${documents.length})`,
  );
  const data = res?.data || [];
  return data
    .map((r) => ({
      index: r.index,
      score: Number(r.relevanceScore ?? r.relevance_score ?? 0),
    }))
    .sort((a, b) => b.score - a.score);
}

module.exports = {
  embed,
  embedBatch,
  rerank,
  toVectorLiteral,
  warmup,
};
