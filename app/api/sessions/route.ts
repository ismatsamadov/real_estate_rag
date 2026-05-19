/**
 * GET  /api/sessions       — list current user's chat sessions
 * POST /api/sessions       — create an empty session (returns the id)
 */
import { NextResponse } from "next/server";
import { getUserId } from "../_auth";
import sessions from "../../../src/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const userId = getUserId(req);
  const rows = await sessions.listSessions(userId);
  return NextResponse.json({ ok: true, sessions: rows });
}

export async function POST(req: Request) {
  const userId = getUserId(req);
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    /* empty body is fine */
  }
  const created = await sessions.createSession(userId, {
    title: typeof body?.title === "string" ? body.title.slice(0, 200) : null,
  });
  return NextResponse.json({ ok: true, session: created });
}
