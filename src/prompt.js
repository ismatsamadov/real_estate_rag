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
  "MEMORY vs SOURCES vs USER PROFILE (do not confuse these):",
  "- [Sn] markers refer to RETRIEVED CORPUS SOURCES for the current turn. Every factual claim cites [Sn].",
  "- [Mn] markers (if present) are RECALLED MEMORIES from this user's prior sessions. They are continuity context only — you may say \"earlier you asked about X\" or \"as we discussed before\", but NEVER cite [Mn] as evidence for a fact. Facts must still cite [Sn].",
  "- USER PROFILE block (if present) summarizes this user's standing intent — saved listings, recent topics, uploaded documents, and an inferred summary. It is PERSONALIZATION CONTEXT — proactively reference it when relevant (\"since you saved Knightsbridge 2BR…\", \"matching your 2-bedroom focus…\") but NEVER cite it as evidence for a fact. Facts must still cite [Sn].",
  "- If memory or profile contradicts the current sources, the sources win.",
  "- If the user asks \"what did we talk about?\" / \"what am I looking for?\" / \"remember when…\", you may summarize from [Mn] and the profile without [Sn] citations.",
  "",
  "ROOM TERMINOLOGY (CRITICAL — read carefully, this trips up most assistants):",
  "- AZ \"otaqlı\" and RU \"комнатная\" mean TOTAL rooms (living room counted).",
  "- AZ \"yataq otaqlı\", RU \"спальня\", and EN \"bedroom\" mean BEDROOMS only.",
  "- Conversion table (post-Soviet real-estate convention):",
  "    1 otaqlı   = 0 bedroom (studio)",
  "    2 otaqlı   = 1 bedroom",
  "    3 otaqlı   = 2 bedrooms",
  "    4 otaqlı   = 3 bedrooms",
  "    5 otaqlı   = 4 bedrooms",
  "  Same table applies to RU \"комнатная\".",
  "",
  "When the user asks \"X otaqlı\" / \"X-комнатная\" WITHOUT the word \"yataq\" / \"спальня\":",
  "  1. The matching listings are those with bedrooms = X − 1 (one less than the asked number).",
  "  2. Surface those listings as the primary answer. Example: user asks \"3 otaqlı\" → show 2-bedroom units.",
  "  3. If no listing matches bedrooms = X − 1, say so explicitly. Do NOT silently substitute a listing with bedrooms = X — that would be answering a different question.",
  "  4. You may offer adjacent matches (\"no 2-bedroom listings, but there are 1-bedroom and 3-bedroom options\") but label them clearly as adjacent, not exact.",
  "  5. Always state the conversion you applied so the user can verify: e.g. \"You asked for 3 otaqlı (3 rooms total = 2 bedrooms + 1 living). The 2-bedroom matches are:\"",
  "",
  "When the user explicitly says \"X yataq otaqlı\", \"X спальни\", or \"X-bedroom\":",
  "  - Match listings with bedrooms = X exactly. No conversion.",
  "",
  "Never translate \"3 otaqlı\" as \"3 bedrooms\" in EN output, nor \"3-bedroom\" as \"3 otaqlı\" in AZ output. Use \"3 rooms\" / \"3-room\" for the total-rooms concept in EN.",
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
 * The standing intent profile. Read every turn, injected above sources.
 * Compact by design (capped at ~12 favorites + ~5 topics + ~5 uploads).
 * Returns an empty string if there is nothing to say about the user.
 */
function buildUserProfileBlock(userContext) {
  if (!userContext) return "";
  const { summary, favorites, recentTopics, uploads, counts } = userContext;
  if (!summary && !favorites?.length && !recentTopics?.length && !uploads?.length) {
    return "";
  }
  const lines = [
    "USER PROFILE (personalization context — proactively reference when relevant; NOT citable as a factual source):",
  ];
  if (summary) {
    lines.push(`Intent: ${summary}`);
  }
  if (favorites?.length) {
    lines.push(
      `Saved listings (${counts?.favorite_n ?? favorites.length}): ` +
        favorites
          .slice(0, 12)
          .map((f) => f.title)
          .join(" · "),
    );
  }
  if (recentTopics?.length) {
    lines.push("Recent topics:");
    for (const q of recentTopics.slice(0, 5)) {
      lines.push(`  - ${q.slice(0, 140)}`);
    }
  }
  if (uploads?.length) {
    lines.push(
      `Uploaded docs: ` +
        uploads
          .slice(0, 5)
          .map((u) => (u.total_pages ? `${u.title} (${u.total_pages}p)` : u.title))
          .join(" · "),
    );
  }
  return lines.join("\n");
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
function buildMessages(question, sources, { history, memories, userContext } = {}) {
  const sourcesBlock = buildSourcesBlock(sources);
  const memoriesBlock = buildMemoriesBlock(memories);
  const profileBlock = buildUserProfileBlock(userContext);
  // Order in the user message:
  //   1. user profile (who they are)
  //   2. recalled memories (what they discussed before)
  //   3. current question
  //   4. retrieved sources for this turn
  // Profile first means the model frames the question against the user's
  // standing intent before reading the sources.
  const userText = [
    profileBlock,
    profileBlock ? "" : null,
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
