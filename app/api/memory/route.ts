/**
 * GET    /api/memory          — stats (total, oldest, newest)
 * DELETE /api/memory          — wipe ALL memory for the current user
 *                               (one-click "forget everything" — useful for
 *                                live demos, GDPR-style erasure, debugging)
 */
import { NextResponse } from "next/server";
import { getUserId } from "../_auth";
import memory from "../../../src/memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const userId = getUserId(req);
  const stats = await memory.memoryStats(userId);
  return NextResponse.json({ ok: true, stats });
}

export async function DELETE(req: Request) {
  const userId = getUserId(req);
  const deleted = await memory.clearMemory(userId);
  return NextResponse.json({ ok: true, deleted });
}
