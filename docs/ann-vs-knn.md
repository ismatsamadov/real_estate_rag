# ANN vs kNN — approximate vs exact nearest neighbor

**TL;DR.** **kNN** (exact k-Nearest Neighbors) finds the truly closest
vectors by comparing your query against every vector in the database.
**ANN** (Approximate Nearest Neighbors) gives you "almost the closest"
in a fraction of the time, with controllable accuracy. Our HNSW index
is an ANN method.

## What's the difference?

### kNN (exact)

Given a query vector `q` and a database of `N` vectors, kNN returns the
`k` truly closest vectors by computing the distance from `q` to every
one of them.

- **Accuracy:** 100% (it's the ground truth)
- **Time complexity:** O(N × d) where d is the dimensionality
- **Scales:** Up to maybe 100k vectors for sub-second queries; doesn't
  scale to millions

In SQL terms, kNN is a flat scan:

```sql
SELECT id FROM rag_chunks
ORDER BY embedding <=> $1::vector
LIMIT 8;
-- Postgres scans every row, sorts by distance.
```

### ANN (approximate)

ANN sacrifices guaranteed accuracy for massive speedup. Instead of
comparing against all N vectors, ANN uses a precomputed data structure
(graph, tree, or hash) to find "very probably close" vectors in
sub-linear time.

- **Accuracy:** typically 95–99% recall vs ground truth (tunable)
- **Time complexity:** O(log N) for HNSW; sometimes O(√N) for other
  methods
- **Scales:** Routinely 100M+ vectors with millisecond latency

In SQL terms, ANN is the same query but with the HNSW index in play:

```sql
-- Same SQL — but with WITH (m=16, ef_construction=64) HNSW index
SELECT id FROM rag_chunks
ORDER BY embedding <=> $1::vector
LIMIT 8;
-- Postgres uses the HNSW graph to find ~95% of the truly closest vectors.
```

Same query syntax, completely different execution.

## When to use which

| | Exact kNN | Approximate ANN |
|---|---|---|
| Corpus size | ≤ 100k | Any |
| Recall requirement | Must be 100% | ≥ 95% acceptable |
| Latency budget | ≥ seconds OK | Milliseconds |
| Build cost | None | Index construction time |
| Updates | Free | Index maintenance |

For 850 chunks, exact kNN would actually be **fast enough** for our
corpus. We use HNSW anyway because:

1. It's the default at the scale we'll grow to
2. It costs almost nothing to set up
3. The recall hit at our size is negligible
4. It establishes the right pattern for future scale

## The "ef_search" knob

HNSW's accuracy is tunable at query time via `ef_search`. Higher =
more graph nodes visited per query = higher recall = slower:

| ef_search | Approximate recall | Relative speed |
|---|---|---|
| 10 | 70–85% | Fastest |
| 40 (pgvector default) | 90–95% | Default |
| 100 | 97–99% | 3x slower |
| 400 | 99%+ | 10x slower |

If you need higher recall (eval-grade results), bump `ef_search`. For
the user-facing chat, the default 40 is fine because rerank corrects
most of the misses anyway.

## Where in this codebase

- Index definition: [`src/db.js`](../src/db.js) — HNSW with default
  pgvector params
- Distance operator: [`src/retriever.js`](../src/retriever.js) — the
  `<=>` cosine distance operator triggers HNSW
- For deeper detail: [`hnsw.md`](hnsw.md)

## Read more

- [pgvector — HNSW vs IVFFlat comparison](https://github.com/pgvector/pgvector#hnsw)
- [ANN-Benchmarks — independent benchmark of ANN libraries](http://ann-benchmarks.com/)
- [Faiss tutorial — *Nearest neighbor search*](https://www.pinecone.io/learn/series/faiss/) (Pinecone series, very accessible)
