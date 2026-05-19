# LRU — Least Recently Used cache

**TL;DR.** A cache eviction policy: when full, drop the entry that
hasn't been accessed for the longest time. We use it for retrieval
results — a 5-minute LRU keyed by `(query, mode, filters, topK)` so
repeat queries skip the embed + SQL + rerank round-trip and return in
under a millisecond.

## What it is

A cache has a fixed size. When it fills up, you have to evict
something. Different policies make different bets about what's worth
keeping:

| Policy | When to evict | Best for |
|---|---|---|
| **FIFO** (first in first out) | Oldest entry | Streaming / time-windowed data |
| **LRU** (least recently used) | Entry not touched in the longest | General workloads (recently-used likely to be used again) |
| **LFU** (least frequently used) | Entry accessed fewest times overall | Stable hot-set workloads |
| **TTL only** | Entries past expiry | Workloads where freshness > recency |

LRU is the default for most application caches because of the "temporal
locality" assumption: things you touched recently are more likely to be
touched again than things you forgot about. For retrieval caches in
chat apps, this is a strong assumption — users iterate on related
questions.

## How LRU is implemented

The textbook implementation is a doubly-linked list + a hash map:

- Hash map: `key → list node` (O(1) lookup)
- Doubly-linked list: ordered from most-recently-used (head) to
  least-recently-used (tail)

Operations:
- **Get(key)** — look up node via hash map, move to head of list. O(1).
- **Set(key, value)** — insert at head; if size > max, drop the tail
  node. O(1).
- **TTL expiry** — check timestamp on access; lazy-evict expired
  entries.

The `lru-cache` npm package gives us all this with a one-line config.

## Why we use it for retrieval

Embedding the query + running the hybrid SQL CTE + reranking is ~500ms
per request. Most of that is API round-trips to Voyage. A user who
asks *"What apartments are at St Regis Baku?"*, gets an answer, then
asks the same question 10 seconds later (common during demo polishing)
should hit a cached result — not pay another 500ms.

The cache key includes everything that affects the result:

```js
JSON.stringify({
  q: question.toLowerCase().trim(),
  mode,        // "hybrid" | "vector" | "lexical"
  topK,
  candidateK,
  doRerank,
  filters,
})
```

A 5-minute TTL matches typical user think time. Longer TTLs risk
serving stale results if the corpus is re-ingested mid-session;
shorter TTLs miss the obvious "user iterates on the same question"
case.

## Why per-instance, not Redis?

For a single Vercel function instance handling ~10 RPS, an in-process
LRU is fine. Going to Redis adds:
- A network hop on every cache get
- A new service to operate
- Cache key serialization concerns

The tradeoff flips above ~100 RPS or when multiple regions need shared
cache. Not our problem today.

## Where in this codebase

[`src/retriever.js`](../src/retriever.js):

```js
const cache = config.retrieval.cacheTtlMs > 0
  ? new LRUCache({
      max: config.retrieval.cacheMax,
      ttl: config.retrieval.cacheTtlMs,
    })
  : null;
```

Hits show up in the SSE event as `cached: true` and render in the UI
as a "cache hit" blue pill.

## Read more

- [`lru-cache` npm package — docs](https://github.com/isaacs/node-lru-cache)
- [Wikipedia — Cache replacement policies](https://en.wikipedia.org/wiki/Cache_replacement_policies)
