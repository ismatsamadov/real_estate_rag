"use strict";

/**
 * Chat session + message data layer.
 *
 * Single-user demo today: user_id is the value from the auth cookie / config
 * default. When real auth lands (NextAuth + IdP), user_id becomes the
 * subject claim from the JWT and this module needs no changes.
 *
 *   listSessions(userId)
 *   createSession(userId, { title? })
 *   getSession(userId, sessionId)
 *   deleteSession(userId, sessionId)
 *   listMessages(userId, sessionId, { limit? })
 *   appendUserMessage(userId, sessionId, content)        -> { messageId, sessionId, isNewSession }
 *   appendAssistantMessage(userId, sessionId, { content, sources, metadata })
 *   touchSession(userId, sessionId)
 */

const db = require("./db");
const logger = require("./logger");

const log = logger.child({ component: "sessions" });

// Cap on how many recent turns to send to the LLM for context.
// 6 = 3 prior Q+A pairs. Most follow-ups need at most 2.
const HISTORY_LIMIT = 6;

// Title is derived from the first user message. Trim to a sensible length.
function deriveTitle(userMessage) {
  const text = String(userMessage || "").replace(/\s+/g, " ").trim();
  if (!text) return "New chat";
  return text.length > 80 ? text.slice(0, 77) + "…" : text;
}

// -------- Session CRUD --------

async function listSessions(userId) {
  // Filter out "ghost" sessions — ones that were created (e.g. via a PDF
  // upload or by clicking New Chat) but never received a user message.
  // Sidebar would otherwise show "New chat · 0 messages" rows that the
  // user doesn't remember creating. Filtered sessions remain in the DB
  // (cheap and orphaned uploads cascade-delete them automatically) but
  // never pollute the UI.
  const { rows } = await db.pool.query(
    `SELECT s.session_id, s.title, s.created_at, s.updated_at,
            counts.message_count,
            counts.first_question
     FROM ${db.SESSIONS_TABLE} s
     JOIN LATERAL (
       SELECT
         COUNT(*) FILTER (WHERE m.session_id = s.session_id) AS message_count,
         (SELECT m2.content FROM ${db.MESSAGES_TABLE} m2
           WHERE m2.session_id = s.session_id AND m2.role = 'user'
           ORDER BY m2.created_at ASC LIMIT 1) AS first_question
       FROM ${db.MESSAGES_TABLE} m WHERE m.session_id = s.session_id
     ) counts ON TRUE
     WHERE s.user_id = $1 AND counts.message_count > 0
     ORDER BY s.updated_at DESC
     LIMIT 100`,
    [userId],
  );
  return rows;
}

async function createSession(userId, { title } = {}) {
  const { rows } = await db.pool.query(
    `INSERT INTO ${db.SESSIONS_TABLE} (user_id, title)
     VALUES ($1, $2)
     RETURNING session_id, title, created_at, updated_at`,
    [userId, title ?? null],
  );
  return rows[0];
}

async function getSession(userId, sessionId) {
  const { rows } = await db.pool.query(
    `SELECT session_id, user_id, title, created_at, updated_at
     FROM ${db.SESSIONS_TABLE}
     WHERE session_id = $1 AND user_id = $2`,
    [sessionId, userId],
  );
  return rows[0] || null;
}

// Rename a session. Pass `null` (or an empty string) to clear the title —
// the next user message will then auto-derive a new one via appendUserMessage's
// `if (!sess.title)` branch. Returns the updated row, or null if not found.
async function renameSession(userId, sessionId, title) {
  const normalized =
    title == null
      ? null
      : String(title).replace(/\s+/g, " ").trim().slice(0, 200) || null;
  const { rows } = await db.pool.query(
    `UPDATE ${db.SESSIONS_TABLE}
        SET title = $1, updated_at = NOW()
      WHERE session_id = $2 AND user_id = $3
      RETURNING session_id, title, created_at, updated_at`,
    [normalized, sessionId, userId],
  );
  return rows[0] || null;
}

async function deleteSession(userId, sessionId) {
  const { rowCount } = await db.pool.query(
    `DELETE FROM ${db.SESSIONS_TABLE} WHERE session_id = $1 AND user_id = $2`,
    [sessionId, userId],
  );
  return rowCount > 0;
}

