"use strict";

/**
 * Cross-session conversation memory.
 *
 * Pattern: RAG-over-conversation-history. After each turn we embed the
 * user-question + assistant-answer pair and persist it. When a new query
 * comes in, we vector-search prior memory (from OTHER sessions, to avoid
 * double-counting in-session history that's already in the LLM messages
 * array) and inject the top-K hits as `[M1..Mn]` references in the prompt.
 *
 * Why pairs (Q+A) instead of just answers?
 *   - The question phrasing captures user intent / vocabulary;
 *   - The answer captures the resolved facts.
 *   - Together they retrieve well for both intent-similar and fact-similar
 *     queries.
 *
 * Memory rules in the prompt:
 *   - Memories are advisory CONTINUITY context, not citable facts.
 *   - Factual claims still cite [Sn] corpus sources.
 *   - Memory may be referenced as "you previously asked about X" or
 *     "earlier we discussed Y."
 */

const config = require("./config");
const db = require("./db");
const logger = require("./logger");
const { embed, toVectorLiteral } = require("./embedder");

const log = logger.child({ component: "memory" });

// How many memory chunks to recall per query.
const RECALL_TOP_K = 3;
// Per-memory content cap (chars) to keep the prompt budget sane.
const MEMORY_CHAR_CAP = 700;
// Recency boost — newer memories get a small additive bonus in scoring.
// half-life ~14 days. Tuned for chat (not for stable knowledge).
const RECENCY_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;

function truncate(text, max = MEMORY_CHAR_CAP) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// Refusal / no-context / chitchat detection — anything that matches should
// NOT pollute long-term memory. Patterns intentionally cover EN / AZ / RU
// and the common Claude refusal phrasings.
const REFUSAL_RE =
  /\b(i (?:am )?(?:sorry|unable|cannot|can't|don't have|do not have)|i'm (?:sorry|unable|afraid)|could not find|cannot find|no (?:relevant|information|info|matches?)|not (?:in the (?:provided )?sources?|in the available|mentioned|listed|available)|the (?:provided )?sources? (?:do not|don't) (?:contain|mention|include)|insufficient (?:sources|information)|no data|i'm just a|i am (?:a|the) (?:real estate|research)|please contact|out of scope)/i;
const RU_REFUSAL_RE =
  /\b(не содержат|не имею|извините|не могу|нет информации|нет данных|вне (?:моих|компетенции))/i;
const AZ_REFUSAL_RE =
  /\b(üzr istəyirəm|məlumat yoxdur|tapa bilmirəm|kömək edə bilmirəm)/i;

// Short, low-signal questions ("hi", "thanks", "ok") shouldn't trigger
// embedding spend or pollute memory.
const CHITCHAT_RE =
  /^(hi|hello|hey|thanks|thank you|ok(?:ay)?|cool|nice|got it|sure|yes|no|yep|nope|sağol|təşəkkür|спасибо|привет|здравствуйте)[!.\s]*$/i;

function shouldPersistMemory(question, answer) {
  const q = String(question || "").trim();
  const a = String(answer || "").trim();
  if (!q || !a) return { keep: false, reason: "empty" };
  if (q.length < 8) return { keep: false, reason: "question_too_short" };
  if (CHITCHAT_RE.test(q)) return { keep: false, reason: "chitchat" };
  if (a.length < 80) return { keep: false, reason: "answer_too_short" };
  // Refusal detection on the first 500 chars (covers EN + AZ + RU phrasings).
  const head = a.slice(0, 500);
  if (REFUSAL_RE.test(head) || RU_REFUSAL_RE.test(head) || AZ_REFUSAL_RE.test(head)) {
    return { keep: false, reason: "refusal" };
  }
  // Strongest positive signal: did the model actually cite sources? A real
  // grounded answer almost always carries [S1]..[Sn].
  if (!/\[S\d+\]/.test(a)) return { keep: false, reason: "no_citations" };
  return { keep: true, reason: "ok" };
}

/**
 * Build the memory chunk content from a Q+A pair. We keep the Q distinct
 * from the A so future retrieval matches against both intents.
 */
function formatPair(question, answer) {
  return [
    `Q: ${truncate(question, MEMORY_CHAR_CAP)}`,
    `A: ${truncate(answer, MEMORY_CHAR_CAP)}`,
  ].join("\n");
}

