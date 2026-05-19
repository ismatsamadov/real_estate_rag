"use strict";

/**
 * Persistent user-intent profile.
 *
 * Pattern: two-tier context.
 *
 *   Tier 1 — Structured signals (deterministic, computed every turn via SQL):
 *     - favorites:     listings the user has explicitly saved
 *     - recentTopics:  most-recent grounded Q+A questions
 *     - uploads:       PDFs the user has brought into any session
 *     - counts:        how much data we have on this user
 *
 *   Tier 2 — LLM-synthesized intent summary (cached in `user_profile`):
 *     A 1-2 sentence "what this user is shopping for" that captures the
 *     synthesis SQL can't produce ("interested in 2-bedroom apartments in
 *     the $400-600k range at Knightsbridge or St Regis, frequently asks in
 *     Azerbaijani"). Regenerated lazily in the background when signal counts
 *     drift past the basis stored when the summary was last written.
 *
 * Why two tiers?
 *   - Signals are always fresh and need no LLM call → safe per-turn read.
 *   - Summary captures intent the model can use directly ("you previously
 *     mentioned a 2BR preference; here's the closest match…") and is the
 *     difference between "RAG with memory" and "the LLM knows who I am."
 *
 * Refresh policy:
 *   maybeRefreshProfile() runs AFTER the response stream completes so it
 *   never blocks the user. Refresh fires when:
 *     - the user has at least one signal (memory/favorite/upload), AND
 *     - basis counts differ from current counts (something changed), AND
 *     - either >=3 new signals OR >60s since last refresh
 *   This keeps refresh cost bounded under heavy use while staying responsive
 *   for first-time interactions.
 */

const db = require("./db");
const config = require("./config");
const logger = require("./logger");
const { complete } = require("./llm");

const log = logger.child({ component: "profile" });

const RECENT_TOPICS_LIMIT = 8;
const FAVORITES_LIMIT = 8;
const UPLOADS_LIMIT = 6;

// Refresh throttling — keep the Haiku spend bounded.
const REFRESH_MIN_INTERVAL_MS = 60_000;
const REFRESH_DELTA_THRESHOLD = 3;

const SUMMARIZER_SYSTEM = [
  "You write a concise intent profile for a real-estate search user.",
  "Output 1-2 sentences (max ~300 characters) describing what this user appears to be looking for,",
  "based on their saved listings, recent questions, and uploaded documents.",
  "",
  "Rules:",
  "- Write in plain declarative English (the assistant reads this, not the user).",
  "- Capture: property types, locations/projects, bedroom counts, price ranges, languages used,",
  "  document types they're researching — whichever are evidenced.",
  "- If signals are thin, be honest: 'Browsing the catalog; no strong preferences yet.'",
  "- Never invent preferences not supported by the signals.",
  "- No bullet points, no headers, no quotes — just the profile sentence(s).",
].join("\n");

/**
 * Read the full user context for prompt injection.
 *
 * Returns:
 *   {
 *     summary:            string | null,
 *     summaryRefreshedAt: ISO string | null,
 *     favorites:          [{title, url, note, created_at}],
 *     recentTopics:       string[],
 *     uploads:            [{title, total_pages}],
 *     counts:             {memory_n, favorite_n, upload_n},
 *   }
 *
 * All five queries run in parallel; total wall time ≈ slowest single query.
 */
