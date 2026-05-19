"use strict";

const config = require("./config");
const logger = require("./logger");
const { retrieve } = require("./retriever");
const { buildMessages } = require("./prompt");
const { complete, completeStream } = require("./llm");
const memory = require("./memory");

const log = logger.child({ component: "rag" });

/**
 * Standalone-question rewriting for conversational RAG.
 *
 * On follow-ups like "Which one is cheapest?" or "What about the other one?",
 * the literal question doesn't carry the entity context — retrieval pulls
 * unrelated chunks. We pre-process by asking a fast model (Haiku) to
 * rewrite the question into a self-contained form using the conversation
 * history. The rewritten question is used ONLY for retrieval; the original
 * question is what the main LLM call (Sonnet) is asked to answer, so the
 * final response addresses what the user actually said.
 *
 * Skipped when history is empty (first turn) — saves a model call.
 */
const REWRITE_SYSTEM = [
  "You rewrite follow-up questions into standalone search queries.",
  "Given a conversation and a follow-up, return a single self-contained query",
  "that captures the same intent without needing the conversation to interpret.",
  "",
  "Rules:",
  "- Output ONLY the rewritten query as plain text — no prefix, no quotes, no explanation.",
  "- Preserve the user's language (EN / AZ / RU).",
  "- Resolve pronouns and references (\"this one\", \"the other\", \"its price\") to the specific entity from the conversation.",
  "- If the follow-up is already standalone, output it unchanged.",
  "- Keep it short — search queries do not need full sentences.",
  "",
  "ROOM-TERMINOLOGY conversion at retrieval time (corpus stores bedrooms only):",
  "- \"X otaqlı\" (AZ) / \"X-комнатная\" (RU) WITHOUT \"yataq\"/\"спальня\" means X total rooms.",
  "  Convert to \"(X-1)-bedroom\" in the rewritten query so retrieval pulls the right listings.",
  "  Examples:",
  "    \"3 otaqlı mənzil\"         → \"2-bedroom apartment\"",
  "    \"4-комнатная квартира\"   → \"3-bedroom apartment\"",
  "    \"2 otaqlı ev\"             → \"1-bedroom home\"",
  "- \"X yataq otaqlı\" / \"X спальня\" / \"X-bedroom\" stays as X bedrooms (no conversion).",
  "- Do NOT apply this conversion in the user-facing answer — only in the retrieval query.",
].join("\n");

/**
 * Mechanical preprocessor for the post-Soviet "rooms = bedrooms + 1" idiom.
 *
 *   "3 otaqlı"     → "2-bedroom" (preserves the rest of the query)
 *   "4-комнатная"  → "3-bedroom"
 *
 * Negative lookbehind protects "yataq otaqlı" / "спальня" — those are
 * explicit bedroom counts and must not be converted. Runs unconditionally
 * (no LLM call) so first-turn questions get the right retrieval target.
 *
 * Unicode-aware: the `u` flag + `\p{L}` lookahead replaces `\b`, because
 * Node's default `\b` is ASCII-only and silently fails after non-ASCII
 * letters like Azerbaijani "ı" (U+0131) or Cyrillic "комнатн".
 */
const OTAQLI_RE = /(?<!yataq\s)(\d+)\s*[-\s]?\s*otaq(?:lı|li)?(?=\s|[^\p{L}\d]|$)/giu;
const KOMNATNAYA_RE = /(?<!спальня\s)(\d+)\s*[-\s]?\s*комнатн(?:ая|ой|ую|ые|ых)?(?=\s|[^\p{L}\d]|$)/giu;

function preprocessRoomTerminology(text) {
  if (!text) return text;
  let out = String(text);
  let changed = false;
  out = out.replace(OTAQLI_RE, (_m, n) => {
    const total = parseInt(n, 10);
    if (!Number.isFinite(total) || total < 1) return _m;
    const bedrooms = Math.max(0, total - 1);
    changed = true;
    return `${bedrooms}-bedroom`;
  });
  out = out.replace(KOMNATNAYA_RE, (_m, n) => {
    const total = parseInt(n, 10);
    if (!Number.isFinite(total) || total < 1) return _m;
    const bedrooms = Math.max(0, total - 1);
    changed = true;
    return `${bedrooms}-bedroom`;
  });
  return { rewritten: out, changed };
}

async function rewriteForRetrieval(question, history) {
  if (!Array.isArray(history) || history.length === 0) return question;
  // Use only the last 4 turns as rewrite context; older history rarely helps.
  const trimmed = history.slice(-4);
  const convo = trimmed
    .map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`)
    .join("\n\n");
  const userText = [
    "Conversation so far:",
    convo,
    "",
    `Follow-up question: ${question}`,
    "",
    "Standalone search query:",
  ].join("\n");
  try {
    const { text } = await complete({
      system: [{ type: "text", text: REWRITE_SYSTEM }],
      messages: [{ role: "user", content: userText }],
      maxTokens: 120,
      temperature: 0,
    });
    const rewritten = String(text || "").trim().replace(/^["'`]|["'`]$/g, "");
    // Sanity: if rewrite is empty or much longer than the question and the
    // question was already long, fall back to the original.
    if (!rewritten || rewritten.length > 500) return question;
    return rewritten;
  } catch (err) {
    log.warn({ err: err.message }, "query rewrite failed; using original");
    return question;
  }
}

