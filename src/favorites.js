"use strict";

/**
 * Per-user saved listings ("favorites" / "hearts").
 *
 * Pattern: thin CRUD over the `favorites` table joined with `documents` so
 * the listing's title / URL / extracted facts come back in a single trip.
 * UNIQUE(user_id, doc_id) makes save() idempotent — clicking the heart
 * twice never produces duplicates.
 */

const db = require("./db");

async function listFavorites(userId) {
  const { rows } = await db.pool.query(
    `SELECT f.id, f.doc_id, f.note, f.created_at,
            d.url, d.title, d.doc_type, d.language, d.metadata
     FROM ${db.FAVORITES_TABLE} f
     JOIN ${db.DOCS_TABLE} d ON d.doc_id = f.doc_id
     WHERE f.user_id = $1
     ORDER BY f.created_at DESC
     LIMIT 500`,
    [userId],
  );
  return rows;
}

async function isFavorite(userId, docId) {
  const { rows } = await db.pool.query(
    `SELECT 1 FROM ${db.FAVORITES_TABLE} WHERE user_id = $1 AND doc_id = $2 LIMIT 1`,
    [userId, docId],
  );
  return rows.length > 0;
}

/**
 * Save a listing. Idempotent — returns the existing row if already saved.
 * Validates that doc_id actually exists in documents.
 */
async function addFavorite(userId, docId, note = null) {
  // Verify doc exists (gives a friendlier 404 than the FK error).
  const docCheck = await db.pool.query(
    `SELECT doc_id FROM ${db.DOCS_TABLE} WHERE doc_id = $1`,
    [docId],
  );
  if (docCheck.rows.length === 0) {
    return { ok: false, error: "document not found", status: 404 };
  }
  const { rows } = await db.pool.query(
    `INSERT INTO ${db.FAVORITES_TABLE} (user_id, doc_id, note)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, doc_id) DO UPDATE SET note = COALESCE(EXCLUDED.note, ${db.FAVORITES_TABLE}.note)
     RETURNING id, doc_id, note, created_at`,
    [userId, docId, note],
  );
  return { ok: true, favorite: rows[0] };
}

async function removeFavorite(userId, id) {
  const { rowCount } = await db.pool.query(
    `DELETE FROM ${db.FAVORITES_TABLE} WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return rowCount > 0;
}

async function removeFavoriteByDoc(userId, docId) {
  const { rowCount } = await db.pool.query(
    `DELETE FROM ${db.FAVORITES_TABLE} WHERE doc_id = $1 AND user_id = $2`,
    [docId, userId],
  );
  return rowCount > 0;
}

async function updateNote(userId, id, note) {
  const { rows } = await db.pool.query(
    `UPDATE ${db.FAVORITES_TABLE} SET note = $1
     WHERE id = $2 AND user_id = $3
     RETURNING id, doc_id, note, created_at`,
    [note, id, userId],
  );
  return rows[0] || null;
}

async function favoritesStats(userId) {
  const { rows } = await db.pool.query(
    `SELECT COUNT(*)::int AS total, MAX(created_at) AS newest
     FROM ${db.FAVORITES_TABLE} WHERE user_id = $1`,
    [userId],
  );
  return rows[0] || { total: 0, newest: null };
}

module.exports = {
  listFavorites,
  isFavorite,
  addFavorite,
  removeFavorite,
  removeFavoriteByDoc,
  updateNote,
  favoritesStats,
};
