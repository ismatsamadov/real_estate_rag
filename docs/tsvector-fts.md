# Postgres FTS — `tsvector`, `tsquery`, BM25-style lexical search

**TL;DR.** Postgres has built-in full-text search. You tokenize text into
a `tsvector` (a sorted list of lexemes), tokenize the user's query into a
`tsquery`, and ask `tsv @@ tsq`. Index it with GIN, rank results with
`ts_rank_cd`. No external Elasticsearch needed.

## What it is

Full-text search (FTS) is the family of techniques that powers Google,
Elasticsearch, and every code-search tool. The core ideas:

- **Tokenize** the text into words (lexemes).
- **Build an inverted index** mapping each lexeme to the rows containing
  it.
- **Score relevance** by some function of term frequency (how often the
  term appears in the doc) and inverse document frequency (how rare it
  is across the corpus). The classic formula is **BM25** — a refinement
  of the TF-IDF idea from the 1990s.

Postgres FTS uses a variant of this with built-in normalization
(lowercasing), optional stemming (English-aware: "running" →
"run"), and stop-word removal.

## The `tsvector` column

```sql
tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED
```

A `tsvector` is a sorted list of `(lexeme, positions)` pairs derived from
the source text. We generate it from the `content` column using the
`'simple'` text-search configuration.

### Why `'simple'`, not `'english'`?

This is the most important detail. Postgres FTS configs control stemming
and stop-words:

- `'english'` — Snowball stemmer, English stop-word list. *"Knightsbridge"*
  gets stemmed to `"knightsbridg"` (a non-word). The user's literal
  search for "Knightsbridge" then fails to match.
- `'simple'` — tokenize and lowercase only. No stemming, no stop-words
  removed. `"Knightsbridge"` indexes as `"knightsbridge"` and matches
  cleanly.

For **multilingual** content (AZ, RU) and **proper-noun-heavy** real
estate text (brand names, addresses, unit numbers), `'simple'` is the
right choice. Stemming would mangle most of our exact-match queries.

## How we query it

```sql
SELECT *
FROM rag_chunks
WHERE tsv @@ plainto_tsquery('simple', $1)
ORDER BY ts_rank_cd(tsv, plainto_tsquery('simple', $1)) DESC
LIMIT 32;
```

- `plainto_tsquery('simple', $1)` — converts the user's input to a
  `tsquery` (tokens AND'd together)
- `@@` — the FTS match operator
- `ts_rank_cd` — cover-density ranking. Gives higher scores to docs
  where the matched terms appear close together (a phrase match scores
  higher than scattered matches)

This is BM25-flavored but not pure BM25 — Postgres's `ts_rank_cd` uses a
slightly different formula. Close enough for our purposes; the rerank
stage corrects for the difference anyway.

## Where in this codebase

- Schema: [`src/db.js`](../src/db.js) — the generated `tsv` column and
  the `gin (tsv)` index (see [`gin-index.md`](gin-index.md))
- Query: [`src/retriever.js`](../src/retriever.js), `lexicalSearch`
  and `hybridSearch`

## Read more

- [Postgres docs — Full Text Search](https://www.postgresql.org/docs/current/textsearch.html)
- [BM25 — Robertson & Zaragoza 2009 *The Probabilistic Relevance Framework*](https://www.staff.city.ac.uk/~sb317/papers/foundations_bm25_review.pdf)
- [Why Postgres FTS is often "enough"](https://medium.com/geekculture/postgres-full-text-search-vs-elasticsearch-3a4a7c6b3c8e)
