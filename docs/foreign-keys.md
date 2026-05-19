# Foreign keys — `CASCADE`, `SET NULL`, `RESTRICT`

**TL;DR.** A foreign key constraint says "this column must point at a
row in another table." When the parent row is deleted, you have to pick
what happens to the child rows: cascade the delete, null out the
reference, or refuse the delete. We use `CASCADE` for parent-owned data
(messages belong to a session) and `SET NULL` when the child should
survive (memory survives a single-message redaction).

## What it is

```sql
CREATE TABLE messages (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  ...
);
```

Two things going on:

1. **`REFERENCES sessions(session_id)`** — enforces that every
   `messages.session_id` value must exist as a `sessions.session_id`
   somewhere. INSERTs that violate this fail with a foreign-key error.
2. **`ON DELETE CASCADE`** — declares what should happen if a row in
   `sessions` is deleted while messages still reference it. Postgres
   automatically deletes the referencing rows.

## The four referential actions

| Action | What happens on parent delete | When to use |
|---|---|---|
| `RESTRICT` (default) | Delete fails if children exist | Forces explicit cleanup; the safest default. |
| `CASCADE` | Children deleted automatically | When the child is owned by the parent (messages owned by sessions). |
| `SET NULL` | Child's FK column set to NULL | When the child should survive the parent's death. |
| `SET DEFAULT` | Child's FK column set to its default | Rare; mostly useful with a "tombstone" parent row. |

There's also `NO ACTION`, which is identical to `RESTRICT` except the
check is deferred to commit time instead of statement time. Functionally
the same for our use.

## Our cascade matrix

| Delete | What happens to children | Mode | Why |
|---|---|---|---|
| `documents` row | `rag_chunks` for that doc are deleted | `CASCADE` | Chunks are useless without their document; clean up automatically. |
| `documents` row | `favorites.doc_id` rows are deleted | `CASCADE` | Bookmarks of a deleted document point at nothing; don't keep orphans. |
| `sessions` row | All its `messages` are deleted | `CASCADE` | Deleting a chat means deleting the chat. |
| `sessions` row | Its `conversation_memory` rows are deleted | `CASCADE` | "Forget this chat" should actually forget it. |
| `messages` row | Its `conversation_memory` row is **kept**, with `message_id = NULL` | `SET NULL` | A single-message redaction (rare) shouldn't destroy the memory it produced. |

The `SET NULL` case for memory is the one judgment call. The reasoning:
memory's value comes from the (Q, A) text it embedded, not from the
specific message row. If we ever build "delete this message" UX, we
want to break the link without nuking the memory. The memory row would
just lose its `message_id` backreference.

## Why `RESTRICT` would be wrong here

You might think "safer to require explicit cleanup." But:

- Sessions can have hundreds of messages. Deleting them one-by-one
  before deleting the session is tedious and racy.
- The whole **point** of "delete this conversation" is that downstream
  data should also disappear.
- Without CASCADE, a session delete needs three SQL statements in a
  transaction, all in the right order, all hand-coordinated.

`CASCADE` makes this one statement. The constraint **describes** the
dependency; the database **enforces** it.

## Cascade order

When you `DELETE FROM sessions WHERE session_id = X`, Postgres:

1. Finds all rows in `messages` and `conversation_memory` with
   `session_id = X`.
2. Applies their referential actions:
   - `messages` rows get deleted (their `session_id` has `ON DELETE CASCADE`).
   - `conversation_memory` rows ALSO get deleted (same).
3. Now-orphaned `conversation_memory.message_id` references to those
   deleted messages would have been `SET NULL`, but the row itself is
   already being deleted via the session cascade, so the SET NULL
   never fires.
4. Finally the session row itself is deleted.

All inside one transaction. Either everything succeeds or nothing
changes.

## Where in this codebase

[`src/db.js`](../src/db.js), inside `ensureSchema()`:

```sql
-- Chunks owned by documents
rag_chunks.doc_id REFERENCES documents(doc_id) ON DELETE CASCADE

-- Messages owned by sessions
messages.session_id REFERENCES sessions(session_id) ON DELETE CASCADE

-- Memory owned by sessions; survives message redactions
conversation_memory.session_id REFERENCES sessions(session_id) ON DELETE CASCADE
conversation_memory.message_id REFERENCES messages(id) ON DELETE SET NULL

-- Favorites tied to documents
favorites.doc_id REFERENCES documents(doc_id) ON DELETE CASCADE
```

Full cascade matrix in [`database.md`](database.md).

## Read more

- [Postgres docs — Foreign Keys](https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-FK)
- [Postgres docs — Referential actions](https://www.postgresql.org/docs/current/sql-createtable.html#SQL-CREATETABLE-REFERENCES)
