# Prompt caching — Anthropic `cache_control: ephemeral`

**TL;DR.** Anthropic lets you mark parts of your prompt as cacheable. The
first call writes the cache (1.25× normal cost), subsequent calls within
5 minutes read from it at **10% of normal cost** — a 90% input-token
discount on the cached portion. Wired in our system prompt; not currently
hitting because our prompt is below the 1024-token minimum.

## What it is

Every Claude API call processes the entire input prompt from scratch. For
a RAG system that re-uses the same system prompt across thousands of
queries, that's wasteful — the same 800 tokens are paid for every time.

Prompt caching adds a marker to any prompt block:

```js
{
  type: "text",
  text: SYSTEM_PROMPT,
  cache_control: { type: "ephemeral" }
}
```

The first call with this marker writes the cache (charged at 1.25× the
normal input token rate). Subsequent calls within the cache TTL (5 minutes
by default) read from the cache at **0.1×** the normal input rate — a 90%
discount on the cached prefix.

## How it works mechanically

The cache key is the **prefix** of the prompt up to and including the
last `cache_control` block. Three things have to match for a hit:

1. The model (caches are per-model)
2. The byte-exact prefix
3. Within the TTL window (5 minutes for `ephemeral`)

If you cache the system prompt, the entire system block must match for a
cache hit. Adding even a space invalidates the cache. The user message
that comes after the cached prefix doesn't need to match — it can be
different on every call.

## Minimum cacheable size

This is where most demos miss out:

| Model | Minimum prefix for cache eligibility |
|---|---|
| Claude Opus 4 / Sonnet 4 / Sonnet 3.7 / Sonnet 3.5 / Opus 3 | **1,024 tokens** |
| Claude Haiku 3.5 / Haiku 3 | **2,048 tokens** |

Our current system prompt is ~900 tokens. **Below the cache threshold.**
We have `cache_control: ephemeral` wired in [`src/prompt.js`](../src/prompt.js)
so the breakpoint exists, but `usage.cache_read_input_tokens` returns
`0` on every call.

Adding ~150 tokens of few-shot examples (or moving the room-terminology
table from prose into a structured Q&A block) would push the prompt over
1,024 and unlock the discount. On the roadmap.

## What gets cached vs not

**Cached:** the system prompt block, tools (if any), and the messages
array up to the last `cache_control` marker.

**Not cached:** anything after the last `cache_control` marker. In our
case, the user message — which carries the question + the retrieved
sources — is always fresh.

This is the right division for RAG. The system prompt is static and
benefits from caching; the sources change every turn and shouldn't be
cached.

## When it would save real money

For high-volume RAG:

- Suppose 10k queries/day with a 1,500-token cached system prompt
- Sonnet input pricing: $3/M tokens
- Daily cached cost without cache: 10,000 × 1,500 × $3/M = $45
- Daily cached cost with cache (90% reads): 10,000 × 1,500 × $0.30/M = $4.50
- Savings: $40/day = $1,200/month on just the system prompt

For our demo with maybe 100 queries/day total, the savings are negligible
— but the wiring matters because the moment we scale we want the
infrastructure already in place.

## Where in this codebase

[`src/prompt.js`](../src/prompt.js), the `buildMessages` function:

```js
system: [
  {
    type: "text",
    text: SYSTEM_PROMPT,
    cache_control: { type: "ephemeral" },
  },
]
```

Usage telemetry (cache reads, cache writes) shows up in
`usage.cache_read_input_tokens` and `usage.cache_creation_input_tokens` on
each response and is logged + emitted to the UI as part of the assistant
message metadata.

## Read more

- [Anthropic — Prompt caching docs](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)
- [Anthropic — pricing for cache writes/reads](https://www.anthropic.com/pricing)
- [Anthropic announcement — Prompt Caching launch](https://www.anthropic.com/news/prompt-caching)
