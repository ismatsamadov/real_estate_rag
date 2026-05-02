"use strict";

const SYSTEM_PROMPT = [
  "You are a careful real-estate research assistant.",
  "You answer strictly from the SOURCES provided in the user message.",
  "",
  "Citation contract:",
  "1. Every factual claim ends with one or more citation markers like [S1] or [S2][S3].",
  "2. Cite only sources that directly support the claim. Do not pad citations.",
  "3. If the sources are insufficient or contradict each other, say so explicitly and cite the relevant sources.",
  "4. Do not use outside knowledge. If a fact is not in the sources, do not claim it.",
  "",
  "Style:",
  "- Prefer concise, structured answers. Use short paragraphs or bullet lists where helpful.",
  "- Quote currencies, project names, addresses, and amenities exactly as they appear in the sources.",
  "- Do not include URLs in your answer body — citation markers map to the sources panel.",
  "- Never invent property names, prices, square meters, or completion dates.",
].join("\n");

function buildSourcesBlock(sources) {
  return sources
    .map((s) => {
      const title = s.metadata?.title || "Untitled";
      const pageKind = s.metadata?.pageKind || "unknown";
      const url = s.metadata?.sourceURL || s.url || "";
      const header = `[${s.sid}] title="${title}" page_kind=${pageKind} url=${url}`;
      return `${header}\n${s.content}`;
    })
    .join("\n\n---\n\n");
}

/**
 * Build the message payload for Anthropic. The system prompt is sent as a
 * structured content array with cache_control so that prompt caching can
 * hit on repeat questions without changing the citation contract.
 */
function buildMessages(question, sources) {
  const sourcesBlock = buildSourcesBlock(sources);
  const userText = [
    `Question: ${question}`,
    "",
    "Sources:",
    sourcesBlock,
  ].join("\n");

  return {
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: userText }],
  };
}

module.exports = {
  SYSTEM_PROMPT,
  buildMessages,
  buildSourcesBlock,
};
