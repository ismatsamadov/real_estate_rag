# `ANALYZE` — refreshing the Postgres query planner

**TL;DR.** Postgres's query planner uses statistics about each table
(row count, value distributions, null fractions) to pick the fastest
execution plan. After a big write — like ingesting 850 chunks — those
stats are stale. `ANALYZE` rebuilds them. We run it at the end of every
`npm run ingest`.

## What it is

When you write a SQL query, Postgres doesn't follow it literally. The
**planner** considers multiple execution strategies (sequential scan
vs index scan, hash join vs nested loop, etc.) and picks the cheapest
based on its estimate of how many rows each step would produce.

Those estimates come from statistics in the `pg_statistic` system
catalog — distinct value counts, most common values, histogram
bounds, null fractions. The planner consults this catalog when
planning queries.

`ANALYZE` is the command that recomputes those statistics:

```sql
ANALYZE rag_chunks;
ANALYZE documents;
```

(`ANALYZE` with no arguments analyzes every table in the database.)

## Why we need to run it manually

Postgres has an **autovacuum** daemon that runs `ANALYZE` automatically
when a table accumulates enough writes. The default threshold is
roughly "10% of the table has changed." For background workloads, this
is fine — autovacuum catches up eventually.

But:
- Right after a bulk ingest, the table is suddenly 100× bigger. Until
  autovacuum runs, the planner thinks the table is tiny and may pick a
  sequential scan when an index scan would be 1000× faster.
- The HNSW index was just built on data the planner doesn't know about.
  Without fresh stats, it might not use the index at all.

Running `ANALYZE` synchronously at the end of ingest guarantees the
planner has the stats it needs **before** the first user query lands.

## What it actually computes

For each column in the table, `ANALYZE` samples rows (default ~30,000
samples per relation) and computes:

- **Number of distinct values** — used by joins to pick hash vs nested loop
- **Most common values + frequencies** — for selectivity estimates on `WHERE col = X`
- **Histogram bounds** — for range queries `WHERE col BETWEEN X AND Y`
- **Null fraction** — for `IS NULL` predicates
- **Average row width** — for memory sizing

These end up in `pg_stats` (a friendly view over `pg_statistic`). You
can peek with:

```sql
SELECT attname, n_distinct, correlation, null_frac
FROM pg_stats WHERE tablename = 'rag_chunks';
```

## What ANALYZE does NOT do

- **No data scanning.** ANALYZE samples; it doesn't read every row.
- **No locking.** Reads and writes continue during ANALYZE.
- **No index rebuilding.** ANALYZE only refreshes stats. Use `REINDEX`
  to rebuild bloated indexes.
- **No vacuuming.** ANALYZE doesn't reclaim dead row space. Use `VACUUM`
  for that. `VACUUM ANALYZE` does both.

## Where in this codebase

- After ingest: [`scripts/ingest.js`](../scripts/ingest.js) — the
  `await db.analyze()` call after the last batch
- The function: [`src/db.js`](../src/db.js) — `analyze()` runs
  `ANALYZE rag_chunks` and `ANALYZE documents`

For our HNSW index specifically, fresh ANALYZE stats matter because
Postgres's index-vs-scan decision depends on the estimated row count.
On a freshly populated table without ANALYZE, the planner has near-zero
visibility into what's there.

## Read more

- [Postgres docs — `ANALYZE`](https://www.postgresql.org/docs/current/sql-analyze.html)
- [Postgres docs — Autovacuum tuning](https://www.postgresql.org/docs/current/routine-vacuuming.html#AUTOVACUUM)
- [Postgres docs — `pg_stats` view](https://www.postgresql.org/docs/current/view-pg-stats.html)
