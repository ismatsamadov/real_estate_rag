# Asymmetric retrieval — query vs document embeddings

**TL;DR.** Modern retrieval embedding models have **two different
projection heads** — one for short questions ("query"), one for long
documents ("document") — and using the wrong one measurably hurts
recall. Voyage exposes this as `inputType: "query"` or `"document"`.
We use `"document"` at ingest time and `"query"` at retrieval time.

## What's "asymmetric" about it

In **symmetric** retrieval, the same embedding function encodes the
query and the documents. This is what older models like
SentenceTransformers' `all-MiniLM-L6-v2` (used by my first version of
this stack) do. It works, but it has a structural problem:

A typical query is short ("apartments with sea view"). A typical
document is long ("The Crescent Residences are a luxury complex…").
Forcing the same encoder to produce embeddings for both means the
model has to compromise — either focus on key-term matching (good for
short queries, bad for long documents) or focus on holistic meaning
(good for long documents, bad for short queries).

**Asymmetric** models train two projection heads from the same backbone:

- The **query head** is optimized for short, sparse inputs
- The **document head** is optimized for long, dense inputs
- Both project into the same shared vector space, so cosine similarity
  still works

At retrieval time you call the query head; at ingest time you call the
document head. Results land in the same space; they compare correctly.

## Why it matters

On the public BEIR benchmark, asymmetric models score 3–8% higher than
symmetric models of equivalent size. The Voyage docs explicitly warn:
*"Using the same input_type for both queries and documents can reduce
retrieval performance."*

It's a small SDK detail. It's a real recall difference.

## Where in this codebase

```js
// At ingest time — long documents
await embed(content, "document");

// At retrieval time — short queries
await embed(question, "query");
```

The wrapper in [`src/embedder.js`](../src/embedder.js) exposes both
functions and defaults `embed()` (single string) to `"query"` because
that's the more common call site. The batch function `embedBatch()`
defaults to `"document"` because it's used by ingest.

## Read more

- [Voyage docs — Embedding API](https://docs.voyageai.com/docs/embeddings) (search for `input_type`)
- [Reimers & Gurevych 2019 — *Sentence-BERT*](https://arxiv.org/abs/1908.10084) — origin of the asymmetric training pattern
- [BEIR benchmark](https://github.com/beir-cellar/beir) — where asymmetric models pull ahead empirically