async function getUserContext(userId) {
  if (!userId) return emptyContext();

  const [profileRes, favoritesRes, topicsRes, uploadsRes, countsRes] =
    await Promise.all([
      db.pool.query(
        `SELECT summary, refreshed_at FROM ${db.USER_PROFILE_TABLE} WHERE user_id = $1`,
        [userId],
      ),
      db.pool.query(
        `SELECT d.title, d.url, f.note, f.created_at
           FROM ${db.FAVORITES_TABLE} f
           JOIN ${db.DOCS_TABLE} d ON d.doc_id = f.doc_id
          WHERE f.user_id = $1
          ORDER BY f.created_at DESC
          LIMIT $2`,
        [userId, FAVORITES_LIMIT],
      ),
      db.pool.query(
        `SELECT metadata->>'question' AS question, created_at
           FROM ${db.MEMORY_TABLE}
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT $2`,
        [userId, RECENT_TOPICS_LIMIT],
      ),
      // DISTINCT ON dedupes by filename across re-uploads.
      db.pool.query(
        `SELECT DISTINCT ON (d.title)
                d.title,
                (d.metadata->>'total_pages')::int AS total_pages,
                d.updated_at
           FROM ${db.DOCS_TABLE} d
           JOIN ${db.SESSIONS_TABLE} s
             ON s.session_id = d.session_id AND s.user_id = $1
          WHERE d.doc_type = 'upload'
          ORDER BY d.title, d.updated_at DESC
          LIMIT $2`,
        [userId, UPLOADS_LIMIT],
      ),
      db.pool.query(
        `SELECT
           (SELECT COUNT(*) FROM ${db.MEMORY_TABLE} WHERE user_id = $1)::int AS memory_n,
           (SELECT COUNT(*) FROM ${db.FAVORITES_TABLE} WHERE user_id = $1)::int AS favorite_n,
           (SELECT COUNT(*) FROM ${db.DOCS_TABLE} d
              JOIN ${db.SESSIONS_TABLE} s ON s.session_id = d.session_id AND s.user_id = $1
              WHERE d.doc_type = 'upload')::int AS upload_n`,
        [userId],
      ),
    ]);

  return {
    summary: profileRes.rows[0]?.summary || null,
    summaryRefreshedAt: profileRes.rows[0]?.refreshed_at || null,
    favorites: favoritesRes.rows.map((r) => ({
      title: r.title,
      url: r.url,
      note: r.note,
      created_at: r.created_at,
    })),
    recentTopics: topicsRes.rows
      .map((r) => String(r.question || "").trim())
      .filter(Boolean),
    uploads: uploadsRes.rows.map((r) => ({
      title: r.title,
      total_pages: r.total_pages,
      uploaded_at: r.updated_at,
    })),
    counts: countsRes.rows[0] || { memory_n: 0, favorite_n: 0, upload_n: 0 },
  };
}

function emptyContext() {
  return {
    summary: null,
    summaryRefreshedAt: null,
    favorites: [],
    recentTopics: [],
    uploads: [],
    counts: { memory_n: 0, favorite_n: 0, upload_n: 0 },
  };
}

/**
 * Fire-and-forget refresh trigger. Called after the response stream ends so
 * the user never waits on it. Returns a promise the caller can ignore.
 */
function maybeRefreshProfile(userId) {
  if (!userId) return Promise.resolve();
  // Don't return the promise to the caller — they should NOT await this.
  // Errors are logged, never thrown.
  refreshIfStale(userId).catch((err) => {
    log.warn({ err: err.message, userId }, "background profile refresh failed");
  });
  return Promise.resolve();
}

async function refreshIfStale(userId) {
  const ctx = await getUserContext(userId);
  if (
    ctx.counts.memory_n === 0 &&
    ctx.counts.favorite_n === 0 &&
    ctx.counts.upload_n === 0
  ) {
    return { refreshed: false, reason: "no_signals" };
  }

  // Compare against the row's stored basis counts.
  const basisRes = await db.pool.query(
    `SELECT basis_memory_n, basis_favorite_n, basis_upload_n, refreshed_at
       FROM ${db.USER_PROFILE_TABLE}
      WHERE user_id = $1`,
    [userId],
  );
  const basis = basisRes.rows[0];

  const delta = basis
    ? Math.abs(ctx.counts.memory_n - basis.basis_memory_n) +
      Math.abs(ctx.counts.favorite_n - basis.basis_favorite_n) +
      Math.abs(ctx.counts.upload_n - basis.basis_upload_n)
    : ctx.counts.memory_n + ctx.counts.favorite_n + ctx.counts.upload_n;

  if (delta === 0) return { refreshed: false, reason: "no_change" };

  const ageMs = basis
    ? Date.now() - new Date(basis.refreshed_at).getTime()
    : Infinity;

  // Refresh if a lot has changed, OR enough time has passed for incremental change.
  if (delta < REFRESH_DELTA_THRESHOLD && ageMs < REFRESH_MIN_INTERVAL_MS) {
    return { refreshed: false, reason: "throttled" };
  }

  await doRefresh(userId, ctx);
  return { refreshed: true };
}

