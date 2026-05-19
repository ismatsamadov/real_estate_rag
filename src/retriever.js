"use strict";

/**
 * Hybrid retrieval with rerank + LRU cache + metadata filtering.
 *
 *   1. Embed query (asymmetric: inputType="query").
 *   2. Pull `candidateK` chunks via one of:
 *         hybrid  -> vector kNN + BM25-style FTS fused via RRF in one CTE
 *         vector  -> ANN only
 *         lexical -> FTS only
 *      Filters (language, doc_type, listing_type, price/bedrooms ranges)
 *      apply at the SQL layer using the chunks' jsonb metadata + GIN.
 *   3. Optional cross-encoder rerank via Voyage rerank-2.5 (RAG_RERANK=true).
 *      Rerank fixes ANN errors at low cost (~$0.05/1k queries).
 *   4. Trim to `topK` and shape for the LLM.
 *
 * Returns: { sources, mode, reranked, fallback, cached }
 *
 * Cache: in-process LRU keyed by (mode, normalizedQuery, filters, topK,
 * candidateK, rerankFlag). 5-minute TTL. Cuts repeat-query latency to <5ms.
 */

const { LRUCache } = require("lru-cache");

const config = require("./config");
const db = require("./db");
const { embed, rerank, toVectorLiteral } = require("./embedder");
const logger = require("./logger");

const log = logger.child({ component: "retriever" });

// ---------------------------------------------------------------------------
// LRU cache
// ---------------------------------------------------------------------------

const cache = config.retrieval.cacheTtlMs > 0
  ? new LRUCache({
      max: config.retrieval.cacheMax,
      ttl: config.retrieval.cacheTtlMs,
    })
  : null;

function cacheKey({ q, mode, topK, candidateK, doRerank, filters, sessionId }) {
  return JSON.stringify({
    q: q.toLowerCase().replace(/\s+/g, " ").trim(),
    mode,
    topK,
    candidateK,
    doRerank,
    filters,
    sessionId: sessionId || null,
  });
}

// ---------------------------------------------------------------------------
// Metadata filter SQL builder
// ---------------------------------------------------------------------------

/**
 * Build a parameterized WHERE clause + values array from a structured
 * filters object. Filters live on the chunks' jsonb metadata column
 * (we duplicate doc-level facts down so retrieval can filter without joining).
 *
 *   filters: {
 *     language: "en" | ["en","ru"],
 *     doc_type: "listing" | ["listing","article"],
 *     listing_type: "sale" | "rent",
 *     property_type: "apartment",
 *     price_min: number, price_max: number,
 *     bedrooms_min: number, bedrooms_max: number,
 *     area_min: number, area_max: number,
 *   }
 *
 * Returns { clause, values, nextParam } where nextParam is the next $N
 * to use after the filter values are bound.
 */
function buildFilterClause(filters, startIdx = 1) {
  const conditions = [];
  const values = [];
  let idx = startIdx;

  const eq = (key, val) => {
    if (Array.isArray(val)) {
      // ANY match for arrays
      conditions.push(`(c.metadata->>'${key}') = ANY($${idx}::text[])`);
      values.push(val.map(String));
    } else {
      conditions.push(`c.metadata->>'${key}' = $${idx}`);
      values.push(String(val));
    }
    idx += 1;
  };

  const range = (key, min, max, cast = "numeric") => {
    if (min != null) {
      conditions.push(`(c.metadata->>'${key}')::${cast} >= $${idx}`);
      values.push(Number(min));
      idx += 1;
    }
    if (max != null) {
      conditions.push(`(c.metadata->>'${key}')::${cast} <= $${idx}`);
      values.push(Number(max));
      idx += 1;
    }
  };

  if (filters?.language) eq("language", filters.language);
  if (filters?.doc_type) eq("doc_type", filters.doc_type);
  if (filters?.listing_type) eq("listing_type", filters.listing_type);
  if (filters?.property_type) eq("property_type", filters.property_type);
  range("price", filters?.price_min, filters?.price_max);
  range("bedrooms", filters?.bedrooms_min, filters?.bedrooms_max, "int");
  range("area_sqm", filters?.area_min, filters?.area_max);

  return {
    clause: conditions.length ? `AND ${conditions.join(" AND ")}` : "",
    values,
    nextParam: idx,
  };
}

