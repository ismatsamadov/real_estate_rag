# CTE — Common Table Expression

**TL;DR.** SQL's named temporary subqueries — `WITH foo AS (...) SELECT ... FROM foo`.
Lets you build complex multi-step queries as a sequence of named steps
in one statement instead of nesting subqueries or making multiple round
trips. Our hybrid retrieval runs as a single CTE.

## What it is

Without CTEs, a multi-step query in plain SQL gets ugly fast:

```sql
SELECT *
FROM rag_chunks c
JOIN (
  SELECT id, SUM(weight) AS rrf_score FROM (
    SELECT id, 1.0 / (60 + rnk) AS weight FROM (
      SELECT id, ROW_NUMBER() OVER (...) AS rnk
      FROM rag_chunks ORDER BY embedding <=> ... LIMIT 32
    ) vector_hits
    UNION ALL
    -- another nested subquery for lexical_hits
  ) r GROUP BY id
) f ON f.id = c.id
ORDER BY f.rrf_score DESC LIMIT 8;
```

Three levels of nesting, hard to read, hard to debug.

With CTEs the same logic reads top-to-bottom like a script:

```sql
WITH params AS (
  SELECT $1::vector AS qv, plainto_tsquery('simple', $2) AS qt, $3 AS k
),
vector_hits AS (
  SELECT c.id, ROW_NUMBER() OVER (ORDER BY c.embedding <=> p.qv) AS rnk
  FROM rag_chunks c, params p
  ORDER BY c.embedding <=> p.qv
  LIMIT (SELECT k FROM params)
),
lexical_hits AS (
  SELECT c.id, ROW_NUMBER() OVER (ORDER BY ts_rank_cd(c.tsv, p.qt) DESC) AS rnk
  FROM rag_chunks c, params p
  WHERE c.tsv @@ p.qt
  ORDER BY ts_rank_cd(c.tsv, p.qt) DESC
  LIMIT (SELECT k FROM params)
),
fused AS (
  SELECT id, SUM(1.0 / (60 + rnk)) AS rrf_score
  FROM (SELECT * FROM vector_hits UNION ALL SELECT * FROM lexical_hits) r
  GROUP BY id
)
SELECT c.*, f.rrf_score
FROM fused f JOIN rag_chunks c ON c.id = f.id
ORDER BY f.rrf_score DESC LIMIT 8;
```

Each named CTE (`params`, `vector_hits`, `lexical_hits`, `fused`) is a
named temporary result the next CTE can reference. The final `SELECT`
joins everything together.

## Why we do retrieval as one CTE instead of multiple queries

Two reasons:

1. **One round-trip to the database.** The application sends one SQL
   statement, gets one result back. Two queries means two round-trips
   plus client-side merging.
2. **The planner can optimize the whole thing.** Postgres sees the
   shape of all four steps together and can pick the best join order,
   parallelism, and index access patterns. Splitting them into
   separate queries blocks that optimization.

For a small corpus the latency difference is small (10–20ms). For a
production-scale corpus it can be 10–100ms.

## Where in this codebase

[`src/retriever.js`](../src/retriever.js), the `hybridSearch`
function. Four named CTEs (`params`, `vector_hits`, `lexical_hits`,
`fused`) plus a final `SELECT`. One SQL statement, one round-trip.

## Read more

- [Postgres docs — `WITH` queries](https://www.postgresql.org/docs/current/queries-with.html)
- [Use The Index, Luke! — CTE patterns](https://use-the-index-luke.com/sql/clustering/index-only-scan-cte)