/**
 * Persist a memory row. Best-effort — failures are logged but never thrown
 * (memory is non-critical to the user-facing response).
 */
async function appendMemory(userId, { sessionId, messageId, question, answer }) {
  const decision = shouldPersistMemory(question, answer);
  if (!decision.keep) {
    log.debug({ reason: decision.reason, userId }, "memory skipped");
    return { persisted: false, reason: decision.reason };
  }
  try {
    const content = formatPair(question, answer);
    const vec = await embed(content, "document");
    await db.pool.query(
      `INSERT INTO ${db.MEMORY_TABLE} (user_id, session_id, message_id, content, embedding, metadata)
       VALUES ($1, $2, $3, $4, $5::vector, $6::jsonb)`,
      [
        userId,
        sessionId || null,
        messageId || null,
        content,
        toVectorLiteral(vec),
        JSON.stringify({
          question: truncate(question, 200),
          answer_preview: truncate(answer, 200),
        }),
      ],
    );
    return { persisted: true };
  } catch (err) {
    log.warn({ err: err.message, userId }, "appendMemory failed");
    return { persisted: false, reason: "error" };
  }
}

/**
 * Recall the most relevant memories from this user's prior sessions.
 *
 *   - excludeSessionId: do not return memories from the current session.
 *   - topK: hard cap on rows returned.
 *
 * Score = cosine similarity + small recency boost. Recency uses an
 * exponential decay so a 14-day-old memory is worth ~0.05 less than today.
 */
async function recallMemory(userId, query, { excludeSessionId, topK = RECALL_TOP_K } = {}) {
  if (!userId || !query) return [];
  let qv;
  try {
    qv = await embed(query, "query");
  } catch (err) {
    log.warn({ err: err.message }, "recall embed failed");
    return [];
  }

  const sql = `
    SELECT id, session_id, content, metadata, created_at,
           1 - (embedding <=> $1::vector) AS similarity,
           EXTRACT(EPOCH FROM (NOW() - created_at)) * 1000 AS age_ms
    FROM ${db.MEMORY_TABLE}
    WHERE user_id = $2
      AND ($3::uuid IS NULL OR session_id IS DISTINCT FROM $3::uuid)
    ORDER BY embedding <=> $1::vector
    LIMIT $4::int
  `;
  // candidate_k slightly wider than topK so the recency rerank below has
  // room to reorder borderline ties.
  const candidateK = Math.max(topK * 3, topK + 2);
  const { rows } = await db.pool.query(sql, [
    toVectorLiteral(qv),
    userId,
    excludeSessionId || null,
    candidateK,
  ]);

  const scored = rows.map((r) => {
    const sim = Number(r.similarity) || 0;
    const ageMs = Number(r.age_ms) || 0;
    const recency = Math.exp(-ageMs / RECENCY_HALF_LIFE_MS); // 0..1, newer=higher
    return {
      ...r,
      sim,
      recency,
      score: sim + 0.08 * recency, // small boost; similarity dominates
    };
  });
  scored.sort((a, b) => b.score - a.score);
  // Hard threshold so weak matches don't pollute the prompt. 0.42 is a
  // pragmatic cut from looking at hits/misses on our corpus.
  return scored
    .filter((r) => r.sim >= 0.42)
    .slice(0, topK)
    .map((r, i) => ({
      mid: `M${i + 1}`,
      memory_id: Number(r.id),
      session_id: r.session_id,
      content: r.content,
      created_at: r.created_at,
      similarity: r.sim,
      recency: r.recency,
      score: r.score,
    }));
}

/**
 * Wipe all memory for a user. Surfaced as POST /api/memory/clear.
 */
async function clearMemory(userId) {
  const { rowCount } = await db.pool.query(
    `DELETE FROM ${db.MEMORY_TABLE} WHERE user_id = $1`,
    [userId],
  );
  return rowCount;
}

async function memoryStats(userId) {
  const { rows } = await db.pool.query(
    `SELECT COUNT(*)::int AS total,
            MAX(created_at) AS newest,
            MIN(created_at) AS oldest
     FROM ${db.MEMORY_TABLE}
     WHERE user_id = $1`,
    [userId],
  );
  return rows[0] || { total: 0, newest: null, oldest: null };
}

module.exports = {
  RECALL_TOP_K,
  appendMemory,
  recallMemory,
  clearMemory,
  memoryStats,
  // Exported for tests / debugging.
  shouldPersistMemory,
};
