/**
 * POST /api/documents/chunk — chunked PDF upload.
 *
 *   Each chunk is a separate multipart request, sized below Vercel's
 *   4.5 MB function-body cap. Bytes are staged in the `upload_chunks`
 *   table; when the row count for a given uploadId equals totalChunks
 *   the server reassembles, runs the existing indexing pipeline, and
 *   purges the staged rows. Whichever request lands the final chunk
 *   does the finalization — chunks can therefore arrive in any order.
 *
 *   Multipart fields:
 *     chunk         File   — the bytes (≤ ~4 MB each)
 *     uploadId      UUID   — generated client-side; ties chunks together
 *     chunkIndex    int    — 0-based
 *     totalChunks   int    — total number of chunks
 *     filename      str    — original filename (used as the doc title)
 *     sessionId     UUID?  — optional; auto-created on finalize if absent
 *
 *   Response on a non-final chunk: { ok: true, received: chunkIndex }
 *   Response on the final chunk:   { ok: true, sessionId, document: {...} }
 */
import { NextResponse } from "next/server";
import { getUserId } from "../../_auth";
import { classifyError } from "../../../../src/errors";

const db = require("../../../../src/db");
const sessions = require("../../../../src/sessions");
const documents = require("../../../../src/documents");

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Each chunk must fit under Vercel's 4.5 MB body cap. Client targets 3.5 MB
// to leave headroom for multipart overhead and the other form fields.
const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
// Practical upper bound. Bigger PDFs should go to real object storage.
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_CHUNKS = 32;
// Abandoned uploads self-clean after this long.
const CHUNK_TTL_HOURS = 1;

