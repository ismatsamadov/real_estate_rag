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
  "MEMORY vs SOURCES (do not confuse these):",
  "- [Sn] markers refer to RETRIEVED CORPUS SOURCES for the current turn. Every factual claim cites [Sn].",
  "- [Mn] markers (if present) are RECALLED MEMORIES from this user's prior sessions. They are continuity context only — you may say \"earlier you asked about X\" or \"as we discussed before\", but NEVER cite [Mn] as evidence for a fact. Facts must still cite [Sn].",
  "- If a memory contradicts the current sources, the sources win.",
  "- If the user asks \"what did we talk about?\" or \"remember when…\", you may summarize from [Mn] without citing [Sn].",
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

function buildMemoriesBlock(memories) {
  if (!Array.isArray(memories) || memories.length === 0) return "";
  const lines = memories.map((m) => {
    const when = m.created_at ? new Date(m.created_at).toISOString().slice(0, 10) : "earlier";
    return `[${m.mid}] (${when}) ${m.content}`;
  });
  return [
    "Recalled from this user's previous conversations (advisory continuity context — NOT citable as facts):",
    ...lines,
  ].join("\n");
}

/**
 * Build messages for Anthropic. System block is cached; user message
 * carries the question + sources + optional memories.
 *
 * `history` is an optional ordered list of prior turns within the SAME
 * session — [{role:"user"|"assistant", content:"..."}]. The assistant's
 * prior answer text carries forward as conversational state; sources from
 * past turns are NOT replayed (would blow the budget).
 *
 * `memories` is an optional list of recalled memory chunks from OTHER
 * sessions ({mid, content, created_at, similarity}). These are continuity
 * cues for the model (e.g. "the user previously asked about X") and must
 * NOT be cited as factual sources — facts still come from `[Sn]` corpus.
 *
 * For the current turn we always append a fresh user message with the
 * just-retrieved sources, so each generation is grounded against fresh
 * retrieval rather than stale chunks from older turns.
 */
function buildMessages(question, sources, { history, memories } = {}) {
  const sourcesBlock = buildSourcesBlock(sources);
  const memoriesBlock = buildMemoriesBlock(memories);
  const userText = [
    memoriesBlock,
    memoriesBlock ? "" : null,
    `Question: ${question}`,
    "",
    "Sources:",
    sourcesBlock,
  ]
    .filter((line) => line !== null && line !== "")
    .join("\n");

  const historyMsgs = Array.isArray(history)
    ? history
        .filter(
          (m) =>
            m &&
            (m.role === "user" || m.role === "assistant") &&
            typeof m.content === "string" &&
            m.content.trim(),
        )
        // Anthropic requires strict role alternation; drop any consecutive
        // duplicates defensively.
        .reduce((acc, m) => {
          if (acc.length && acc[acc.length - 1].role === m.role) return acc;
          acc.push({ role: m.role, content: m.content });
          return acc;
        }, [])
    : [];

  // If history ends on a user turn (in-flight), drop it so the new user
  // message below isn't a back-to-back user role.
  while (historyMsgs.length && historyMsgs[historyMsgs.length - 1].role === "user") {
    historyMsgs.pop();
  }

  return {
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [...historyMsgs, { role: "user", content: userText }],
  };
}

module.exports = {
  SYSTEM_PROMPT,
  buildMessages,
  buildSourcesBlock,
};
