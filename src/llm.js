"use strict";

const Anthropic = require("@anthropic-ai/sdk");
const config = require("./config");
const logger = require("./logger");

const log = logger.child({ component: "llm" });

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

let modelOrderPromise = null;

function isModelNotFound(err) {
  return err?.status === 404 || err?.error?.type === "not_found_error";
}

async function resolveModelOrder() {
  if (modelOrderPromise) return modelOrderPromise;
  modelOrderPromise = (async () => {
    let listed = [];
    try {
      const response = await client.models.list();
      const ids = Array.isArray(response?.data)
        ? response.data.map((m) => m.id).filter(Boolean)
        : [];
      // Prefer sonnet > haiku within listed models, but trust env order first.
      listed = ids;
    } catch (err) {
      log.debug({ err: err.message }, "models.list failed; relying on env order");
    }
    const seen = new Set();
    const order = [];
    for (const id of [config.anthropic.defaultModel, ...config.anthropic.candidateModels, ...listed]) {
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

/**
 * Non-streaming completion. Tries each candidate model in order and only
 * falls through on 404 / not_found_error so we don't paper over real errors.
 */
async function complete({ system, messages, maxTokens, temperature }) {
  const order = await resolveModelOrder();
  let lastError = null;
  for (const model of order) {
    try {
      const response = await client.messages.create({
        model,
        max_tokens: maxTokens ?? config.anthropic.maxTokens,
        temperature: temperature ?? config.anthropic.temperature,
        system,
        messages,
      });
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
 * Streaming completion. Yields {type, ...} events:
 *   - { type: 'model', model }            once
 *   - { type: 'delta', text }             zero or more text chunks
 *   - { type: 'usage', usage }            optional, on completion
 *   - { type: 'done', stop_reason }       once
 */
async function* completeStream({ system, messages, maxTokens, temperature }) {
  const order = await resolveModelOrder();
  let lastError = null;
  for (const model of order) {
    try {
      const stream = await client.messages.stream({
        model,
        max_tokens: maxTokens ?? config.anthropic.maxTokens,
        temperature: temperature ?? config.anthropic.temperature,
        system,
        messages,
      });

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
      yield {
        type: "done",
        stop_reason: finalMessage?.stop_reason || "end_turn",
      };
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
