# MTEB — Massive Text Embedding Benchmark

**TL;DR.** A standard benchmark for comparing text embedding models
across many tasks (retrieval, classification, clustering,
summarization). Hugging Face hosts the leaderboard; vendors publish
scores; you pick a model based on the tasks closest to yours.

## What it is

Before MTEB (Muennighoff et al. 2022), every embedding vendor reported
results on whatever benchmark made them look best. MTEB standardized
the evaluation:

- **58 datasets, 8 task types** in the original release
  (retrieval, semantic textual similarity, classification, clustering,
  reranking, pair classification, bitext mining, summarization)
- **112 languages** in the multilingual variant (MMTEB)
- Open submission — any team can run the public eval scripts and
  upload results
- Live leaderboard at [huggingface.co/spaces/mteb/leaderboard](https://huggingface.co/spaces/mteb/leaderboard)

For RAG-style work, the **retrieval** task family is what matters most.
It measures whether the embedding model places relevant documents close
to the query in vector space.

## Where Voyage sits on MTEB (and where it doesn't)

Honest take, as of early 2026:

- **Overall MTEB top-10** is currently dominated by Alibaba's Qwen3
  Embedding family (Qwen3-Embedding-8B scores ~70.6) and NVIDIA's
  Llama-Embed-Nemotron-8B. OpenAI's `text-embedding-3-large` sits around
  64–65.
- **Multilingual MTEB** (MMTEB) is more competitive — Nemotron-8B and
  Qwen3 lead overall, but Voyage's `voyage-4-large` is in the top
  cluster of API-only models and outperforms OpenAI's multilingual
  scores by a meaningful margin.

So "tops MTEB" is wrong; "competitive on multilingual MTEB among hosted
API embedding services" is accurate. The honest version belongs in the
README too.

## Why we use Voyage (despite not being #1 overall)

- **Multilingual quality matches our corpus.** EN / AZ / RU. Open-source
  models like Qwen3 and Nemotron score higher but require us to host
  inference. Voyage gives us a competitive multilingual model at zero
  ops cost.
- **Asymmetric retrieval is first-class.** `inputType: "query"` vs
  `"document"` uses separate projection heads — small SDK detail, real
  recall difference. Not every vendor exposes this cleanly.
- **Same SDK has rerank.** `rerank-2.5` shares the client and the API
  key.
- **200M free tokens.** No payment required for the whole corpus +
  evaluation runs.

If we ever ran inference ourselves, switching to Qwen3 or Nemotron for
embeddings would be a one-day migration: re-ingest with the new model,
update `VECTOR_DIM` to match.

## Where in this codebase

- Embedder: [`src/embedder.js`](../src/embedder.js) — the Voyage
  client wrapper
- Reranker: same file, the `rerank` function
- Config: [`src/config.js`](../src/config.js) — `VOYAGE_EMBED_MODEL`,
  `VOYAGE_RERANK_MODEL`

## Read more

- [MTEB live leaderboard](https://huggingface.co/spaces/mteb/leaderboard)
- [Muennighoff et al. 2022 — *MTEB: Massive Text Embedding Benchmark*](https://arxiv.org/abs/2210.07316)
- [Voyage AI — model performance docs](https://docs.voyageai.com/docs/embeddings)
