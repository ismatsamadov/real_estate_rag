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
].join("\n");

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
  if (Array.isArray(options.history) && options.history.length > 0) {
    retrievalQuery = await rewriteForRetrieval(q, options.history);
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

  // Rewrite the question into a standalone form before retrieval (only if
  // there's prior history). Pronouns like "the other one" get resolved so
  // retrieval pulls the correct entity's chunks. The LLM still answers the
  // ORIGINAL question — rewriting is a retrieval-side concern only.
  let retrievalQuery = q;
  if (Array.isArray(options.history) && options.history.length > 0) {
    try {
      retrievalQuery = await rewriteForRetrieval(q, options.history);
      if (retrievalQuery !== q) {
        yield { type: "rewritten", original: q, rewritten: retrievalQuery };
      }
    } catch (err) {
      log.warn({ err: err.message }, "rewriteForRetrieval threw; using original");
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
