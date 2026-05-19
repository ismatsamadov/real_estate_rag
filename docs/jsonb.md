# JSONB — Postgres binary JSON

**TL;DR.** A Postgres column type that stores JSON as parsed, indexed
binary. Faster to query than `json` (text), supports operators like `->`,
`->>`, `@>`, and pairs with GIN indexes for fast filtered search. We use
it for chunk metadata, message metadata, source snapshots, and memory
metadata.

## What it is

Postgres has two JSON column types:

| Type | Storage | Speed | Index support |
|---|---|---|---|
| `json` | Raw text | Slow to query (re-parses every access) | Limited |
| `jsonb` | Parsed binary tree | Fast queries, slower writes | Full GIN support |

`jsonb` is almost always what you want. It parses the JSON once on
INSERT and stores the result as a sorted binary structure. Queries don't
re-parse; they just walk the binary tree.

## Operators we use

```sql
-- Extract a value (returns jsonb)
metadata -> 'bedrooms'           -- {"bedrooms": 2}  →  2 (as jsonb)

-- Extract as text
metadata ->> 'bedrooms'          -- {"bedrooms": 2}  →  '2' (as text)

-- Path containment
metadata @> '{"language": "az"}'  -- true if metadata contains that subtree

-- Key exists
metadata ? 'price'                -- true if "price" is a top-level key
```

The `@>` containment operator is the workhorse for filtered retrieval —
*"give me chunks whose metadata contains bedrooms=2 AND
language=en"* is one expression:

```sql
WHERE metadata @> '{"bedrooms": 2, "language": "en"}'
```

## Indexing strategy

JSONB columns can be indexed two ways with GIN:

```sql
-- Default: indexes every key + value
CREATE INDEX ... USING gin (metadata);

-- jsonb_path_ops: indexes only paths (smaller, faster, supports only @>)
CREATE INDEX ... USING gin (metadata jsonb_path_ops);
```

We use `jsonb_path_ops` because all our queries are `@>` containment.
It produces ~30–40% smaller indexes and faster query plans for our
exact use case.

## Where JSONB lives in our schema

| Table.Column | Contents | Why JSONB |
|---|---|---|
| `documents.metadata` | Doc-level extracted facts (price, location, language) | Schemaless — different doc types have different fields |
| `rag_chunks.metadata` | Chunk-level facts (inherits doc-level) | Same as above; indexed for filter-at-retrieval |
| `messages.sources` | Frozen snapshot of cited chunks for an assistant turn | Needs to outlive corpus re-ingest; would be brittle as an FK |
| `messages.metadata` | Model id, usage (tokens, cache hits), retrieval mode | Schema evolves as we add fields (cache hits, fallback mode, etc.) |
| `conversation_memory.metadata` | Q/A previews | Same reasoning |

## When NOT to use JSONB

When the fields are stable and queried often, **promote them to typed
columns**. We did this with `doc_type`, `language`, and `title` —
these are queried so often that having them as proper TEXT columns
with their own indexes beats a JSONB lookup.

The rule of thumb: JSONB for the "long tail" of schemaless or
evolving fields; typed columns for the dozen fields you actually filter
on most.

## Where in this codebase

- Schema: [`src/db.js`](../src/db.js), `ensureSchema()`
- Indexes: see [`gin-index.md`](gin-index.md)
- Comments: applied via [`scripts/comment-schema.js`](../scripts/comment-schema.js); see
  [`database.md`](database.md)

## Read more

- [Postgres docs — JSON Types](https://www.postgresql.org/docs/current/datatype-json.html)
- [Postgres docs — JSONB indexing strategies](https://www.postgresql.org/docs/current/datatype-json.html#JSON-INDEXING)
