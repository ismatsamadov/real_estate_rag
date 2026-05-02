"use strict";

const config = require("./config");
const db = require("./db");
const { embed, toVectorLiteral } = require("./embedder");
const logger = require("./logger");

const log = logger.child({ component: "retriever" });

function pageKindFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const first = pathname.split("/").filter(Boolean)[0] || "";
    return first || "homepage";
  } catch {
    return "unknown";
  }
}

function pickFirst(...values) {
  for (const v of values) {
    const s = String(v || "").trim();
    if (s) return s;
  }
  return "";
}

function parseMetadata(raw, url) {
  let meta = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) meta = raw;
  else if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) meta = parsed;
    } catch {
      meta = {};
    }
  }
  const sourceUrl = pickFirst(meta.sourceURL, meta.url, url);
  return {
    title: pickFirst(meta.title, meta.ogTitle, meta["og:title"], meta["twitter:title"]),
    description: pickFirst(
      meta.description,
      meta.ogDescription,
      meta["og:description"],
      meta["twitter:description"]
    ),
    language: pickFirst(meta.language, meta.lang).toLowerCase(),
    contentType: pickFirst(meta.contentType),
    pageKind: pageKindFromUrl(sourceUrl),
    statusCode: Number(meta.statusCode) || null,
    sourceURL: sourceUrl,
  };
}

function snippet(text, maxLen = 240) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return clean.length <= maxLen ? clean : `${clean.slice(0, maxLen)}...`;
}

/**
 * Hybrid retrieval: vector kNN + Postgres full-text search, fused via
 * Reciprocal Rank Fusion (RRF, k=60 by default).
 *
 * RRF is rank-only, so it's robust to scale differences between cosine
 * similarity and ts_rank_cd, and well-supported in the IR literature
 * (Cormack et al. 2009).
 */
async function hybridSearch({ queryEmbedding, queryText, candidateK, topK, rrfK }) {
  const sql = `
    WITH params AS (
      SELECT
        $1::vector AS qv,
        plainto_tsquery('english', $2) AS qt,
        $3::int   AS candidate_k,
        $4::int   AS rrf_k
    ),
    vector_hits AS (
      SELECT c.id,
             ROW_NUMBER() OVER (ORDER BY c.embedding <=> p.qv) AS rnk,
             1 - (c.embedding <=> p.qv) AS sim
      FROM ${db.TABLE} c, params p
      ORDER BY c.embedding <=> p.qv
      LIMIT (SELECT candidate_k FROM params)
    ),
    lexical_hits AS (
      SELECT c.id,
             ROW_NUMBER() OVER (ORDER BY ts_rank_cd(c.tsv, p.qt) DESC) AS rnk,
             ts_rank_cd(c.tsv, p.qt) AS lex
      FROM ${db.TABLE} c, params p
      WHERE c.tsv @@ p.qt
      ORDER BY ts_rank_cd(c.tsv, p.qt) DESC
      LIMIT (SELECT candidate_k FROM params)
    ),
    fused AS (
      SELECT id, SUM(weight) AS rrf_score
      FROM (
        SELECT id, 1.0 / ((SELECT rrf_k FROM params) + rnk) AS weight FROM vector_hits
        UNION ALL
        SELECT id, 1.0 / ((SELECT rrf_k FROM params) + rnk) AS weight FROM lexical_hits
      ) r
      GROUP BY id
    )
    SELECT
      c.id, c.doc_id, c.url, c.chunk_index, c.content, c.metadata,
      COALESCE(v.sim, 0) AS vector_score,
      COALESCE(l.lex, 0) AS lexical_score,
      f.rrf_score
    FROM fused f
    JOIN ${db.TABLE} c ON c.id = f.id
    LEFT JOIN vector_hits v ON v.id = f.id
    LEFT JOIN lexical_hits l ON l.id = f.id
    ORDER BY f.rrf_score DESC
    LIMIT $5::int
  `;
  const { rows } = await db.pool.query(sql, [
    toVectorLiteral(queryEmbedding),
    queryText,
    candidateK,
    rrfK,
    topK,
  ]);
  return rows;
}

async function vectorSearch({ queryEmbedding, topK }) {
  const sql = `
    SELECT
      id, doc_id, url, chunk_index, content, metadata,
      1 - (embedding <=> $1::vector) AS vector_score,
      0::double precision AS lexical_score,
      0::double precision AS rrf_score
    FROM ${db.TABLE}
    ORDER BY embedding <=> $1::vector
    LIMIT $2::int
  `;
  const { rows } = await db.pool.query(sql, [toVectorLiteral(queryEmbedding), topK]);
  return rows;
}

async function lexicalSearch({ queryText, topK }) {
  const sql = `
    SELECT
      id, doc_id, url, chunk_index, content, metadata,
      0::double precision AS vector_score,
      ts_rank_cd(tsv, plainto_tsquery('english', $1)) AS lexical_score,
      0::double precision AS rrf_score
    FROM ${db.TABLE}
    WHERE tsv @@ plainto_tsquery('english', $1)
    ORDER BY ts_rank_cd(tsv, plainto_tsquery('english', $1)) DESC
    LIMIT $2::int
  `;
  const { rows } = await db.pool.query(sql, [queryText, topK]);
  return rows;
}

function shapeRows(rows) {
  return rows.map((row, i) => {
    const metadata = parseMetadata(row.metadata, row.url);
    return {
      sid: `S${i + 1}`,
      id: Number(row.id),
      doc_id: row.doc_id,
      url: metadata.sourceURL || row.url,
      chunk_index: row.chunk_index,
      score: Number(row.rrf_score) || Number(row.vector_score) || 0,
      vector_score: Number(row.vector_score) || 0,
      lexical_score: Number(row.lexical_score) || 0,
      content: row.content,
      snippet: snippet(row.content),
      metadata,
    };
  });
}

/**
 * Retrieve top-K source chunks for a question.
 *
 * @param {string} question
 * @param {{ topK?: number, candidateK?: number, mode?: 'hybrid'|'vector'|'lexical' }} [opts]
 */
async function retrieve(question, opts = {}) {
  const q = String(question || "").trim();
  if (!q) return { sources: [], mode: "vector" };

  const mode = opts.mode || config.retrieval.mode;
  const topK = Math.min(50, Math.max(1, opts.topK ?? config.retrieval.topK));
  const candidateK = Math.max(topK, opts.candidateK ?? config.retrieval.candidateK);

  let rows;
  let usedMode = mode;
  if (mode === "lexical") {
    rows = await lexicalSearch({ queryText: q, topK });
  } else if (mode === "vector") {
    const queryEmbedding = await embed(q);
    rows = await vectorSearch({ queryEmbedding, topK });
  } else {
    const queryEmbedding = await embed(q);
    rows = await hybridSearch({
      queryEmbedding,
      queryText: q,
      candidateK,
      topK,
      rrfK: config.retrieval.rrfK,
    });
    if (!rows.length) {
      // Lexical query may have been empty (stop-words only) or matched nothing.
      // Fall back to pure vector search to guarantee a non-empty result set
      // when any chunks exist.
      log.debug({ q }, "hybrid returned 0; falling back to vector");
      rows = await vectorSearch({ queryEmbedding, topK });
      usedMode = "vector";
    }
  }

  return {
    sources: shapeRows(rows),
    mode: usedMode,
  };
}

module.exports = {
  retrieve,
  parseMetadata,
};