async function doRefresh(userId, ctx) {
  const userBlock = buildSummarizerInput(ctx);
  let summary = null;
  try {
    const { text } = await complete({
      system: [{ type: "text", text: SUMMARIZER_SYSTEM }],
      messages: [{ role: "user", content: userBlock }],
      maxTokens: 200,
      temperature: 0.2,
    });
    summary = String(text || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 600);
  } catch (err) {
    log.warn({ err: err.message, userId }, "summarizer call failed");
    summary = null;
  }

  if (!summary) return;

  await db.pool.query(
    `INSERT INTO ${db.USER_PROFILE_TABLE}
       (user_id, summary, basis_memory_n, basis_favorite_n, basis_upload_n, refreshed_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       summary           = EXCLUDED.summary,
       basis_memory_n    = EXCLUDED.basis_memory_n,
       basis_favorite_n  = EXCLUDED.basis_favorite_n,
       basis_upload_n    = EXCLUDED.basis_upload_n,
       refreshed_at      = NOW(),
       updated_at        = NOW()`,
    [
      userId,
      summary,
      ctx.counts.memory_n,
      ctx.counts.favorite_n,
      ctx.counts.upload_n,
    ],
  );
  log.info(
    {
      userId,
      memory_n: ctx.counts.memory_n,
      favorite_n: ctx.counts.favorite_n,
      upload_n: ctx.counts.upload_n,
      chars: summary.length,
    },
    "user profile refreshed",
  );
}

function buildSummarizerInput(ctx) {
  const lines = [];
  lines.push(
    `Signals collected (${ctx.counts.memory_n} prior grounded Q&A, ${ctx.counts.favorite_n} saved listings, ${ctx.counts.upload_n} uploaded docs):`,
  );
  lines.push("");
  if (ctx.favorites.length) {
    lines.push("Saved listings:");
    for (const f of ctx.favorites) lines.push(`- ${f.title}${f.note ? ` (note: ${f.note})` : ""}`);
    lines.push("");
  }
  if (ctx.recentTopics.length) {
    lines.push("Recent questions (most recent first):");
    for (const q of ctx.recentTopics.slice(0, RECENT_TOPICS_LIMIT)) {
      lines.push(`- ${q.slice(0, 160)}`);
    }
    lines.push("");
  }
  if (ctx.uploads.length) {
    lines.push("Uploaded documents:");
    for (const u of ctx.uploads) {
      lines.push(`- ${u.title}${u.total_pages ? ` (${u.total_pages} pages)` : ""}`);
    }
    lines.push("");
  }
  lines.push("Write the intent profile now.");
  return lines.join("\n");
}

/**
 * Forced refresh — used by POST /api/profile/refresh and manual scripts.
 * Bypasses throttling.
 */
async function forceRefresh(userId) {
  if (!userId) return null;
  const ctx = await getUserContext(userId);
  await doRefresh(userId, ctx);
  return getUserContext(userId);
}

async function clearProfile(userId) {
  const { rowCount } = await db.pool.query(
    `DELETE FROM ${db.USER_PROFILE_TABLE} WHERE user_id = $1`,
    [userId],
  );
  return rowCount;
}

module.exports = {
  getUserContext,
  maybeRefreshProfile,
  forceRefresh,
  clearProfile,
};
