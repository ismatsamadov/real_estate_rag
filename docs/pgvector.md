# pgvector — vector search inside Postgres

**TL;DR.** A Postgres extension that adds a `vector` column type, the
`<=>` distance operator, and the HNSW/IVFFlat index types. It turns
Postgres into a vector database without giving up SQL, transactions, or
joins to your other tables.

## What it is

Until pgvector existed (open-sourced 2021), running vector search next to
relational data meant either:
- Putting vectors in a separate service (Pinecone, Weaviate, Qdrant) and
  managing two databases in sync, or
- Storing vectors as `BYTEA` blobs in Postgres and computing cosine
  similarity in application code (slow, no index).

pgvector adds:
- A native `vector(N)` column type (`vector(1024)` in our case)
- Distance operators: `<=>` (cosine distance), `<->` (Euclidean),
  `<#>` (inner product)
- Two index types: **IVFFlat** (cluster-based, needs training) and
  **HNSW** (graph-based, no training)
- Compatibility with everything else Postgres does — joins, transactions,
  jsonb filters, FK constraints, ACLs.

## Why we use it

We picked pgvector over Pinecone / Weaviate / Qdrant because:

- **One database = one transaction boundary.** Inserting a chunk +
  metadata + audit row is atomic, not a distributed write.
- **Hybrid retrieval lives in one SQL statement.** Vector kNN + Postgres
  FTS + RRF fusion is one CTE. With a separate vector DB you'd run two
  queries client-side and merge in application code.
- **Metadata filters compose.** `WHERE metadata->>'language' = 'az' AND embedding <=> $1 < 0.3` is one expression, indexed by GIN(jsonb) for
  the filter and HNSW for the vector.
- **Operational simplicity.** One backup, one connection pool, one
  monitoring dashboard.

The migration path when we outgrow it: lift `rag_chunks` into Pinecone,
keep chat state in Postgres. `messages.sources` JSONB decouples chat
history from corpus layout so the migration is painless.

## Where in this codebase

- Extension creation: [`src/db.js`](../src/db.js) — `CREATE EXTENSION IF NOT EXISTS vector`
- Column declaration: `embedding vector(1024) NOT NULL`
- Distance query: [`src/retriever.js`](../src/retriever.js) — `ORDER BY c.embedding <=> $1::vector LIMIT 32`
- Index: [HNSW docs](hnsw.md)

## Read more

- [pgvector — official repo + docs](https://github.com/pgvector/pgvector)
- [Neon — pgvector guide](https://neon.tech/docs/extensions/pgvector)
- [Supabase — vector embeddings with pgvector](https://supabase.com/docs/guides/ai/vector-columns)
