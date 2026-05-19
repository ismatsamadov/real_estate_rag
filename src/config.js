"use strict";

const path = require("node:path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const { z } = require("zod");

const numericString = (defaultValue) =>
  z.coerce.number().int().nonnegative().default(defaultValue);

const boolString = (defaultValue) =>
  z
    .union([z.literal("true"), z.literal("false"), z.literal("1"), z.literal("0")])
    .default(defaultValue ? "true" : "false")
    .transform((v) => v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  PORT: numericString(8787),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  // Accept either VOYAGE_API_KEY (per Voyage's docs) or VOYAGE_AI_API_KEY.
  VOYAGE_API_KEY: z.string().optional().default(""),
  VOYAGE_AI_API_KEY: z.string().optional().default(""),
  FIRECRAWL_API_KEY: z.string().optional().default(""),

  // Embeddings
  VOYAGE_EMBED_MODEL: z.string().default("voyage-4-large"),
  VOYAGE_RERANK_MODEL: z.string().default("rerank-2.5"),
  VECTOR_DIM: numericString(1024),
  EMBED_BATCH_SIZE: z.coerce.number().int().min(1).max(128).default(32),
  // Throttle for accounts without a payment method on file (Voyage gates
  // free-tier traffic at 3 RPM / 10K TPM). Set to e.g. 3 to enforce
  // ≥ 20s gap between requests. 0 disables the throttle.
  VOYAGE_RPM: z.coerce.number().int().min(0).max(10000).default(0),

  PGVECTOR_TABLE: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "PGVECTOR_TABLE must be a SQL identifier")
    .default("rag_chunks"),

  // Generation
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-4-6"),
  ANTHROPIC_MODEL_CANDIDATES: z
    .string()
    .default("claude-sonnet-4-6,claude-haiku-4-5-20251001"),

  // Retrieval
  RAG_TOP_K: z.coerce.number().int().min(1).max(50).default(8),
  RAG_CANDIDATE_K: z.coerce.number().int().min(1).max(200).default(32),
  RAG_MAX_TOKENS: z.coerce.number().int().min(64).max(8192).default(900),
  RAG_TEMPERATURE: z.coerce.number().min(0).max(1).default(0),
  RAG_MODE: z.enum(["hybrid", "vector", "lexical"]).default("hybrid"),
  RRF_K: z.coerce.number().int().min(1).max(500).default(60),
  RAG_RERANK: boolString(true),
  RAG_CACHE_TTL_MS: z.coerce.number().int().min(0).default(300_000),
  RAG_CACHE_MAX: z.coerce.number().int().min(0).default(500),

  // Ingestion
  CHUNK_SIZE: z.coerce.number().int().min(200).max(8000).default(1200),
  CHUNK_OVERLAP: z.coerce.number().int().min(0).max(2000).default(180),
  MIN_CHUNK_SIZE: z.coerce.number().int().min(0).max(4000).default(200),
  INGEST_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(32),

  // Rate limiting + CORS
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(30),
  ALLOWED_ORIGINS: z.string().default(""),

  // Scraping
  SITEMAP_URL: z.string().url().default("https://pasharealestate.az/sitemap.xml"),
  SCRAPE_BASE_URL: z.string().url().default("https://pasharealestate.az"),
  SCRAPE_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
  SCRAPE_RETRY_MAX: z.coerce.number().int().min(0).max(10).default(3),
  SCRAPE_MAX_PAGES: z.coerce.number().int().min(1).max(50_000).default(2000),
  SCRAPE_LANGUAGES: z.string().default("en,az,ru"),
  SCRAPE_USE_PLAYWRIGHT: boolString(true),
  ALLOW_INSECURE_SITEMAP_TLS: boolString(false),

  // Paths
  INPUT_JSONL: z.string().default("data/corpus.jsonl"),
  OUTPUT_JSONL: z.string().default("data/corpus.jsonl"),

  // Observability
  AXIOM_DATASET: z.string().optional().default(""),
  AXIOM_TOKEN: z.string().optional().default(""),
  OTEL_SERVICE_NAME: z.string().default("real-estate-rag"),
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

const voyageKey = env.VOYAGE_API_KEY || env.VOYAGE_AI_API_KEY;
if (!voyageKey) {
  console.error(
    "Invalid environment configuration:\n  - VOYAGE_API_KEY (or VOYAGE_AI_API_KEY) is required",
  );
  process.exit(1);
}
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

  voyage: Object.freeze({
    apiKey: voyageKey,
    embedModel: env.VOYAGE_EMBED_MODEL,
    rerankModel: env.VOYAGE_RERANK_MODEL,
    rpm: env.VOYAGE_RPM,
  }),

  firecrawl: Object.freeze({
    apiKey: env.FIRECRAWL_API_KEY,
  }),

  embedding: Object.freeze({
    model: env.VOYAGE_EMBED_MODEL,
    dim: env.VECTOR_DIM,
    batchSize: env.EMBED_BATCH_SIZE,
  }),

  retrieval: Object.freeze({
    mode: env.RAG_MODE,
    topK: env.RAG_TOP_K,
    candidateK: env.RAG_CANDIDATE_K,
    rrfK: env.RRF_K,
    rerank: env.RAG_RERANK,
    cacheTtlMs: env.RAG_CACHE_TTL_MS,
    cacheMax: env.RAG_CACHE_MAX,
  }),

  ingest: Object.freeze({
    chunkSize: env.CHUNK_SIZE,
    chunkOverlap: env.CHUNK_OVERLAP,
    minChunkSize: env.MIN_CHUNK_SIZE,
    batchSize: env.INGEST_BATCH_SIZE,
  }),

  scrape: Object.freeze({
    sitemapUrl: env.SITEMAP_URL,
    baseUrl: env.SCRAPE_BASE_URL,
    concurrency: env.SCRAPE_CONCURRENCY,
    retryMax: env.SCRAPE_RETRY_MAX,
    maxPages: env.SCRAPE_MAX_PAGES,
    languages: env.SCRAPE_LANGUAGES.split(",")
      .map((l) => l.trim().toLowerCase())
      .filter(Boolean),
    usePlaywright: env.SCRAPE_USE_PLAYWRIGHT,
    allowInsecureTls: env.ALLOW_INSECURE_SITEMAP_TLS,
  }),

  rateLimit: Object.freeze({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX,
  }),

  cors: Object.freeze({
    origins: env.ALLOWED_ORIGINS.split(",")
      .map((o) => o.trim())
      .filter(Boolean),
  }),

  observability: Object.freeze({
    axiomDataset: env.AXIOM_DATASET,
    axiomToken: env.AXIOM_TOKEN,
    serviceName: env.OTEL_SERVICE_NAME,
    enabled: Boolean(env.AXIOM_DATASET && env.AXIOM_TOKEN),
  }),
});

module.exports = config;
