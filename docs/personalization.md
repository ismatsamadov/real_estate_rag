# Personalization in LLM apps

## What it is

The general problem of giving an LLM enough context about a specific user
that its answers feel addressed to *them*, not to a generic visitor.

Concretely:
- "Recommend an apartment" should account for the user having saved 2BR
  units in Knightsbridge, not return random listings.
- "What did we talk about?" should work across sessions, not just within
  the current conversation.
- "Tell me more" should resolve to the most recent topic *for that
  specific user*, not whoever else uses the same app.

## The spectrum

| Pattern | What it captures | Latency cost | When to use |
|---|---|---|---|
| **In-session history** | Last few turns of the current chat | Free (already in messages) | Multi-turn coherence within one session |
| **RAG over conversation memory** | Top-K semantically-relevant prior Q+A across sessions | One embedding + one kNN query | Recurring topics, vocabulary continuity |
| **Saved-item context** | Explicit user signals (favorites, bookmarks) | One SQL query | Strong preference signal |
| **Persistent intent profile** | LLM-synthesized summary of the user | One LLM call (cached, refreshed lazily) | Cold-start of new sessions; cross-topic synthesis |
| **Slot-filled user profile** | Structured fields (preferred_bedrooms, budget…) | None at read time | When the schema is well-defined and queryable |
| **Fine-tuned per-user model** | Implicit | Massive training cost | Very large user bases with deep, narrow domains |

This codebase stacks the first four. Slot-filling and fine-tuning are
deliberately skipped — they don't pay off at single-tenant demo scale and
they reduce flexibility.

## What we ship

| Layer | Module | When |
|---|---|---|
| In-session history | [`src/sessions.js`](../src/sessions.js) `recentHistory` | Per turn |
| Memory recall | [`src/memory.js`](../src/memory.js) `recallMemory` | Per turn, query-conditional |
| Saved-item context | included in profile | Per turn (computed) |
| Intent summary | [`src/profile.js`](../src/profile.js) | Per turn (read from cache) |
| Memory write | [`src/memory.js`](../src/memory.js) `appendMemory` | Post-turn (filtered) |
| Profile refresh | [`src/profile.js`](../src/profile.js) `maybeRefreshProfile` | Post-turn (throttled) |

## Why this stack

- Memory recall is **precise but query-conditional** — only the past
  turns relevant to *this* question.
- The intent profile is **always-on but synthetic** — captures taste,
  language, themes.
- Saved listings are **a strong explicit signal** — the user clicked the
  heart on it, that's higher-confidence than "they once asked about it."

Stacking them means the model sees:
1. A summary of who the user is.
2. The user's saved items by title.
3. Their recent topics.
4. The 0–3 *most relevant* prior Q+A pairs.
5. The current session's history.
6. The current question + retrieved sources.

Each layer compensates for the others' blind spots.

## What we deliberately don't do

| Anti-pattern | Why not |
|---|---|
| Dump the user's full chat history every turn | Token-budget disaster; most of it is noise for any single question. |
| Aggregate a structured user profile from chats automatically | Brittle; LLMs are bad at "X preferred 2BR" extraction without explicit feedback. |
| Personalize the citation source ranking | Citations must be objective evidence; personalizing them invites hallucination via confirmation bias. |
| Train per-user embeddings | Vastly overkill at this scale; pgvector with shared embeddings is fine. |
| Treat memory/profile as citable facts | The model can mention them ("you previously asked X") but never cite them as `[Sn]` evidence. The citation contract stays clean. |

## Where it shows up

The personalization stack is wired in
[`src/rag.js`](../src/rag.js) `askStream`:

```js
// Run in parallel — neither can block the other.
const [memRes, ctxRes] = await Promise.allSettled([
  memory.recallMemory(userId, retrievalQuery, { excludeSessionId, topK }),
  profile.getUserContext(userId),
]);

// Build the message with all four context layers.
const { system, messages } = buildMessages(question, sources, {
  history: options.history,    // in-session
  memories,                    // cross-session recalled
  userContext,                 // standing intent + signals
});
```

And in [`src/prompt.js`](../src/prompt.js) `buildMessages`:
- USER PROFILE block (who they are)
- MEMORIES block (what they discussed)
- HISTORY messages (current session)
- Question + SOURCES (now)

## Related glossary

- [`user-profile.md`](user-profile.md) — the LLM-derived summary
  specifically.
- [`rag.md`](rag.md) — base RAG.
- [`prompt-caching.md`](prompt-caching.md) — keeping context-heavy
  prompts cheap.

## External sources

- Anthropic, [_Building effective agents_, 2025](https://www.anthropic.com/engineering/building-effective-agents) — context engineering principles.
- OpenAI, [_Memory and personalization_ docs](https://platform.openai.com/docs/guides/memory) — different implementation, same problem.
- Lewis et al., [_Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks_, 2020](https://arxiv.org/abs/2005.11401) — the RAG paper.
