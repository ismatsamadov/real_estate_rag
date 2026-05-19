# HNSW — Hierarchical Navigable Small World

**TL;DR.** A graph-based algorithm for finding the approximate nearest
neighbors of a vector in a million-vector database in milliseconds. It's
the index type we use on the `embedding` column. The name describes the
structure: a hierarchy of layered graphs where each node's neighbors are
small-world connections (mostly local, with a few long-range shortcuts).

## What it is

Imagine a road network where every city has a few local streets (short
hops to nearby cities) and one highway (a long-range shortcut to a city
hundreds of miles away). To get from anywhere to anywhere, you take
highways most of the way then local streets the last mile.

HNSW builds this structure for vectors. The graph has multiple layers;
the top layer has just a few well-connected "highway" nodes, lower layers
add denser local connections. A query starts at the top, greedily
descends toward its nearest neighbor, then refines on lower layers.

Result: searching a million vectors takes log(N) comparisons instead of
N. Modern HNSW implementations can search 10M vectors in single-digit
milliseconds with 95%+ recall.

Introduced by Malkov & Yashunin (2016, *Efficient and robust approximate
nearest neighbor search using Hierarchical Navigable Small World graphs*).

## Why we use it (vs IVFFlat, vs flat scan)

- **vs flat scan** — flat scan is exact but O(N). At ~850 chunks we
  could flat-scan, but the index gets us to the same answer 100x faster
  and scales when the corpus grows.
- **vs IVFFlat** — IVFFlat clusters vectors and probes the closest
  clusters. Faster build, but you have to train it (`CREATE INDEX` runs
  k-means on your data) and re-train when distributions shift. HNSW
  builds incrementally and has no training step — just insert and
  search.

## Key parameters (the ones we set)

```sql
CREATE INDEX ON rag_chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

| Parameter | Our value | What it does | Tradeoff |
|---|---|---|---|
| `m` | 16 | Max bidirectional links per node | Higher = better recall, more memory + slower build |
| `ef_construction` | 64 | How widely to search for neighbors when inserting | Higher = better graph quality, slower index build |
| `ef_search` (runtime) | default (40 in pgvector) | How widely to search at query time | Higher = better recall, slower query |

`m=16, ef_construction=64` are pgvector's defaults and the values most
commonly cited in literature for ~1M-scale corpora. We didn't tune; the
defaults work.

## Where in this codebase

- Schema: [`src/db.js`](../src/db.js), inside `ensureSchema()` — the
  `CREATE INDEX ... USING hnsw` block.
- Query usage: [`src/retriever.js`](../src/retriever.js), the
  `embedding <=> $1::vector` operator triggers the HNSW index.

## Read more

- [Malkov & Yashunin 2016 — *Efficient and robust approximate nearest neighbor search using Hierarchical Navigable Small World graphs* (arXiv)](https://arxiv.org/abs/1603.09320)
- [pgvector — HNSW index documentation](https://github.com/pgvector/pgvector#hnsw)
- [Pinecone — HNSW visual explainer](https://www.pinecone.io/learn/series/faiss/hnsw/)
