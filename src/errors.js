"use strict";

/**
 * Centralized error classification for upstream provider errors.
 *
 * Anthropic, Voyage, and Postgres can all surface failures. We want a
 * single function that turns any of those raw errors into a stable
 * { kind, userMessage, devMessage, retryable } shape so:
 *   - The streaming endpoint can emit a friendly SSE error event
 *   - The UI can pick a tone (red warning vs amber "try again" vs blue
 *     info) without parsing strings
 *   - Logs always have a normalized `kind` field for grep/alerting
 *
 * `kind` is one of:
 *   rate_limit         — 429 from Anthropic or Voyage
 *   billing            — out of credits / payment required
 *   auth               — invalid API key / wrong account
 *   permission         — key valid but lacks access to that model / feature
 *   overloaded         — 529 from Anthropic ("we are at capacity, try again")
 *   request_too_large  — prompt + sources exceeded the model context window
 *   model_unavailable  — 404 model not found (after fallback exhausted)
 *   validation         — 400/422 request shape was wrong (almost always our bug)
 *   network            — connection failed / no response from provider
 *   timeout            — request didn't complete in time
 *   aborted            — user-cancelled mid-stream (NOT a real error)
 *   server             — generic 5xx, transient
 *   db                 — Postgres failure (connection, constraint, etc.)
 *   unknown            — couldn't classify; log raw and apologize
 */

const ANTHROPIC_TYPE_TO_KIND = {
  rate_limit_error: "rate_limit",
  authentication_error: "auth",
  permission_error: "permission",
  not_found_error: "model_unavailable",
  invalid_request_error: "validation", // overridden below if billing-related
  request_too_large: "request_too_large",
  api_error: "server",
  overloaded_error: "overloaded",
  billing_error: "billing",
};

const BILLING_PATTERNS = [
  /credit balance is too low/i,
  /your balance is too low/i,
  /insufficient credit/i,
  /quota exceeded/i,
  /payment required/i,
  /billing/i,
];

function looksLikeBilling(err, msg) {
  const text = `${msg || ""} ${err?.error?.error?.message || ""}`;
  return BILLING_PATTERNS.some((re) => re.test(text));
}

function pickAnthropicErrorType(err) {
  // Newer SDK shape: err.error.error.type
  // Older or wrapped: err.error.type
  const inner =
    err?.error?.error?.type ||
    err?.error?.type ||
    null;
  return inner;
}

function pickAnthropicMessage(err) {
  return (
    err?.error?.error?.message ||
    err?.error?.message ||
    err?.message ||
    "Unknown error from upstream provider."
  );
}

/**
 * Classify any thrown error into a stable shape.
 * Always returns a value — never throws.
 */
function classifyError(err) {
  if (!err) {
    return base("unknown", null, false, "Unknown error.", "null/undefined error");
  }

  // User-aborted mid-stream — not an error from the user's POV.
  if (err.name === "AbortError" || err.constructor?.name === "APIUserAbortError") {
    return base("aborted", null, false, "Request cancelled.", err.message);
  }

  // Anthropic SDK errors (have .status + .error JSON body)
  if (typeof err.status === "number" || err.constructor?.name?.endsWith("Error")) {
    const status = err.status ?? null;
    const apiType = pickAnthropicErrorType(err);
    const apiMessage = pickAnthropicMessage(err);

    // Special-case billing — Anthropic returns 400 with type=invalid_request_error
    // and a message that mentions credit balance / payment.
    if (status === 400 && looksLikeBilling(err, apiMessage)) {
      return base(
        "billing",
        status,
        false,
        "The Claude account has run out of credits. Please top up at console.anthropic.com → Billing, then try again.",
        `billing: ${apiMessage}`,
      );
    }

    const kind = ANTHROPIC_TYPE_TO_KIND[apiType] || statusToKind(status);

    switch (kind) {
      case "rate_limit":
        return base(
          "rate_limit",
          status,
          true,
          "Claude is rate-limiting us right now. Please wait a few seconds and try again.",
          `rate_limit: ${apiMessage}`,
        );
      case "auth":
        return base(
          "auth",
          status,
          false,
          "Authentication with Claude failed. The API key may be invalid or revoked. Check ANTHROPIC_API_KEY.",
          `auth: ${apiMessage}`,
        );
      case "permission":
        return base(
          "permission",
          status,
          false,
          "This API key does not have permission to use the requested model. Check the key's scopes in console.anthropic.com.",
          `permission: ${apiMessage}`,
        );
      case "model_unavailable":
        return base(
          "model_unavailable",
          status,
          false,
          "The model is unavailable, and no fallback models worked. Update ANTHROPIC_MODEL_CANDIDATES to a currently-available model.",
          `model_unavailable: ${apiMessage}`,
        );
      case "overloaded":
        return base(
          "overloaded",
          status,
          true,
          "Claude is overloaded right now. This usually clears in under a minute — please try again.",
          `overloaded: ${apiMessage}`,
        );
      case "request_too_large":
        return base(
          "request_too_large",
          status,
          false,
          "The retrieved sources plus the conversation history are too large for the model's context window. Try a shorter question or fewer sources.",
          `request_too_large: ${apiMessage}`,
        );
      case "validation":
        return base(
          "validation",
          status,
          false,
          "The request to Claude was malformed. This is a bug on our side — please retry, or report it if it persists.",
          `validation: ${apiMessage}`,
        );
      case "server":
        return base(
          "server",
          status,
          true,
          "Claude's servers had a transient problem. Please try again in a moment.",
          `server: ${apiMessage}`,
        );
    }
  }

  // Connection / timeout errors from the SDK or undici
  const ctor = err.constructor?.name || "";
  if (ctor === "APIConnectionTimeoutError" || err.code === "ETIMEDOUT" || err.code === "UND_ERR_CONNECT_TIMEOUT") {
    return base(
      "timeout",
      null,
      true,
      "The request to Claude timed out. Please try again.",
      `timeout: ${err.message}`,
    );
  }
  if (ctor === "APIConnectionError" || err.code === "ECONNRESET" || err.code === "ENOTFOUND" || err.code === "ECONNREFUSED") {
    return base(
      "network",
      null,
      true,
      "Couldn't reach Claude. Check your network or try again in a moment.",
      `network: ${err.message}`,
    );
  }

  // Postgres errors carry an err.code like '23505' (unique violation) etc.
  if (typeof err.code === "string" && /^[0-9A-Z]{5}$/.test(err.code)) {
    return base(
      "db",
      null,
      false,
      "A database error occurred. Please retry; if it persists this is a bug on our side.",
      `db ${err.code}: ${err.message}`,
    );
  }

  return base(
    "unknown",
    err.status ?? null,
    false,
    "Something went wrong. Please retry; if the problem persists, sign out and back in.",
    `unknown: ${err.message || String(err)}`,
  );
}

function statusToKind(status) {
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limit";
  if (status === 401) return "auth";
  if (status === 403) return "permission";
  if (status === 404) return "model_unavailable";
  if (status === 413) return "request_too_large";
  if (status === 422) return "validation";
  if (status === 529) return "overloaded";
  if (typeof status === "number" && status >= 500) return "server";
  if (typeof status === "number" && status >= 400) return "validation";
  return "unknown";
}

function base(kind, status, retryable, userMessage, devMessage) {
  return { kind, status, retryable, userMessage, devMessage };
}

module.exports = {
  classifyError,
};