export async function POST(req: Request) {
  const userId = getUserId(req);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid multipart form data." },
      { status: 400 },
    );
  }

  const uploadId = String(form.get("uploadId") || "").trim();
  const chunkIndex = Number(form.get("chunkIndex"));
  const totalChunks = Number(form.get("totalChunks"));
  const filename = String(form.get("filename") || "").trim();
  const sessionIdInput = String(form.get("sessionId") || "").trim();
  const chunk = form.get("chunk");

  if (!UUID_RE.test(uploadId)) {
    return NextResponse.json({ ok: false, error: "uploadId must be a UUID" }, { status: 400 });
  }
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
    return NextResponse.json({ ok: false, error: "chunkIndex must be a non-negative integer" }, { status: 400 });
  }
  if (!Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > MAX_TOTAL_CHUNKS) {
    return NextResponse.json(
      { ok: false, error: `totalChunks must be 1..${MAX_TOTAL_CHUNKS}` },
      { status: 400 },
    );
  }
  if (chunkIndex >= totalChunks) {
    return NextResponse.json({ ok: false, error: "chunkIndex out of range" }, { status: 400 });
  }
  if (!filename || !filename.toLowerCase().endsWith(".pdf")) {
    return NextResponse.json({ ok: false, error: "filename must end with .pdf" }, { status: 400 });
  }
  if (sessionIdInput && !UUID_RE.test(sessionIdInput)) {
    return NextResponse.json({ ok: false, error: "sessionId must be a UUID" }, { status: 400 });
  }
  if (!chunk || typeof chunk === "string") {
    return NextResponse.json({ ok: false, error: "chunk file part is required" }, { status: 400 });
  }
  const blob = chunk as File;
  if (blob.size === 0) {
    return NextResponse.json({ ok: false, error: "Empty chunk" }, { status: 400 });
  }
  if (blob.size > MAX_CHUNK_BYTES) {
    return NextResponse.json(
      {
        ok: false,
        error: `Chunk is ${(blob.size / 1024 / 1024).toFixed(2)} MB; max per chunk is ${MAX_CHUNK_BYTES / 1024 / 1024} MB.`,
      },
      { status: 413 },
    );
  }

  // If a session id was provided, verify the caller owns it before we
  // stage anything against it.
  if (sessionIdInput) {
    const sess = await sessions.getSession(userId, sessionIdInput);
    if (!sess) {
      return NextResponse.json({ ok: false, error: "Session not found" }, { status: 404 });
    }
  }

  const buffer = Buffer.from(await blob.arrayBuffer());

  // Stage the chunk. ON CONFLICT DO NOTHING makes a client retry of the
  // same (uploadId, chunkIndex) idempotent — important when a flaky
  // network triggers a retry mid-upload.
  await db.pool.query(
    `INSERT INTO ${db.UPLOAD_CHUNKS_TABLE}
       (upload_id, chunk_index, total_chunks, filename, user_id, session_id, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (upload_id, chunk_index) DO NOTHING`,
    [
      uploadId,
      chunkIndex,
      totalChunks,
      filename,
      userId,
      sessionIdInput || null,
      buffer,
    ],
  );

  // Opportunistic GC of abandoned uploads. Cheap (uses the created_at index)
  // and avoids needing a separate cron.
  await db.pool
    .query(
      `DELETE FROM ${db.UPLOAD_CHUNKS_TABLE}
         WHERE created_at < NOW() - INTERVAL '${CHUNK_TTL_HOURS} hours'`,
    )
    .catch(() => {});

  // Is the upload complete? Whichever request brings the row count up to
  // totalChunks wins finalization.
  const { rows: countRows } = await db.pool.query(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(octet_length(data)), 0)::bigint AS total_bytes
       FROM ${db.UPLOAD_CHUNKS_TABLE}
      WHERE upload_id = $1 AND user_id = $2`,
    [uploadId, userId],
  );
  const haveChunks = Number(countRows[0]?.n || 0);
  const totalBytes = Number(countRows[0]?.total_bytes || 0);

  if (haveChunks < totalChunks) {
    return NextResponse.json({
      ok: true,
      received: chunkIndex,
      have: haveChunks,
      total: totalChunks,
    });
  }

  // ---- Finalize ----
  if (totalBytes > MAX_TOTAL_BYTES) {
    // Clean up before we error out so the rows don't sit around.
    await db.pool
      .query(`DELETE FROM ${db.UPLOAD_CHUNKS_TABLE} WHERE upload_id = $1`, [uploadId])
      .catch(() => {});
    return NextResponse.json(
      {
        ok: false,
        error: `Total upload is ${(totalBytes / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_TOTAL_BYTES / 1024 / 1024} MB.`,
      },
      { status: 413 },
    );
  }

  // Reassemble in chunk order.
  const { rows: chunkRows } = await db.pool.query(
    `SELECT chunk_index, data
       FROM ${db.UPLOAD_CHUNKS_TABLE}
      WHERE upload_id = $1 AND user_id = $2
      ORDER BY chunk_index ASC`,
    [uploadId, userId],
  );
  if (chunkRows.length !== totalChunks) {
    // Race: another request finalized between our count and our select.
    // Treat as in-flight, the winning request will return the document.
    return NextResponse.json({
      ok: true,
      received: chunkIndex,
      have: chunkRows.length,
      total: totalChunks,
    });
  }
  const fullBuffer = Buffer.concat(chunkRows.map((r: any) => r.data));

  // Sanity: PDF magic bytes should be at the very start.
  const head = fullBuffer.subarray(0, 5).toString("ascii");
  if (head !== "%PDF-") {
    await db.pool
      .query(`DELETE FROM ${db.UPLOAD_CHUNKS_TABLE} WHERE upload_id = $1`, [uploadId])
      .catch(() => {});
    return NextResponse.json(
      { ok: false, error: "Reassembled bytes are not a PDF (missing %PDF- header)." },
      { status: 415 },
    );
  }

  // Resolve session (auto-create if not provided), same rule as the
  // multipart route: leave the title NULL so the first chat message
  // can name the session.
  let sessionId = sessionIdInput;
  if (!sessionId) {
    const created = await sessions.createSession(userId, { title: null });
    sessionId = created.session_id;
  }

  try {
    const result = await documents.indexUploadedPdf(userId, sessionId, {
      filename,
      buffer: fullBuffer,
    });
    // Clean up staged chunks now that the doc + its embedded rows exist.
    await db.pool
      .query(`DELETE FROM ${db.UPLOAD_CHUNKS_TABLE} WHERE upload_id = $1`, [uploadId])
      .catch(() => {});
    return NextResponse.json({ ok: true, sessionId, document: result });
  } catch (err: any) {
    // Indexing failed — also drop the staged chunks so the user can retry
    // cleanly. The detailed error message is surfaced to the UI.
    await db.pool
      .query(`DELETE FROM ${db.UPLOAD_CHUNKS_TABLE} WHERE upload_id = $1`, [uploadId])
      .catch(() => {});
    const cls = err?.classified || classifyError(err);
    return NextResponse.json(
      {
        ok: false,
        error: err?.message || cls.userMessage || "Upload failed.",
        kind: cls.kind,
        retryable: cls.retryable,
      },
      { status: cls.status || 500 },
    );
  }
}
