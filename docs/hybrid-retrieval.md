# Hybrid retrieval

**TL;DR.** Run a vector search and a full-text search in parallel, then
combine the rankings. Each catches a different class of query — vector
handles paraphrase, full-text handles exact terms and proper nouns.
The combination is robust to both.

## What problem it solves

A single retrieval method has predictable blind spots:

### Pure vector search misses proper nouns

User asks: *"Tell me about Knightsbridge"*

In embedding space, "Knightsbridge" is semantically similar to "luxury
apartments," "premium residences," "London real estate," and a dozen
other concepts. The cosine-closest chunks are competitor descriptions,
not Knightsbridge's actual page.

Full-text search (BM25) trivially finds the literal token
`"Knightsbridge"` and surfaces the right page on the first try.

### Pure full-text search misses paraphrase

User asks: *"What apartments have ocean views?"*

The corpus uses *"Caspian Sea panorama"* or *"floor-to-ceiling sea-facing
windows."* The literal word "ocean" appears nowhere. Full-text search
returns nothing useful.

Vector search trivially matches the semantic concept of water/view and
surfaces the right chunks.

### The hybrid wins on both

A unit at Knightsbridge with a sea view is surfaced by **both**
retrievers, so it ranks at the top of the fused list. A generic luxury
article that mentions "ocean view" only in a marketing tagline shows up
in vector but not full-text and ranks lower. The fusion absorbs both
signals.

## How we fuse the two rankings

We use **Reciprocal Rank Fusion (RRF)** — see [`rrf.md`](rrf.md). The
fusion runs as one Postgres CTE so there's no application-level merging:

```
1. Vector kNN  → top 32 candidates
2. Postgres FTS → top 32 candidates
3. RRF fusion  → top 32 by combined rank
4. Cross-encoder rerank → final top 8
```

## When does pure vector beat hybrid?

Three cases:

- **Stop-word-only queries** like *"the and is of"* — FTS produces zero
  hits. The retriever auto-falls-back to pure vector and emits a
  `fallback` SSE event so the UI can show it.
- **Heavy paraphrase** with no shared terms between query and corpus —
  FTS contributes nothing useful.
- **Cross-language queries** — if the query is in RU but the chunks are
  EN, FTS produces zero hits. Vector handles it (Voyage's embedding is
  multilingual). Same fallback applies.

## When does pure FTS beat hybrid?

Mostly never, in practice. Even on a "Knightsbridge exact-match"
query, hybrid + rerank produces the same top result as pure FTS
because RRF gives the FTS rank-1 result a high enough score to win the
fusion.

## Where in this codebase

[`src/retriever.js`](../src/retriever.js), the `hybridSearch` function.
Modes:

- `RAG_MODE=hybrid` — vector + FTS + RRF (default)
- `RAG_MODE=vector` — vector only, no FTS
- `RAG_MODE=lexical` — FTS only, no vector

The UI exposes a toggle in the composer footer so you can A/B retrievers
without a restart.

## Read more

- [Microsoft — *The case for hybrid search*](https://learn.microsoft.com/en-us/azure/search/hybrid-search-overview)
- [Anthropic — *Contextual Retrieval*](https://www.anthropic.com/news/contextual-retrieval) — discusses why hybrid + rerank consistently beats vector-only
- [`rrf.md`](rrf.md) — the fusion mechanism
- [`cross-encoder-rerank.md`](cross-encoder-rerank.md) — the second stage
