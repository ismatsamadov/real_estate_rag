"use strict";

const path = require("node:path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const { z } = require("zod");

const numericString = (defaultValue) =>
  z.coerce.number().int().nonnegative().default(defaultValue);

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  PORT: numericString(8787),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  FIRECRAWL_API_KEY: z.string().optional().default(""),

  EMBEDDING_MODEL: z.string().default("Xenova/all-MiniLM-L6-v2"),
  VECTOR_DIM: numericString(384),
  PGVECTOR_TABLE: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "PGVECTOR_TABLE must be a SQL identifier")
    .default("rag_chunks"),

  ANTHROPIC_MODEL: z.string().default("claude-sonnet-4-5"),
  ANTHROPIC_MODEL_CANDIDATES: z
    .string()
    .default("claude-sonnet-4-5,claude-haiku-4-5-20251001"),

  RAG_TOP_K: z.coerce.number().int().min(1).max(50).default(8),
  RAG_CANDIDATE_K: z.coerce.number().int().min(1).max(200).default(24),
  RAG_MAX_TOKENS: z.coerce.number().int().min(64).max(8192).default(900),
  RAG_TEMPERATURE: z.coerce.number().min(0).max(1).default(0),
  RAG_MODE: z.enum(["hybrid", "vector", "lexical"]).default("hybrid"),
  RRF_K: z.coerce.number().int().min(1).max(500).default(60),

  CHUNK_SIZE: z.coerce.number().int().min(200).max(8000).default(1200),
  CHUNK_OVERLAP: z.coerce.number().int().min(0).max(2000).default(180),
  MIN_CHUNK_SIZE: z.coerce.number().int().min(0).max(4000).default(200),
  INGEST_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(32),
  EMBED_BATCH_SIZE: z.coerce.number().int().min(1).max(128).default(16),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(30),

  SITEMAP_URL: z.string().url().default("https://pasharealestate.az/sitemap.xml"),
  SCRAPE_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
  SCRAPE_RETRY_MAX: z.coerce.number().int().min(0).max(10).default(3),
  ALLOW_INSECURE_SITEMAP_TLS: z
    .union([z.literal("0"), z.literal("1")])
    .default("0")
    .transform((v) => v === "1"),

  INPUT_JSONL: z.string().default("data/corpus.jsonl"),
  OUTPUT_JSONL: z.string().default("data/corpus.jsonl"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join(".") || "<env>"}: ${i.message}`)
    .join("\n");
  console.error(`Invalid environment configuration:\n${issues}`);
  process.exit(1);
}

const env = parsed.data;
const repoRoot = path.resolve(__dirname, "..");

const config = Object.freeze({
  env: env.NODE_ENV,
  isProd: env.NODE_ENV === "production",
  logLevel: env.LOG_LEVEL,
  port: env.PORT,

  paths: Object.freeze({
    repoRoot,
    inputJsonl: path.resolve(repoRoot, env.INPUT_JSONL),
    outputJsonl: path.resolve(repoRoot, env.OUTPUT_JSONL),
  }),

  db: Object.freeze({
    url: env.DATABASE_URL,
    table: env.PGVECTOR_TABLE,
  }),

  anthropic: Object.freeze({
    apiKey: env.ANTHROPIC_API_KEY,
    defaultModel: env.ANTHROPIC_MODEL,
    candidateModels: env.ANTHROPIC_MODEL_CANDIDATES.split(",")
      .map((m) => m.trim())
      .filter(Boolean),
    maxTokens: env.RAG_MAX_TOKENS,
    temperature: env.RAG_TEMPERATURE,
  }),

  firecrawl: Object.freeze({
    apiKey: env.FIRECRAWL_API_KEY,
  }),

  embedding: Object.freeze({
    model: env.EMBEDDING_MODEL,
    dim: env.VECTOR_DIM,
    batchSize: env.EMBED_BATCH_SIZE,
  }),

  retrieval: Object.freeze({
    mode: env.RAG_MODE,
    topK: env.RAG_TOP_K,
    candidateK: env.RAG_CANDIDATE_K,
    rrfK: env.RRF_K,
  }),

  ingest: Object.freeze({
    chunkSize: env.CHUNK_SIZE,
    chunkOverlap: env.CHUNK_OVERLAP,
    minChunkSize: env.MIN_CHUNK_SIZE,
    batchSize: env.INGEST_BATCH_SIZE,
  }),

  scrape: Object.freeze({
    sitemapUrl: env.SITEMAP_URL,
    concurrency: env.SCRAPE_CONCURRENCY,
    retryMax: env.SCRAPE_RETRY_MAX,
    allowInsecureTls: env.ALLOW_INSECURE_SITEMAP_TLS,
  }),

  rateLimit: Object.freeze({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX,
  }),
});

module.exports = config;
