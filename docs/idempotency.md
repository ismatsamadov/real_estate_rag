# Idempotency

**TL;DR.** An operation is *idempotent* if running it twice produces
the same result as running it once. Critical for retries, ingest
pipelines, and "click the button twice" UX. We use it in three places:
ingest (content-hash skip), favorites (UNIQUE + ON CONFLICT), and the
migration script.

## What it is

Plain English: doing something a second time doesn't break anything.

Concrete examples:

| Operation | Idempotent? |
|---|---|
| `DELETE FROM users WHERE id = 42` | Yes — running twice still results in user 42 being gone |
| `INSERT INTO users (...) VALUES (...)` | **No** — running twice creates two rows |
| `INSERT ... ON CONFLICT DO UPDATE` | Yes — running twice produces the same final state |
| `UPDATE users SET active = false WHERE id = 42` | Yes — already-inactive stays inactive |
| `UPDATE balance SET amount = amount + 100` | **No** — running twice adds 200 |
| `UPDATE balance SET amount = 500` | Yes — running twice still leaves it at 500 |

The pattern is: an idempotent operation describes a **final state**, not
a delta. Set to X (idempotent) rather than add X (not idempotent).

## Where we need it

### 1. Ingest pipeline ([`scripts/ingest.js`](../scripts/ingest.js))

Re-running ingest on an unchanged corpus should be a no-op. Every chunk
carries a SHA-256 of its content. Before embedding, we check:

```js
if (existingHashes.get(`${docId}::${chunkIndex}`) === newHash) {
  // Hash matches — skip the embed call entirely
  stats.skippedUnchanged += 1;
  continue;
}
```

Embedding only the *changed* chunks means a no-op ingest is essentially
free. This matters because:
- Voyage charges per token
- Ingest gets re-run during demos, debugging, and CI
- Without it, every demo costs ~$1 of Voyage spend

### 2. Favorites ([`src/favorites.js`](../src/favorites.js))

Clicking the heart twice on the same listing should result in **one**
saved entry, not two. The schema enforces this:

```sql
CREATE TABLE favorites (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  UNIQUE (user_id, doc_id)  -- ← the key constraint
);
```

The API uses `INSERT ... ON CONFLICT DO UPDATE` so a duplicate POST
returns the existing row, not an error:

```sql
INSERT INTO favorites (user_id, doc_id, note)
VALUES ($1, $2, $3)
ON CONFLICT (user_id, doc_id) DO UPDATE
  SET note = COALESCE(EXCLUDED.note, favorites.note)
RETURNING ...
```

Two heart clicks → same row. No duplicate. UX is forgiving.

### 3. Schema migration ([`scripts/migrate.js`](../scripts/migrate.js))

`ensureSchema()` uses `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` so running migrations against an existing DB is safe.
`scripts/comment-schema.js` similarly uses `COMMENT ON ... IS` which
overwrites existing comments.

The pattern: every migration is **`IF NOT EXISTS`** or **upsert**.
Never raw `CREATE TABLE` that would error if the table exists.

## Why it matters operationally

In a distributed system, retries are inevitable:
- Network timeouts mid-request
- Browser refresh during a click
- CI re-running a deploy script
- A user clicking the same button twice on a slow connection

If your operations aren't idempotent, every retry is a footgun. Make
the API safe by design, not by careful clients.

## Where in this codebase (summary)

- Ingest skip-on-unchanged-hash → [`scripts/ingest.js`](../scripts/ingest.js)
- Favorite save / unsave → [`src/favorites.js`](../src/favorites.js)
- Schema migrations → [`src/db.js`](../src/db.js) `ensureSchema()`
- Comment refresh → [`scripts/comment-schema.js`](../scripts/comment-schema.js)

## Read more

- [HTTP method idempotency (RFC 7231 §4.2.2)](https://datatracker.ietf.org/doc/html/rfc7231#section-4.2.2)
- [Stripe — Idempotency keys API design](https://stripe.com/docs/api/idempotent_requests)
