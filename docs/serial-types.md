# `BIGSERIAL` — auto-incrementing integer primary keys in Postgres

**TL;DR.** A Postgres convenience type: `BIGSERIAL` is shorthand for
"create a sequence, use a `BIGINT` column, default to the next sequence
value." We use it for `rag_chunks.id`, `messages.id`,
`conversation_memory.id`, and `favorites.id`. UUID for what's in URLs;
BIGSERIAL for everything else.

## What it is

In a long-form SQL schema, an auto-incrementing integer key looks like:

```sql
CREATE SEQUENCE rag_chunks_id_seq;
CREATE TABLE rag_chunks (
  id BIGINT NOT NULL DEFAULT nextval('rag_chunks_id_seq') PRIMARY KEY,
  ...
);
ALTER SEQUENCE rag_chunks_id_seq OWNED BY rag_chunks.id;
```

That's noisy. Postgres has shortcut "serial" pseudo-types that do all
three steps:

| Type | Backing | Range |
|---|---|---|
| `SMALLSERIAL` | `SMALLINT` | 1 to 32,767 |
| `SERIAL` | `INTEGER` | 1 to ~2.1 billion |
| `BIGSERIAL` | `BIGINT` | 1 to ~9.2 quintillion |

Writing `id BIGSERIAL PRIMARY KEY` is exactly equivalent to the
three-statement form above, just compact.

## Why BIGSERIAL and not SERIAL

`SERIAL` (32-bit integer) maxes out at ~2.1 billion. That sounds like a
lot until you remember:
- A chatty production system burns IDs *fast*. Every row write consumes
  one, even on rollback. Hot tables can use millions of IDs/day.
- Once you hit `INT_MAX`, the next INSERT errors out and you're doing
  emergency migrations under load.
- `BIGINT` ranges up to 9.2 × 10¹⁸ — effectively infinite.

The extra 4 bytes per row are negligible at any scale you'd actually
care about them.

The Postgres community recommendation is: **default to `BIGSERIAL` for
new primary keys**. `SERIAL` is a footgun.

## When NOT to use BIGSERIAL

- **URL-exposed identifiers** (chat session IDs, share links, public
  resource IDs) — see [`uuid.md`](uuid.md). Sequential IDs leak how
  many things you have and let users guess adjacent records.
- **Distributed systems where multiple writers can't coordinate** — a
  central sequence is a chokepoint. Use UUIDs or Snowflake-style IDs.
- **When you need natural ordering by creation time** — `BIGSERIAL` is
  monotonic but you can't tell *when* an ID was created without joining
  a timestamp column. UUIDv7 (time-ordered UUIDs) is the modern
  alternative.

## Where in this codebase

| Table | PK type | Why |
|---|---|---|
| `rag_chunks.id` | `BIGSERIAL` | Internal join target; never in URL |
| `messages.id` | `BIGSERIAL` | Internal; referenced from `conversation_memory.message_id` |
| `conversation_memory.id` | `BIGSERIAL` | Internal |
| `favorites.id` | `BIGSERIAL` | Internal |
| `sessions.session_id` | `UUID` | URL-exposed via `?c=...` |
| `documents.doc_id` | `TEXT` | Deterministic SHA-1-of-URL — see [`sha-256.md`](sha-256.md) |

## Read more

- [Postgres docs — Serial types](https://www.postgresql.org/docs/current/datatype-numeric.html#DATATYPE-SERIAL)
- [Postgres docs — Sequences](https://www.postgresql.org/docs/current/sql-createsequence.html)
- See also: [`uuid.md`](uuid.md), [`idempotency.md`](idempotency.md)