function noContextAnswer() {
  return {
    answer:
      "I could not find any relevant content in the knowledge base for this question.",
    sources: [],
    model: config.anthropic.defaultModel,
    usage: null,
    mode: "none",
  };
}

/**
 * One-shot ask: retrieves top-K, calls Anthropic, returns a single response.
 */
async function ask(question, options = {}) {
  const q = String(question || "").trim();
  if (!q) throw new Error("Question is empty.");
  const t0 = Date.now();

  let retrievalQuery = q;
  // Same room-terminology preprocessor as askStream.
  const pre = preprocessRoomTerminology(q);
  if (pre && pre.changed) retrievalQuery = pre.rewritten;
  if (Array.isArray(options.history) && options.history.length > 0) {
    retrievalQuery = await rewriteForRetrieval(retrievalQuery, options.history);
  }

  const { sources, mode, reranked, fallback, cached } = await retrieve(retrievalQuery, options);
  if (!sources.length) return { ...noContextAnswer(), topK: options.topK ?? config.retrieval.topK };

  const { system, messages } = buildMessages(q, sources, { history: options.history });
  const completion = await complete({
    system,
    messages,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
  });

  log.info(
    {
      ms: Date.now() - t0,
      mode,
      reranked,
      fallback,
      cached,
      sources: sources.length,
      model: completion.model,
      usage: completion.usage,
    },
    "ask complete",
  );

  return {
    answer: completion.text,
    sources,
    model: completion.model,
    usage: completion.usage,
    stop_reason: completion.stop_reason,
    mode,
    reranked,
    fallback,
    cached,
    topK: options.topK ?? config.retrieval.topK,
  };
}

/**
 * Streaming ask. Returns an async generator yielding control events plus
 * 'delta' text. The first non-control event is { type: 'sources', sources }
 * so the UI can render citation cards while text is still streaming.
 *
 * Event types: 'sources' | 'model' | 'delta' | 'usage' | 'done' | 'error'
 */
async function* askStream(question, options = {}) {
  const q = String(question || "").trim();
  if (!q) {
    yield { type: "error", error: "Question is empty." };
    return;
  }
  const t0 = Date.now();

  // RETRIEVAL-SIDE PREPROCESSING (the LLM still answers the ORIGINAL `q`):
  //   1. Mechanical: convert AZ/RU "X otaqlı / X-комнатная" → "(X-1)-bedroom"
  //      so retrieval pulls listings indexed by bedroom count. Runs always.
  //   2. LLM-based standalone-question rewrite for follow-ups (resolves
  //      pronouns like "the other one" using conversation history).
  let retrievalQuery = q;
  const pre = preprocessRoomTerminology(q);
  if (pre && pre.changed) {
    retrievalQuery = pre.rewritten;
    yield { type: "rewritten", original: q, rewritten: retrievalQuery, kind: "room-terminology" };
  }
  if (Array.isArray(options.history) && options.history.length > 0) {
    try {
      const after = await rewriteForRetrieval(retrievalQuery, options.history);
      if (after !== retrievalQuery) {
        yield { type: "rewritten", original: retrievalQuery, rewritten: after, kind: "history-resolve" };
        retrievalQuery = after;
      }
    } catch (err) {
      log.warn({ err: err.message }, "rewriteForRetrieval threw; using current query");
    }
  }

  // Recall cross-session memory (best-effort; never fails the request).
  // We use the REWRITTEN query for recall so follow-ups resolve correctly.
  let memories = [];
  if (options.userId) {
    try {
      memories = await memory.recallMemory(options.userId, retrievalQuery, {
        excludeSessionId: options.sessionId || null,
        topK: memory.RECALL_TOP_K,
      });
      if (memories.length) {
        yield { type: "memories", memories };
      }
    } catch (err) {
      log.warn({ err: err.message }, "memory recall failed");
    }
  }

  let retrieved;
  try {
    retrieved = await retrieve(retrievalQuery, options);
  } catch (err) {
    yield { type: "error", error: err.message || "Retrieval failed." };
    return;
  }

  // streaming path uses memories block; synchronous ask() does not (keeps
  // the eval harness deterministic and free of cross-session noise).
  const { sources, mode, reranked, fallback, cached } = retrieved;
  yield {
    type: "sources",
    sources,
    mode,
    reranked,
    fallback,
    cached,
    topK: options.topK ?? config.retrieval.topK,
  };

  if (!sources.length) {
    yield { type: "delta", text: noContextAnswer().answer };
    yield { type: "done", stop_reason: "no_context" };
    return;
  }

  const { system, messages } = buildMessages(q, sources, {
    history: options.history,
    memories,
  });

  let chosenModel = null;
  let answerLength = 0;
  try {
    for await (const event of completeStream({
      system,
      messages,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
    })) {
      if (event.type === "model") chosenModel = event.model;
      if (event.type === "delta") answerLength += event.text.length;
      yield event;
    }
  } catch (err) {
    log.error({ err: err.message }, "stream failed");
    yield { type: "error", error: err.message || "Generation failed." };
    return;
  }

  log.info(
    { ms: Date.now() - t0, mode, sources: sources.length, model: chosenModel, chars: answerLength },
    "askStream complete"
  );
}

module.exports = { ask, askStream };
