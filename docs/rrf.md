# RRF — Reciprocal Rank Fusion

**TL;DR.** When you have two ranked lists (say, vector-search results and
full-text-search results) and you need to combine them into one list,
RRF gives every document a score based only on its **rank position** in
each list, then sums those scores. No similarity score to normalize, no
weights to tune. It just works.

## What it is

For each document `d` in each ranked list `L`:

```
score(d) = sum over all lists L of:  1 / (k + rank_in_L(d))
```

`k` is a damping constant (we use **60**). Higher `k` flattens the score
curve so top-1 doesn't dominate too hard.

Example: a document ranked #1 in vector search and #3 in lexical search,
with `k=60`:

```
score = 1/(60+1) + 1/(60+3) = 1/61 + 1/63 ≈ 0.0164 + 0.0159 = 0.0323
```

A document ranked #1 in only one list:

```
score = 1/61 ≈ 0.0164
```

The first one wins. Documents that appear high in multiple lists get
double-counted; documents that show up only in one list still get credit
but less.

Introduced by Cormack, Clarke, and Büttcher in their 2009 SIGIR paper
*Reciprocal Rank Fusion outperforms Condorcet and Individual Rank Learning
Methods*. The paper benchmarks RRF against more elaborate fusion schemes
on TREC data and shows it consistently wins despite being trivially simple.

## Why we use it

The alternative is a **weighted sum** of similarity scores:

```
final_score = α × cosine_sim + (1 - α) × bm25_score
```

This requires choosing `α` (untunable without a validation set) and
normalizing scores that live in different ranges (`cosine_sim ∈ [0,1]`,
`bm25 ∈ [0, ∞)`). RRF skips both problems — rank position is the only
input, so the fusion is scale-invariant.

## Why `k = 60`?

The empirical sweet spot Cormack et al. found on TREC data. Subsequent
benchmarks across modern hybrid-search vendors (Elasticsearch, Azure AI
Search, OpenSearch, Weaviate, MongoDB Atlas) all default to `k ≈ 60` because
they all repeat the experiment and find the same answer.

You can change it via the `RRF_K` env var if you want to experiment.

## Where in this codebase

[`src/retriever.js`](../src/retriever.js), the `hybridSearch` function.
The RRF computation lives inside a single SQL CTE:

```sql
fused AS (
  SELECT id, SUM(weight) AS rrf_score
  FROM (
    SELECT id, 1.0 / ((SELECT rrf_k FROM params) + rnk) AS weight FROM vector_hits
    UNION ALL
    SELECT id, 1.0 / ((SELECT rrf_k FROM params) + rnk) AS weight FROM lexical_hits
  ) r
  GROUP BY id
)
```

No application-level merging, one round-trip to Postgres.

## Read more

- [Cormack, Clarke, Büttcher 2009 — *Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods* (PDF)](https://cormack.uwaterloo.ca/cormacksigir09-rrf.pdf)
- [Elasticsearch RRF documentation](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/reciprocal-rank-fusion)
- [Azure AI Search — Hybrid scoring with RRF](https://learn.microsoft.com/en-us/azure/search/hybrid-search-ranking)
