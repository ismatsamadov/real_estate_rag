/**
 * GET  /api/documents?sessionId=<uuid>  — list uploaded docs in that session
 * POST /api/documents                   — index a previously-uploaded PDF
 *
 *   JSON body (preferred — bypasses Vercel's 4.5 MB function body cap):
 *     { blobUrl: string, sessionId?: uuid }
 *
 *     The client first PUTs the PDF straight to Vercel Blob via
 *     /api/documents/upload-token, then POSTs the resulting blob URL here.
 *     We fetch the blob server-side, run the existing extract→chunk→embed
 *     pipeline, and delete the blob (we don't keep PDFs in blob storage).
 *
 *   Multipart fallback (kept so small dev uploads still work without a
 *   Blob store configured):
 *     file       (the PDF binary, ≤ 10 MB — note: Vercel caps this at ~4.5 MB)
 *     sessionId  (UUID — created in advance via /api/sessions or auto-created)
 */
import { NextResponse } from "next/server";
import { del as deleteBlob } from "@vercel/blob";
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
const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
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

  // Branch on Content-Type: JSON body = blob-URL flow, multipart = legacy.
  const contentType = req.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");

  let sessionIdInput = "";
  let filename = "document.pdf";
  let buffer: Buffer;
  let blobUrlToDelete: string | null = null;

  if (isJson) {
    // ---- Blob-URL flow ----
    let body: { blobUrl?: string; sessionId?: string };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { ok: false, error: "Invalid JSON body." },
        { status: 400 },
      );
    }

    const blobUrl = String(body.blobUrl || "").trim();
    if (!blobUrl) {
      return NextResponse.json(
        { ok: false, error: "blobUrl is required" },
        { status: 400 },
      );
    }
    // Lock the host to Vercel Blob to prevent SSRF via an attacker-controlled URL.
    let parsed: URL;
    try {
      parsed = new URL(blobUrl);
    } catch {
      return NextResponse.json({ ok: false, error: "Invalid blobUrl" }, { status: 400 });
    }
    if (!/\.public\.blob\.vercel-storage\.com$/i.test(parsed.hostname)) {
      return NextResponse.json(
        { ok: false, error: "blobUrl must be a Vercel Blob URL" },
        { status: 400 },
      );
    }

    sessionIdInput = String(body.sessionId || "").trim();
    blobUrlToDelete = blobUrl;

    // Fetch the PDF from blob storage (server-side, on Vercel's network).
    const fetched = await fetch(blobUrl);
    if (!fetched.ok) {
      return NextResponse.json(
        { ok: false, error: `Could not read upload (HTTP ${fetched.status})` },
        { status: 502 },
      );
    }
    const ab = await fetched.arrayBuffer();
    buffer = Buffer.from(ab);

    if (buffer.length === 0) {
      return NextResponse.json({ ok: false, error: "Empty file" }, { status: 400 });
    }
    if (buffer.length > MAX_SIZE_BYTES) {
      // Defense in depth — handleUpload already enforces this on the token.
      return NextResponse.json(
        {
          ok: false,
          error: `File is ${(buffer.length / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_SIZE_BYTES / 1024 / 1024} MB.`,
        },
        { status: 413 },
      );
    }

    const ctype = fetched.headers.get("content-type") || "";
    const pathFilename = decodeURIComponent(parsed.pathname.split("/").pop() || "");
    filename = pathFilename || filename;
    const looksPdf =
      ALLOWED_TYPES.has(ctype) || filename.toLowerCase().endsWith(".pdf");
    if (!looksPdf) {
      return NextResponse.json(
        {
          ok: false,
          error: `Only PDF uploads are supported right now. Got "${ctype || "unknown"}".`,
        },
        { status: 415 },
      );
    }
  } else {
    // ---- Multipart fallback (small files / no Blob store configured) ----
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return NextResponse.json(
        { ok: false, error: "Invalid multipart form data." },
        { status: 400 },
      );
    }

    sessionIdInput = String(form.get("sessionId") || "").trim();

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
          error: `File is ${(blob.size / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_SIZE_BYTES / 1024 / 1024} MB.`,
        },
        { status: 413 },
      );
    }
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
    filename = blob.name || filename;
    buffer = Buffer.from(await blob.arrayBuffer());
  }

  // ---- Validate sessionId (shared by both flows) ----
  if (sessionIdInput && !UUID_RE.test(sessionIdInput)) {
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
  let sessionId = sessionIdInput;
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

  // ---- Extract + chunk + embed + persist ----
  try {
    const result = await documents.indexUploadedPdf(userId, sessionId, {
      filename,
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
  } finally {
    // The PDF is now persisted as chunks in Postgres; the blob is no
    // longer needed. Best-effort delete — leaving an orphan blob is not
    // worth failing the request for.
    if (blobUrlToDelete) {
      deleteBlob(blobUrlToDelete).catch(() => {});
    }
  }
}
