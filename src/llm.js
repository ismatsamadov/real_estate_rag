"use strict";

/**
 * Anthropic client wrapper.
 *
 *   - Falls through `ANTHROPIC_MODEL_CANDIDATES` on 404 (model not found),
 *     so we degrade Sonnet -> Haiku if Sonnet ever gets retired.
 *   - Retries with exponential backoff on 429 (rate limit) and 529 (overloaded)
 *     within a single model attempt before falling through.
 *   - Prompt caching is wired in `prompt.js` (system block carries
 *     cache_control: ephemeral). Usage events expose cache hits.
 *   - Streaming and non-streaming entry points share retry/fallback logic.
 */

const Anthropic = require("@anthropic-ai/sdk");
const config = require("./config");
const logger = require("./logger");

const log = logger.child({ component: "llm" });

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);
const MAX_RETRIES_PER_MODEL = 4;
const MAX_BACKOFF_MS = 30_000;

let modelOrderPromise = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isModelNotFound(err) {
  return err?.status === 404 || err?.error?.type === "not_found_error";
}

function isRetryable(err) {
  return RETRYABLE_STATUSES.has(err?.status);
}

async function resolveModelOrder() {
  if (modelOrderPromise) return modelOrderPromise;
  modelOrderPromise = (async () => {
    let listed = [];
    try {
      const response = await client.models.list();
      listed = Array.isArray(response?.data)
        ? response.data.map((m) => m.id).filter(Boolean)
        : [];
    } catch (err) {
      log.debug({ err: err.message }, "models.list failed; relying on env order");
    }
    const seen = new Set();
    const order = [];
    for (const id of [
      config.anthropic.defaultModel,
      ...config.anthropic.candidateModels,
      ...listed,
    ]) {
      if (id && !seen.has(id)) {
        seen.add(id);
        order.push(id);
      }
    }
    return order;
  })();
  return modelOrderPromise;
}

function extractText(message) {
  if (!message?.content) return "";
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

async function withRetries(fn, modelId) {
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      return await fn();
    } catch (err) {
      if (!isRetryable(err) || attempt >= MAX_RETRIES_PER_MODEL) throw err;
      const retryAfter = Number(err?.headers?.["retry-after"]);
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(MAX_BACKOFF_MS, retryAfter * 1000)
        : Math.min(MAX_BACKOFF_MS, 2 ** attempt * 500 + Math.random() * 250);
      log.warn(
        { model: modelId, status: err.status, attempt, backoff },
        "anthropic retrying",
      );
      await sleep(backoff);
    }
  }
}

/**
 * Non-streaming completion. Tries each candidate model in order; within
 * each model, retries on 429/529. Only falls through to next model on 404.
 */
async function complete({ system, messages, maxTokens, temperature }) {
  const order = await resolveModelOrder();
  let lastError = null;
  for (const model of order) {
    try {
      const response = await withRetries(
        () =>
          client.messages.create({
            model,
            max_tokens: maxTokens ?? config.anthropic.maxTokens,
            temperature: temperature ?? config.anthropic.temperature,
            system,
            messages,
          }),
        model,
      );
      return {
        text: extractText(response) || "(No text returned)",
        model,
        usage: response.usage || null,
        stop_reason: response.stop_reason,
      };
    } catch (err) {
      lastError = err;
      if (!isModelNotFound(err)) throw err;
      log.warn({ model, status: err.status }, "model not found, trying next");
    }
  }
  throw lastError || new Error("No available Anthropic model.");
}

/**
 * Streaming completion. Yields events:
 *   { type: 'model', model }             once at start
 *   { type: 'delta', text }              0..N text chunks
 *   { type: 'usage', usage }             on completion (includes cache_*_tokens)
 *   { type: 'done', stop_reason }        once at end
 *
 * Note: streaming retries are limited because once tokens have started
 * arriving we can't safely retry without doubling output. We only retry
 * before the first delta lands.
 */
async function* completeStream({ system, messages, maxTokens, temperature }) {
  const order = await resolveModelOrder();
  let lastError = null;
  for (const model of order) {
    try {
      // Pre-stream retry loop: covers connection-establishment errors.
      const stream = await withRetries(
        () =>
          client.messages.stream({
            model,
            max_tokens: maxTokens ?? config.anthropic.maxTokens,
            temperature: temperature ?? config.anthropic.temperature,
            system,
            messages,
          }),
        model,
      );

      yield { type: "model", model };

      for await (const event of stream) {
        if (
          event.type === "content_block_delta" &&
          event.delta?.type === "text_delta" &&
          event.delta.text
        ) {
          yield { type: "delta", text: event.delta.text };
        }
      }

      const finalMessage = await stream.finalMessage();
      if (finalMessage?.usage) {
        yield { type: "usage", usage: finalMessage.usage };
      }
      yield { type: "done", stop_reason: finalMessage?.stop_reason || "end_turn" };
      return;
    } catch (err) {
      lastError = err;
      if (!isModelNotFound(err)) throw err;
      log.warn({ model, status: err.status }, "stream model not found, trying next");
    }
  }
  throw lastError || new Error("No available Anthropic model.");
}

module.exports = {
  complete,
  completeStream,
  resolveModelOrder,
};
