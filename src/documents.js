"use strict";

/**
 * Per-session uploaded-document indexing.
 *
 * Public API:
 *   indexUploadedPdf(userId, sessionId, { filename, buffer })
 *     → { docId, totalPages, totalChunks }
 *
 *   listUploadedDocs(sessionId)
 *     → [{ doc_id, title, total_pages, chunk_count, uploaded_at, size_kb }]
 *
 *   deleteUploadedDoc(sessionId, docId)
 *     → boolean
 *
 * Storage:
 *   - documents row with session_id = sessionId, doc_type = 'upload',
 *     metadata.{filename, total_pages, size_kb, uploaded_by}
 *   - rag_chunks rows with session_id denormalized + metadata.page
 *   - cleaned up automatically when the session is deleted (FK CASCADE)
 *
 * Retrieval-side change is in retriever.js: when the request carries a
 * sessionId, queries OR'd with `session_id = $sid` so the uploaded
 * chunks appear alongside the public corpus.
 */

const crypto = require("node:crypto");
const config = require("./config");
const db = require("./db");
const logger = require("./logger");
const { extractPdfPages } = require("./pdf");
const { chunkText, normalize } = require("./chunker");
const { embedBatch, toVectorLiteral } = require("./embedder");

const log = logger.child({ component: "documents" });

// Hard caps to stop a giant PDF from blowing the Voyage budget or the
// function memory. Tune via env later if needed.
const MAX_PAGES = 400;
const MAX_TOTAL_CHARS = 500_000;
const MAX_CHUNKS_PER_PAGE = 20;

/**
 * Take a PDF buffer, extract text per page, chunk each page, embed in
 * batches, and upsert into the session-scoped tables. Returns counters
 * the route handler can show to the user.
 */
