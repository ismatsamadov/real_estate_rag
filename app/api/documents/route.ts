/**
 * GET  /api/documents?sessionId=<uuid>  — list uploaded docs in that session
 * POST /api/documents                   — one-shot multipart upload of a PDF
 *
 *   Form fields:
 *     file       (the PDF binary; must fit under Vercel's ~4.5 MB function
 *                 body cap — the client routes larger files through
 *                 /api/documents/chunk instead)
 *     sessionId  (UUID — created in advance via /api/sessions or
 *                 auto-created here)
 */
import { NextResponse } from "next/server";
import { getUserId } from "../_auth";
import { classifyError } from "../../../src/errors";

const sessions = require("../../../src/sessions");
const documents = require("../../../src/documents");

export const runtime = "nodejs";
// PDF extraction + embedding for a 100-page doc can take 30s-2min,
// well within Vercel's 300s budget.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Vercel caps function bodies at ~4.5 MB; we leave a bit of headroom. The
// chunked upload route handles anything bigger.
const MAX_SIZE_BYTES = 4 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  "application/pdf",
  "application/x-pdf",
  "binary/octet-stream", // some browsers
]);

export async function GET(req: Request) {
  const userId = getUserId(req);
  const sessionId = new URL(req.url).searchParams.get("sessionId");
  if (!sessionId || !UUID_RE.test(sessionId)) {
    return NextResponse.json({ ok: false, error: "sessionId required" }, { status: 400 });
  }
  // Ownership check
  const sess = await sessions.getSession(userId, sessionId);
  if (!sess) {
    return NextResponse.json({ ok: false, error: "Session not found" }, { status: 404 });
  }
  const docs = await documents.listUploadedDocs(sessionId);
  return NextResponse.json({ ok: true, documents: docs });
}

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

  // ---- Validate sessionId ----
  let sessionId = String(form.get("sessionId") || "").trim();
  if (sessionId && !UUID_RE.test(sessionId)) {
    return NextResponse.json(
      { ok: false, error: "sessionId must be a UUID" },
      { status: 400 },
    );
  }

  // Auto-create a session on the fly so the user can drop a PDF first
  // and ask questions in the same browser tap. Title is left NULL so
  // the user's first message can set it via appendUserMessage —
  // appendUserMessage only sets title when it's null, so a hard-coded
  // placeholder like "New chat" would block the natural title forever.
  if (!sessionId) {
    const created = await sessions.createSession(userId, { title: null });
    sessionId = created.session_id;
  } else {
    const sess = await sessions.getSession(userId, sessionId);
    if (!sess) {
      return NextResponse.json(
        { ok: false, error: "Session not found" },
        { status: 404 },
      );
    }
  }

  // ---- Validate file ----
  const file = form.get("file");
  if (!file || typeof file === "string") {
    return NextResponse.json(
      { ok: false, error: "file is required (multipart field 'file')" },
      { status: 400 },
    );
  }
  const blob = file as File;
  if (blob.size === 0) {
    return NextResponse.json({ ok: false, error: "Empty file" }, { status: 400 });
  }
  if (blob.size > MAX_SIZE_BYTES) {
    return NextResponse.json(
      {
        ok: false,
        error: `File is ${(blob.size / 1024 / 1024).toFixed(1)} MB; this endpoint caps at ${MAX_SIZE_BYTES / 1024 / 1024} MB. Bigger files should be sent via /api/documents/chunk.`,
      },
      { status: 413 },
    );
  }
  // Some browsers don't send a Content-Type for PDFs; fall back to extension.
  const looksPdf =
    ALLOWED_TYPES.has(blob.type) ||
    blob.name?.toLowerCase().endsWith(".pdf");
  if (!looksPdf) {
    return NextResponse.json(
      {
        ok: false,
        error: `Only PDF uploads are supported right now. Got "${blob.type || "unknown"}".`,
      },
      { status: 415 },
    );
  }

  const buffer = Buffer.from(await blob.arrayBuffer());

  // ---- Extract + chunk + embed + persist ----
  try {
    const result = await documents.indexUploadedPdf(userId, sessionId, {
      filename: blob.name || "document.pdf",
      buffer,
    });
    return NextResponse.json({ ok: true, sessionId, document: result });
  } catch (err: any) {
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
