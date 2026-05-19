/**
 * GET    /api/sessions/[id]                  — return session + ordered messages
 * PATCH  /api/sessions/[id]  { title? }      — rename. title="" or null clears it
 *                                              and lets the next message re-derive
 * DELETE /api/sessions/[id]                  — delete session (cascades to messages)
 */
import { NextResponse } from "next/server";
import { getUserId } from "../../_auth";
import sessions from "../../../../src/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = getUserId(req);
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "Invalid session id" }, { status: 400 });
  }
  const session = await sessions.getSession(userId, id);
  if (!session) {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }
  const messages = await sessions.listMessages(userId, id);
  return NextResponse.json({ ok: true, session, messages });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = getUserId(req);
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "Invalid session id" }, { status: 400 });
  }
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || !("title" in body)) {
    return NextResponse.json(
      { ok: false, error: "Body must include 'title' (string or null)" },
      { status: 400 },
    );
  }
  const { title } = body;
  if (title != null && typeof title !== "string") {
    return NextResponse.json(
      { ok: false, error: "title must be a string or null" },
      { status: 400 },
    );
  }
  const updated = await sessions.renameSession(userId, id, title);
  if (!updated) {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, session: updated });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = getUserId(req);
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "Invalid session id" }, { status: 400 });
  }
  const ok = await sessions.deleteSession(userId, id);
  if (!ok) {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
