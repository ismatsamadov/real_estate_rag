"use strict";

const config = require("./config");
const logger = require("./logger");

const log = logger.child({ component: "embedder" });

let extractorPromise = null;

async function getExtractor() {
  if (!extractorPromise) {
    log.info({ model: config.embedding.model }, "loading embedding model");
    // Lazy import: @xenova/transformers is ESM-only.
    extractorPromise = import("@xenova/transformers").then(({ pipeline, env }) => {
      // Stay fully local; no remote model fetches at runtime once cached.
      env.allowLocalModels = true;
      return pipeline("feature-extraction", config.embedding.model);
    });
  }
  return extractorPromise;
}

function meanPool(matrix) {
  if (!Array.isArray(matrix) || !matrix.length) {
    throw new Error("Empty embedding matrix");
  }
  const dim = matrix[0].length;
  const out = new Array(dim).fill(0);
  for (const row of matrix) {
    for (let i = 0; i < dim; i += 1) out[i] += row[i];
  }
  for (let i = 0; i < dim; i += 1) out[i] /= matrix.length;
  return out;
}

function l2Normalize(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i += 1) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum) || 1;
  const out = new Array(vec.length);
  for (let i = 0; i < vec.length; i += 1) out[i] = vec[i] / norm;
  return out;
}

function tensorToVector(tensor) {
  // Xenova outputs a Tensor with .data (Float32Array) + .dims = [batch, tokens, hidden].
  const dims = tensor.dims || tensor.shape;
  if (!dims || dims.length !== 3) {
    throw new Error(`Unexpected embedding tensor shape: ${JSON.stringify(dims)}`);
  }
  const [, tokens, hidden] = dims;
  const data = tensor.data;
  const matrix = new Array(tokens);
  for (let t = 0; t < tokens; t += 1) {
    const row = new Array(hidden);
    const base = t * hidden;
    for (let i = 0; i < hidden; i += 1) row[i] = data[base + i];
    matrix[t] = row;
  }
  const pooled = meanPool(matrix);
  const vec = l2Normalize(pooled);
  if (vec.length !== config.embedding.dim) {
    throw new Error(
      `Embedding dim ${vec.length} does not match VECTOR_DIM=${config.embedding.dim}`
    );
  }
  return vec;
}

async function embed(text) {
  const extractor = await getExtractor();
  const output = await extractor(String(text || ""), {
    pooling: "none",
    normalize: false,
  });
  return tensorToVector(output);
}

async function embedBatch(texts, { batchSize = config.embedding.batchSize } = {}) {
  const extractor = await getExtractor();
  const out = new Array(texts.length);
  for (let start = 0; start < texts.length; start += batchSize) {
    const slice = texts.slice(start, start + batchSize);
    const results = await Promise.all(
      slice.map((t) =>
        extractor(String(t || ""), { pooling: "none", normalize: false }).then(
          tensorToVector
        )
      )
    );
    for (let i = 0; i < results.length; i += 1) out[start + i] = results[i];
  }
  return out;
}

function toVectorLiteral(vector) {
  return `[${vector.join(",")}]`;
}

async function warmup() {
  await embed("warmup");
}

module.exports = {
  embed,
  embedBatch,
  toVectorLiteral,
  warmup,
};