async function indexUploadedPdf(userId, sessionId, { filename, buffer }) {
  if (!sessionId) throw new Error("sessionId is required for uploaded documents");
  if (!buffer || buffer.length === 0) throw new Error("Empty upload");

  // ---- Extract ----
  const { totalPages, pages } = await extractPdfPages(buffer);
  if (totalPages === 0) {
    throw new Error("PDF has no extractable text (scanned PDF without OCR?)");
  }
  if (totalPages > MAX_PAGES) {
    throw new Error(
      `PDF has ${totalPages} pages; the per-document limit is ${MAX_PAGES}. Please split it.`,
    );
  }

  const totalChars = pages.reduce((n, p) => n + p.text.length, 0);
  if (totalChars > MAX_TOTAL_CHARS) {
    throw new Error(
      `Extracted ${totalChars.toLocaleString()} characters; the per-document limit is ${MAX_TOTAL_CHARS.toLocaleString()}. Please split the PDF.`,
    );
  }

  // ---- Chunk per page (so every chunk carries its page number) ----
  const items = []; // { docId, chunkIndex, content, contentHash, page }
  const docId =
    "upload-" +
    crypto
      .createHash("sha256")
      .update(`${sessionId}::${filename}::${Date.now()}`)
      .digest("hex")
      .slice(0, 14);

  let chunkIndex = 0;
  for (const { page, text } of pages) {
    const normalized = normalize(text);
    if (!normalized) continue;
    const pageChunks = chunkText(normalized, {
      maxChars: config.ingest.chunkSize,
      overlap: config.ingest.chunkOverlap,
      minChars: config.ingest.minChunkSize,
    }).slice(0, MAX_CHUNKS_PER_PAGE);
    for (const content of pageChunks) {
      items.push({
        chunkIndex: chunkIndex++,
        content,
        contentHash: sha256(content),
        page,
      });
    }
  }

  if (items.length === 0) {
    throw new Error("No usable text extracted from PDF.");
  }

  // ---- Embed all chunks (asymmetric: inputType=document) ----
  const vectors = await embedBatch(
    items.map((it) => it.content),
    { inputType: "document" },
  );

  // ---- Persist: documents row, then chunks ----
  // Synthetic URL so the UNIQUE constraint on documents.url is satisfied
  // and the UI can render a sensible link target. Format makes it obvious
  // this is an upload, not a scraped page.
  const url = `upload://${sessionId}/${encodeURIComponent(filename)}`;
  const sizeKb = Math.round(buffer.length / 1024);

  await db.withClient(async (client) => {
    await client.query(
      `INSERT INTO ${db.DOCS_TABLE}
         (doc_id, url, title, doc_type, language, metadata, source_hash, session_id, scraped_at, updated_at)
       VALUES ($1, $2, $3, 'upload', 'auto', $4::jsonb, $5, $6, NOW(), NOW())
       ON CONFLICT (doc_id) DO UPDATE SET
         title = EXCLUDED.title,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()`,
      [
        docId,
        url,
        filename,
        JSON.stringify({
          filename,
          total_pages: totalPages,
          size_kb: sizeKb,
          uploaded_by: userId,
        }),
        sha256(filename + ":" + sizeKb),
        sessionId,
      ],
    );

    // Chunks — batched inserts of ~32 rows each.
    const BATCH = 32;
    for (let i = 0; i < items.length; i += BATCH) {
      const slice = items.slice(i, i + BATCH);
      const values = [];
      const placeholders = slice
        .map((it, idx) => {
          const base = idx * 8;
          values.push(
            docId,
            url,
            it.chunkIndex,
            it.content,
            it.contentHash,
            JSON.stringify({ doc_type: "upload", page: it.page, filename }),
            toVectorLiteral(vectors[i + idx]),
            sessionId,
          );
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}::jsonb, $${base + 7}::vector, $${base + 8})`;
        })
        .join(", ");
      await client.query(
        `INSERT INTO ${db.CHUNKS_TABLE}
           (doc_id, url, chunk_index, content, content_hash, metadata, embedding, session_id)
         VALUES ${placeholders}
         ON CONFLICT (doc_id, chunk_index) DO UPDATE SET
           content = EXCLUDED.content,
           content_hash = EXCLUDED.content_hash,
           metadata = EXCLUDED.metadata,
           embedding = EXCLUDED.embedding,
           updated_at = NOW()`,
        values,
      );
    }
  });

  log.info(
    { sessionId, docId, filename, totalPages, totalChunks: items.length, sizeKb },
    "uploaded document indexed",
  );

  return {
    docId,
    title: filename,
    totalPages,
    totalChunks: items.length,
    sizeKb,
  };
}

async function listUploadedDocs(sessionId) {
  if (!sessionId) return [];
  const { rows } = await db.pool.query(
    `SELECT d.doc_id, d.title, d.metadata, d.updated_at,
            COUNT(c.id)::int AS chunk_count
     FROM ${db.DOCS_TABLE} d
     LEFT JOIN ${db.CHUNKS_TABLE} c
       ON c.doc_id = d.doc_id AND c.session_id = d.session_id
     WHERE d.session_id = $1 AND d.doc_type = 'upload'
     GROUP BY d.doc_id, d.title, d.metadata, d.updated_at
     ORDER BY d.updated_at DESC
     LIMIT 50`,
    [sessionId],
  );
  return rows.map((r) => ({
    doc_id: r.doc_id,
    title: r.title,
    total_pages: r.metadata?.total_pages || null,
    size_kb: r.metadata?.size_kb || null,
    chunk_count: r.chunk_count,
    uploaded_at: r.updated_at,
  }));
}

// Library view: every upload this user owns, across every session.
// Owner check is enforced by joining through SESSIONS_TABLE on user_id —
// a row only appears if the session belongs to the caller.
async function listAllUploadsForUser(userId) {
  const { rows } = await db.pool.query(
    `SELECT d.doc_id,
            d.title,
            d.metadata,
            d.updated_at,
            d.session_id,
            s.title AS session_title,
            (SELECT COUNT(*) FROM ${db.CHUNKS_TABLE} c
              WHERE c.doc_id = d.doc_id AND c.session_id = d.session_id)::int
              AS chunk_count
     FROM ${db.DOCS_TABLE} d
     JOIN ${db.SESSIONS_TABLE} s
       ON s.session_id = d.session_id AND s.user_id = $1
     WHERE d.doc_type = 'upload' AND d.session_id IS NOT NULL
     ORDER BY d.updated_at DESC
     LIMIT 200`,
    [userId],
  );
  return rows.map((r) => ({
    doc_id: r.doc_id,
    title: r.title,
    total_pages: r.metadata?.total_pages || null,
    size_kb: r.metadata?.size_kb || null,
    chunk_count: r.chunk_count,
    uploaded_at: r.updated_at,
    session_id: r.session_id,
    session_title: r.session_title,
  }));
}

async function deleteUploadedDoc(sessionId, docId) {
  const { rowCount } = await db.pool.query(
    `DELETE FROM ${db.DOCS_TABLE} WHERE doc_id = $1 AND session_id = $2 AND doc_type = 'upload'`,
    [docId, sessionId],
  );
  return rowCount > 0;
}

function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

module.exports = {
  indexUploadedPdf,
  listUploadedDocs,
  listAllUploadsForUser,
  deleteUploadedDoc,
};