// Session-scope clause. The corpus is "public" (session_id IS NULL) by
// default. When the caller provides a sessionId, we also include any
// chunks uploaded for THAT session — so the user's PDF gets retrieved
// alongside the public corpus, and never sees other users' uploads.
function buildSessionScopeClause(sessionId, startIdx = 1) {
  if (!sessionId) {
    return { clause: `AND c.session_id IS NULL`, values: [], nextParam: startIdx };
  }
  return {
    clause: `AND (c.session_id IS NULL OR c.session_id = $${startIdx}::uuid)`,
    values: [sessionId],
    nextParam: startIdx + 1,
  };
}

// ---------------------------------------------------------------------------
// Search SQL
// ---------------------------------------------------------------------------

async function hybridSearch({ qv, qt, candidateK, rrfK, filters, sessionId }) {
  // The filter + session scope clauses are referenced twice (once per
  // subquery). pg's positional $N binding means we duplicate the values
  // with two distinct parameter offsets.
  const s1 = buildSessionScopeClause(sessionId, 5);
  const f1 = buildFilterClause(filters, s1.nextParam);
  const s2 = buildSessionScopeClause(sessionId, f1.nextParam);
  const f2 = buildFilterClause(filters, s2.nextParam);

  const sql = `
    WITH params AS (
      SELECT
        $1::vector AS qv,
        plainto_tsquery('simple', $2) AS qt,
        $3::int AS candidate_k,
        $4::int AS rrf_k
    ),
    vector_hits AS (
      SELECT c.id,
             ROW_NUMBER() OVER (ORDER BY c.embedding <=> p.qv) AS rnk,
             1 - (c.embedding <=> p.qv) AS sim
      FROM ${db.CHUNKS_TABLE} c, params p
      WHERE TRUE ${s1.clause} ${f1.clause}
      ORDER BY c.embedding <=> p.qv
      LIMIT (SELECT candidate_k FROM params)
    ),
    lexical_hits AS (
      SELECT c.id,
             ROW_NUMBER() OVER (ORDER BY ts_rank_cd(c.tsv, p.qt) DESC) AS rnk,
             ts_rank_cd(c.tsv, p.qt) AS lex
      FROM ${db.CHUNKS_TABLE} c, params p
      WHERE c.tsv @@ p.qt ${s2.clause} ${f2.clause}
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
    JOIN ${db.CHUNKS_TABLE} c ON c.id = f.id
    LEFT JOIN vector_hits v ON v.id = f.id
    LEFT JOIN lexical_hits l ON l.id = f.id
    ORDER BY f.rrf_score DESC
    LIMIT (SELECT candidate_k FROM params)
  `;

  const values = [
    qv,
    qt,
    candidateK,
    rrfK,
    ...s1.values,
    ...f1.values,
    ...s2.values,
    ...f2.values,
  ];
  const { rows } = await db.pool.query(sql, values);
  return rows;
}

async function vectorSearch({ qv, candidateK, filters, sessionId }) {
  const sc = buildSessionScopeClause(sessionId, 3);
  const ff = buildFilterClause(filters, sc.nextParam);
  const sql = `
    SELECT
      c.id, c.doc_id, c.url, c.chunk_index, c.content, c.metadata,
      1 - (c.embedding <=> $1::vector) AS vector_score,
      0::double precision AS lexical_score,
      0::double precision AS rrf_score
    FROM ${db.CHUNKS_TABLE} c
    WHERE TRUE ${sc.clause} ${ff.clause}
    ORDER BY c.embedding <=> $1::vector
    LIMIT $2::int
  `;
  const { rows } = await db.pool.query(sql, [qv, candidateK, ...sc.values, ...ff.values]);
  return rows;
}

async function lexicalSearch({ qt, candidateK, filters, sessionId }) {
  const sc = buildSessionScopeClause(sessionId, 3);
  const ff = buildFilterClause(filters, sc.nextParam);
  const sql = `
    SELECT
      c.id, c.doc_id, c.url, c.chunk_index, c.content, c.metadata,
      0::double precision AS vector_score,
      ts_rank_cd(c.tsv, plainto_tsquery('simple', $1)) AS lexical_score,
      0::double precision AS rrf_score
    FROM ${db.CHUNKS_TABLE} c
    WHERE c.tsv @@ plainto_tsquery('simple', $1) ${sc.clause} ${ff.clause}
    ORDER BY ts_rank_cd(c.tsv, plainto_tsquery('simple', $1)) DESC
    LIMIT $2::int
  `;
  const { rows } = await db.pool.query(sql, [qt, candidateK, ...sc.values, ...ff.values]);
  return rows;
}

// ---------------------------------------------------------------------------
// Row shaping
// ---------------------------------------------------------------------------

function snippet(text, maxLen = 240) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return clean.length <= maxLen ? clean : `${clean.slice(0, maxLen)}...`;
}

