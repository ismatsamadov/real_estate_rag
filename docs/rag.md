# RAG — Retrieval-Augmented Generation

**TL;DR.** Instead of asking a language model what it remembers, you first
retrieve relevant documents from a knowledge base and ask the model to
answer using only those documents. The model becomes a *reader*, not an
oracle.

## What it is

A language model trained on the public internet "knows" a lot but it
knows it as a fuzzy compressed mixture of facts and patterns. Ask it
about your private corpus — your company's product docs, last week's
support tickets, a specific real-estate listing — and you'll get
confident-sounding hallucination at worst, or "I don't have access to
that" at best.

RAG fixes this by splitting the problem into two steps:

1. **Retrieve** — given a user question, find the most relevant chunks
   of your knowledge base. Usually a mix of vector similarity (semantic
   match) and keyword search (exact-term match).
2. **Generate** — feed those chunks into the model's prompt as context
   and ask it to answer using *only* what's in the context, with
   citations.

The system prompt enforces the contract: every claim ends with a
citation marker like `[S1]` so the user can verify every fact.

## Why we use it here

- The model (Claude Sonnet) has never seen `pasharealestate.az`.
- The corpus is small (~850 chunks) but rich — prices, addresses, unit
  numbers, amenities — exactly the kind of facts a model would invent
  if asked from memory.
- Retrieval + citation gives users a clickable audit trail. A grounded
  RAG system is the difference between an assistant you can trust on
  $1M+ purchase decisions and a confident-sounding chatbot.

## The five stages of our RAG pipeline

```
1. Embed    → Voyage voyage-4-large (1024-d) turns the question into a vector
2. Retrieve → Postgres CTE runs vector kNN + full-text search, fused via RRF
3. Rerank   → Voyage rerank-2.5 cross-encoder re-scores the top 32 candidates
4. Prompt   → System prompt + sources tagged [S1]..[S8] + the question
5. Generate → Claude streams the answer with [Sn] citations
```

## Where in this codebase

- [`src/rag.js`](../src/rag.js) — orchestrator (`ask` and `askStream`)
- [`src/retriever.js`](../src/retriever.js) — step 2 + 3
- [`src/embedder.js`](../src/embedder.js) — step 1
- [`src/llm.js`](../src/llm.js) — step 5
- [`src/prompt.js`](../src/prompt.js) — step 4 (system prompt + sources block)

## Read more

- [Lewis et al. 2020 — *Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks*](https://arxiv.org/abs/2005.11401) — the original RAG paper
- [Anthropic — Building with Claude · contextual retrieval](https://www.anthropic.com/news/contextual-retrieval) — modern best practices