async function touchSession(userId, sessionId) {
  await db.pool.query(
    `UPDATE ${db.SESSIONS_TABLE} SET updated_at = NOW()
     WHERE session_id = $1 AND user_id = $2`,
    [sessionId, userId],
  );
}

// -------- Messages --------

async function listMessages(userId, sessionId, { limit } = {}) {
  // Owner check is implicit via a join — never return rows for someone else.
  const { rows } = await db.pool.query(
    `SELECT m.id, m.role, m.content, m.sources, m.metadata, m.created_at
     FROM ${db.MESSAGES_TABLE} m
     JOIN ${db.SESSIONS_TABLE} s ON s.session_id = m.session_id
     WHERE m.session_id = $1 AND s.user_id = $2
     ORDER BY m.created_at ASC
     ${limit ? "LIMIT " + Math.max(1, Number(limit)) : ""}`,
    [sessionId, userId],
  );
  return rows;
}

// History as a token-budget-aware messages array, formatted for Anthropic.
// We return [{ role, content }] — sources from past turns are NOT replayed
// to the LLM (they'd blow the budget); instead the assistant's prior answer
// text carries forward as conversational state.
async function recentHistory(userId, sessionId, { limit = HISTORY_LIMIT } = {}) {
  const { rows } = await db.pool.query(
    `SELECT m.role, m.content
     FROM ${db.MESSAGES_TABLE} m
     JOIN ${db.SESSIONS_TABLE} s ON s.session_id = m.session_id
     WHERE m.session_id = $1 AND s.user_id = $2
     ORDER BY m.created_at DESC
     LIMIT $3`,
    [sessionId, userId, limit],
  );
  // Re-order ascending (oldest first) for the LLM.
  return rows.reverse().map((r) => ({ role: r.role, content: r.content }));
}

async function appendUserMessage(userId, sessionId, content) {
  // If sessionId is missing, create a session on the fly using a title
  // derived from the user's first message. This is the path for the
  // "first turn of a new chat" flow.
  let isNewSession = false;
  let sid = sessionId;
  if (!sid) {
    const created = await createSession(userId, { title: deriveTitle(content) });
    sid = created.session_id;
    isNewSession = true;
  } else {
    // Owner check + lazy title (in case the session was created with no title).
    const sess = await getSession(userId, sid);
    if (!sess) {
      log.warn({ userId, sessionId: sid }, "appendUserMessage: session not found");
      return null;
    }
    if (!sess.title) {
      await db.pool.query(
        `UPDATE ${db.SESSIONS_TABLE} SET title = $1, updated_at = NOW()
         WHERE session_id = $2 AND user_id = $3`,
        [deriveTitle(content), sid, userId],
      );
    }
  }

  const { rows } = await db.pool.query(
    `INSERT INTO ${db.MESSAGES_TABLE} (session_id, role, content)
     VALUES ($1, 'user', $2)
     RETURNING id, created_at`,
    [sid, content],
  );
  await touchSession(userId, sid);
  return {
    messageId: rows[0].id,
    sessionId: sid,
    createdAt: rows[0].created_at,
    isNewSession,
  };
}

async function appendAssistantMessage(userId, sessionId, { content, sources, metadata }) {
  // Owner check (defensive — should already be validated by caller).
  const sess = await getSession(userId, sessionId);
  if (!sess) return null;

  const { rows } = await db.pool.query(
    `INSERT INTO ${db.MESSAGES_TABLE} (session_id, role, content, sources, metadata)
     VALUES ($1, 'assistant', $2, $3::jsonb, $4::jsonb)
     RETURNING id, created_at`,
    [
      sessionId,
      String(content || ""),
      JSON.stringify(sources || null),
      JSON.stringify(metadata || {}),
    ],
  );
  await touchSession(userId, sessionId);
  return { messageId: rows[0].id, createdAt: rows[0].created_at };
}

module.exports = {
  HISTORY_LIMIT,
  deriveTitle,
  listSessions,
  createSession,
  getSession,
  renameSession,
  deleteSession,
  touchSession,
  listMessages,
  recentHistory,
  appendUserMessage,
  appendAssistantMessage,
};
