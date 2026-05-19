# Glossary

Every technical term used in [`../README.md`](../README.md) and elsewhere
in the repo has its own short page below. Each page answers: what it is,
why we use it here, the tradeoffs, and where it shows up in the codebase.
External sources are linked at the bottom of every page.

## Retrieval

- [**RAG** — Retrieval-Augmented Generation](rag.md)
- [**Hybrid retrieval** — vector + lexical fused with RRF](hybrid-retrieval.md)
- [**Asymmetric retrieval** — query vs document embeddings](asymmetric-retrieval.md)
- [**ANN vs kNN** — approximate vs exact nearest neighbor](ann-vs-knn.md)

## Vector search

- [**pgvector** — Postgres vector extension](pgvector.md)
- [**HNSW** — Hierarchical Navigable Small World index](hnsw.md)
- [**MTEB** — Massive Text Embedding Benchmark](mteb.md)
- [**Cross-encoder rerank** — second-stage scoring](cross-encoder-rerank.md)

## Lexical search

- [**BM25 + tsvector + FTS** — Postgres full-text search](tsvector-fts.md)
- [**GIN** — Generalized Inverted Index](gin-index.md)

## Fusion

- [**RRF** — Reciprocal Rank Fusion (Cormack et al. 2009)](rrf.md)

## Generation

- [**Prompt caching** — Anthropic `cache_control: ephemeral`](prompt-caching.md)
- [**SSE** — Server-Sent Events streaming](sse-streaming.md)

## Evaluation

- [**LLM-as-judge** — using a model to score model outputs](llm-as-judge.md)

## Storage & caching

- [**JSONB** — Postgres binary JSON type](jsonb.md)
- [**CTE** — Common Table Expression (one SQL statement, multiple steps)](cte.md)
- [**LRU cache** — Least Recently Used eviction policy](lru-cache.md)
- [**TTL** — Time To Live (cache and cookie expiration)](ttl.md)

## Postgres types & primitives

- [**UUID** — Universally Unique Identifier (session_id primary keys)](uuid.md)
- [**BIGSERIAL & serial types** — auto-incrementing integer primary keys](serial-types.md)
- [**ANALYZE** — refreshing the query planner's statistics](analyze.md)
- [**Foreign keys — CASCADE, SET NULL, RESTRICT**](foreign-keys.md)

## Auth & security

- [**Cookie security** — httpOnly, sameSite, secure](cookie-security.md)
- [**SHA-256** — content hashing for idempotent ingest](sha-256.md)

## Personalization

- [**User-intent profile** — LLM-synthesized standing summary, refreshed lazily](user-profile.md)
- [**Personalization in LLM apps** — overall stack and what we deliberately skip](personalization.md)

## Operational

- [**Idempotency** — what it means in our ingest + favorites code](idempotency.md)
- [**Instrumentation hook** — Next.js `register()` for self-bootstrapping schema](instrumentation.md)
- [**Dynamic `import()`** — runtime-conditional bundling so `pg` stays out of the Edge bundle](dynamic-import.md)

---

If a term in the README doesn't have a link, it's either common knowledge
or covered inline. Everything in the table above has been verified against
primary sources (papers, official docs, benchmarks) as of 2026; nothing is
fabricated.
