"use strict";

/**
 * Prompt assembly for grounded RAG.
 *
 * Design choices:
 *   - System prompt is constant + small, wrapped with `cache_control:
 *     ephemeral` so repeat queries hit Anthropic's prompt cache. Cache
 *     savings show up in `usage.cache_read_input_tokens`.
 *   - Each source carries a structured header (sid, doc_type, language,
 *     extracted listing facts) BEFORE the content. The model learns to
 *     ground citations to facts, not loose text, and structured headers
 *     consume few tokens.
 *   - The citation contract is explicit and ordered: cite only sources
 *     present, never invent facts, flag insufficiency.
 */

const SYSTEM_PROMPT = [
  "You are a careful real-estate research assistant for PASHA Real Estate (Baku, Azerbaijan).",
  "You answer strictly from the SOURCES provided in the user message.",
  "",
  "Citation contract:",
  "1. Every factual claim ends with one or more citation markers like [S1] or [S2][S3].",
  "2. Cite only sources that directly support the claim. Do not pad citations.",
  "3. If the sources are insufficient or contradict each other, say so explicitly and cite the relevant sources.",
  "4. Do not use outside knowledge. If a fact is not in the sources, do not claim it.",
  "5. If a source's extracted_facts (price, bedrooms, area) contradicts its body text, prefer the body text and note the discrepancy.",
  "",
  "ROOM TERMINOLOGY (IMPORTANT — do not conflate these):",
  "- AZ \"otaqlı\" and RU \"комнатная\" mean TOTAL rooms in the unit (typically including the living room).",
  "- AZ \"yataq otaqlı\", RU \"спальня\", and EN \"bedroom\" mean BEDROOMS specifically.",
  "- A \"3 otaqlı\" / \"3-комнатная\" unit usually has 2 bedrooms + 1 living room — it is NOT a 3-bedroom unit.",
  "- When the user asks in AZ/RU using \"otaqlı\" / \"комнатная\" without \"yataq\" / \"спальня\", match listings by TOTAL rooms, not bedrooms. If the listing only reports bedrooms, say so explicitly and do not silently translate.",
  "- Never translate \"3 otaqlı\" as \"3 bedrooms\" in EN output, nor \"3-bedroom\" as \"3 otaqlı\" in AZ output. Use \"3 rooms\" / \"3-room\" for the total-rooms concept in EN.",
  "",
  "Style:",
  "- Concise, structured answers. Short paragraphs or bullet lists.",
  "- Quote currencies, project names, addresses, and amenities exactly as they appear.",
  "- Do not include URLs in your answer body — citation markers map to the sources panel.",
  "- Match the language of the user's question when possible (EN / AZ / RU).",
  "- Never invent property names, prices, square meters, completion dates, or amenities.",
].join("\n");

function fmtFacts(meta) {
  if (!meta || typeof meta !== "object") return "";
  const parts = [];
  if (meta.price != null) parts.push(`price=${meta.price}${meta.currency ? " " + meta.currency : ""}`);
  if (meta.bedrooms != null) parts.push(`bedrooms=${meta.bedrooms}`);
  if (meta.bathrooms != null) parts.push(`bathrooms=${meta.bathrooms}`);
  if (meta.area_sqm != null) parts.push(`area_sqm=${meta.area_sqm}`);
  if (meta.property_type) parts.push(`property_type=${meta.property_type}`);
  if (meta.listing_type) parts.push(`listing_type=${meta.listing_type}`);
  if (meta.location) parts.push(`location="${meta.location}"`);
  return parts.length ? ` extracted_facts={${parts.join(", ")}}` : "";
}

function buildSourcesBlock(sources) {
  return sources
    .map((s) => {
      const meta = s.metadata || {};
      const docType = meta.doc_type || "doc";
      const language = meta.language || "en";
      const url = s.url || "";
      const facts = fmtFacts(meta);
      const header = `[${s.sid}] type=${docType} lang=${language}${facts} url=${url}`;
      return `${header}\n${s.content}`;
    })
    .join("\n\n---\n\n");
}

/**
 * Build messages for Anthropic. System block is cached; user message
 * carries the question + sources.
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
