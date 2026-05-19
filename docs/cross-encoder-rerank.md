# Cross-encoder reranking

**TL;DR.** A second-stage scoring model that reads the user's query and
each candidate document **together** (not separately), producing a more
accurate relevance score than first-stage retrieval. We use Voyage's
`rerank-2.5` to re-score the top 32 hybrid-retrieved candidates and
keep the top 8.

## What it is — bi-encoder vs cross-encoder

**Bi-encoder** (what embeddings do):
- Encode the query once → vector
- Encode each document once → vector (in advance, stored)
- Compare with cosine similarity
- Fast (millions of comparisons per second), but the query and document
  never "see" each other — the model has to encode each one in
  isolation.

**Cross-encoder** (what reranker does):
- Concatenate query + document → single input
- Run the full attention mechanism over both at once
- Output a single relevance score
- Slow (~10ms per pair) but **much more accurate** because the model
  can attend across both texts.

## Why both? Why not just cross-encoder everything?

Cost. Cross-encoding every document in a 1M-vector corpus against every
query is prohibitive — that's a million inference calls per query.

The standard architecture is **first-stage retrieval (cheap, broad) →
rerank (expensive, narrow)**:

```
1M docs → ANN/FTS top 100 candidates  (cheap, 95% recall)
       → Cross-encoder rerank top 100  (expensive, much higher precision)
       → Top 5–10 to the LLM
```

The bi-encoder gets you to ~95% recall in milliseconds; the
cross-encoder corrects the ranking errors in the top 100.

## Why we use it here

On our corpus, the cross-encoder is the **single biggest quality bump
after RRF**. On eval questions like *"кvartira na prodazhu Baku"* (RU
"apartment for sale in Baku"), the bi-encoder + FTS gets the right
chunks into the top 32 but ranks a generic "Каталог квартир" page
above the actual apartment listings. Rerank flips that.

Voyage's `rerank-2.5` was trained specifically for retrieval reranking,
runs on the same API as the embedder, and costs ~$0.05 per 1,000
queries — cheap insurance against ANN errors.

## How to interpret rerank scores

The reranker returns a `relevance_score` between 0 and 1. Rough rule:

| Score | Meaning |
|---|---|
| `≥ 0.85` | Highly relevant, almost always a real match |
| `0.65 – 0.85` | Probably relevant, may need context to be sure |
| `0.30 – 0.65` | Tangentially related, citation-worthy in some queries |
| `< 0.30` | Not relevant; the model surfaced it for keyword overlap |

We pass the scores through to the UI as `rerank_score` on each source
card so the user can see at a glance how confident retrieval is.

## Where in this codebase

- Rerank call: [`src/embedder.js`](../src/embedder.js), the `rerank`
  function
- Wiring: [`src/retriever.js`](../src/retriever.js) — applied after
  hybrid retrieval, before slicing to `topK`
- Toggle: `RAG_RERANK` env var (default `true`)

## Read more

- [Voyage docs — Reranking](https://docs.voyageai.com/docs/reranker)
- [Sentence-Transformers — Cross-encoder vs Bi-encoder explainer](https://www.sbert.net/examples/applications/cross-encoder/README.html)
- [Nogueira & Cho 2019 — *Passage Re-ranking with BERT*](https://arxiv.org/abs/1901.04085) (the canonical cross-encoder reranking paper)
