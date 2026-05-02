"use strict";

const config = require("./config");
const logger = require("./logger");
const { retrieve } = require("./retriever");
const { buildMessages } = require("./prompt");
const { complete, completeStream } = require("./llm");

const log = logger.child({ component: "rag" });

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

  const { sources, mode } = await retrieve(q, options);
  if (!sources.length) return { ...noContextAnswer(), topK: options.topK ?? config.retrieval.topK };

  const { system, messages } = buildMessages(q, sources);
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
      sources: sources.length,
      model: completion.model,
      usage: completion.usage,
    },
    "ask complete"
  );

  return {
    answer: completion.text,
    sources,
    model: completion.model,
    usage: completion.usage,
    stop_reason: completion.stop_reason,
    mode,
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

  let retrieved;
  try {
    retrieved = await retrieve(q, options);
  } catch (err) {
    yield { type: "error", error: err.message || "Retrieval failed." };
    return;
  }

  const { sources, mode } = retrieved;
  yield { type: "sources", sources, mode, topK: options.topK ?? config.retrieval.topK };

  if (!sources.length) {
    yield { type: "delta", text: noContextAnswer().answer };
    yield { type: "done", stop_reason: "no_context" };
    return;
  }

  const { system, messages } = buildMessages(q, sources);

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
