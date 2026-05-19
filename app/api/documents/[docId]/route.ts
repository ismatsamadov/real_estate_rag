/**
 * DELETE /api/documents/[docId]?sessionId=...   — remove an uploaded doc
 */
import { NextResponse } from "next/server";
import { getUserId } from "../../_auth";

const documents = require("../../../../src/documents");
const sessions = require("../../../../src/sessions");

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function DELETE(req: Request, { params }: { params: Promise<{ docId: string }> }) {
  const userId = getUserId(req);
  const { docId } = await params;
  const sessionId = new URL(req.url).searchParams.get("sessionId");
  if (!sessionId || !UUID_RE.test(sessionId)) {
    return NextResponse.json({ ok: false, error: "sessionId required" }, { status: 400 });
  }
  const sess = await sessions.getSession(userId, sessionId);
  if (!sess) {
    return NextResponse.json({ ok: false, error: "Session not found" }, { status: 404 });
  }
  const ok = await documents.deleteUploadedDoc(sessionId, docId);
  if (!ok) {
    return NextResponse.json({ ok: false, error: "Document not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