function parseMetadata(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const p = JSON.parse(raw);
      if (p && typeof p === "object" && !Array.isArray(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return {};
}

function shapeRows(rows) {
  return rows.map((row, i) => {
    const metadata = parseMetadata(row.metadata);
    return {
      sid: `S${i + 1}`,
      id: Number(row.id),
      doc_id: row.doc_id,
      url: row.url,
      chunk_index: row.chunk_index,
      score:
        Number(row.rerank_score) ||
        Number(row.rrf_score) ||
        Number(row.vector_score) ||
        0,
      rerank_score: Number(row.rerank_score) || null,
      vector_score: Number(row.vector_score) || 0,
      lexical_score: Number(row.lexical_score) || 0,
      rrf_score: Number(row.rrf_score) || 0,
      content: row.content,
      snippet: snippet(row.content),
      metadata,
    };
  });
}

// ---------------------------------------------------------------------------
// Top-level retrieve
// ---------------------------------------------------------------------------

/**
 * Retrieve top-K source chunks for a question.
 *
 * @param {string} question
 * @param {object} opts
 * @param {number} [opts.topK]
 * @param {number} [opts.candidateK]
 * @param {'hybrid'|'vector'|'lexical'} [opts.mode]
 * @param {object} [opts.filters]
 * @param {boolean} [opts.rerank]
 * @returns {Promise<{ sources, mode, reranked, fallback, cached }>}
 */
async function retrieve(question, opts = {}) {
  const q = String(question || "").trim();
  if (!q) return { sources: [], mode: "vector", reranked: false, fallback: null, cached: false };

  const mode = opts.mode || config.retrieval.mode;
  const topK = Math.min(50, Math.max(1, opts.topK ?? config.retrieval.topK));
  const candidateK = Math.max(topK, opts.candidateK ?? config.retrieval.candidateK);
  const doRerank = opts.rerank ?? config.retrieval.rerank;
  const filters = opts.filters || null;
  const sessionId = opts.sessionId || null;

  // Cache check — include sessionId in the key so uploaded-doc queries
  // don't share a cache entry with public-corpus queries.
  const key = cacheKey({ q, mode, topK, candidateK, doRerank, filters, sessionId });
  if (cache) {
    const hit = cache.get(key);
    if (hit) {
      log.debug({ q: q.slice(0, 80) }, "retrieval cache hit");
      return { ...hit, cached: true };
    }
  }

  let rows;
  let usedMode = mode;
  let fallback = null;

  if (mode === "lexical") {
    rows = await lexicalSearch({ qt: q, candidateK, filters, sessionId });
  } else if (mode === "vector") {
    const qv = toVectorLiteral(await embed(q, "query"));
    rows = await vectorSearch({ qv, candidateK, filters, sessionId });
  } else {
    // hybrid
    const qv = toVectorLiteral(await embed(q, "query"));
    rows = await hybridSearch({
      qv,
      qt: q,
      candidateK,
      rrfK: config.retrieval.rrfK,
      filters,
      sessionId,
    });
    if (!rows.length) {
      // Lexical query may have been empty (stop-words only) or matched
      // nothing under the current filters. Fall back to pure vector.
      log.info({ q: q.slice(0, 80) }, "hybrid empty -> falling back to vector");
      rows = await vectorSearch({ qv, candidateK, filters, sessionId });
      usedMode = "vector";
      fallback = "lexical-empty";
    }
  }

  // Rerank step: cross-encoder over the candidate set. Skipped when no
  // candidates or when explicitly disabled. Voyage rerank-2.5 scores
  // (query, document) pairs natively without needing query embeddings.
  let reranked = false;
  if (doRerank && rows.length > 1) {
    try {
      const scored = await rerank({
        query: q,
        documents: rows.map((r) => r.content),
        topK: topK,
        model: config.voyage.rerankModel,
      });
      // Reorder rows by rerank result; attach scores.
      const reordered = scored.map((s) => ({
        ...rows[s.index],
        rerank_score: s.score,
      }));
      rows = reordered;
      reranked = true;
    } catch (err) {
      log.warn({ err: err.message }, "rerank failed; falling back to RRF order");
      rows = rows.slice(0, topK);
    }
  } else {
    rows = rows.slice(0, topK);
  }

  const result = {
    sources: shapeRows(rows),
    mode: usedMode,
    reranked,
    fallback,
    cached: false,
  };

  if (cache) cache.set(key, result);

  return result;
}

module.exports = {
  retrieve,
  parseMetadata,
  // Exported for tests / debugging
  buildFilterClause,
};
