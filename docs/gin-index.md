# GIN — Generalized Inverted Index

**TL;DR.** A Postgres index type built for columns that contain
*multiple values per row* — arrays, jsonb objects, tsvectors. We use it
twice: once on the `tsv` full-text column (so lexical search is fast)
and once on `metadata` jsonb (so structured filters are fast).

## What it is

A regular B-tree index has one entry per row. Great for `WHERE id = 42`,
useless for `WHERE 42 = ANY(tags)` where `tags` is an array.

GIN inverts the relationship: each *value* (each word in a document,
each key in a jsonb object, each element of an array) maps to a list of
rows that contain it. Looking up `WHERE tags && ARRAY[42]` reads one
posting list, not the whole table.

"Generalized" because the same index machinery handles any data type as
long as you provide:
- An "extractor" function (turn one column value into many indexable items)
- An equality function

Postgres ships with extractors for `tsvector`, `jsonb`, arrays, and
`pg_trgm` (trigram fuzzy matching).

## Why we use it

Two columns benefit:

### 1. `rag_chunks.tsv` — full-text search

```sql
CREATE INDEX rag_chunks_tsv_gin_idx ON rag_chunks USING gin (tsv);
```

The `tsv` column is a `tsvector` (a list of lexemes — tokenized,
lowercased text). GIN indexes each lexeme → list of rows containing it.
A query like `WHERE tsv @@ plainto_tsquery('simple', 'crescent')`
becomes a posting-list lookup, not a table scan.

### 2. `rag_chunks.metadata` — jsonb filters

```sql
CREATE INDEX rag_chunks_metadata_gin_idx
  ON rag_chunks USING gin (metadata jsonb_path_ops);
```

The `metadata` column carries doc-level facts like
`{"bedrooms": 2, "price": 840000, "currency": "USD"}`. GIN with
`jsonb_path_ops` indexes the *paths* through the jsonb tree, so
`WHERE metadata @> '{"bedrooms": 2}'` is an indexed lookup.

The `jsonb_path_ops` variant produces smaller indexes than the default
`jsonb_ops`, at the cost of supporting fewer operators (no top-level
key existence checks). For our usage — only `@>` containment queries —
`jsonb_path_ops` is the better choice.

## Tradeoffs vs B-tree

- **Slower writes.** Each insert updates many posting lists, not just
  one tree entry. For our ingest workload (write-once) this doesn't
  matter.
- **Bigger on disk.** Posting lists take more space than B-tree entries.
- **Faster reads** for multi-value columns. That's the whole point.

## Where in this codebase

[`src/db.js`](../src/db.js) — three GIN indexes:

```js
// FTS over chunk content
CREATE INDEX ... ON rag_chunks USING gin (tsv);
// Structured filters on chunk metadata
CREATE INDEX ... ON rag_chunks USING gin (metadata jsonb_path_ops);
// Same on documents
CREATE INDEX ... ON documents USING gin (metadata jsonb_path_ops);
```

## Read more

- [Postgres docs — GIN indexes](https://www.postgresql.org/docs/current/gin.html)
- [Postgres docs — jsonb indexing strategies](https://www.postgresql.org/docs/current/datatype-json.html#JSON-INDEXING)
