/**
 * GET    /api/memory          — stats (total, oldest, newest)
 * DELETE /api/memory          — wipe ALL memory for the current user
 *                               (one-click "forget everything" — useful for
 *                                live demos, GDPR-style erasure, debugging)
 */
import { NextResponse } from "next/server";
import { getUserId } from "../_auth";
import memory from "../../../src/memory";
const profile = require("../../../src/profile");

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const userId = getUserId(req);
  const stats = await memory.memoryStats(userId);
  return NextResponse.json({ ok: true, stats });
}

export async function DELETE(req: Request) {
  const userId = getUserId(req);
  // Wiping memory also invalidates the LLM-derived intent summary — it was
  // synthesized from memory + favorites + uploads, and the user just said
  // "forget me." Signals can still be re-derived from any remaining data;
  // the cached summary text is what we erase here.
  const [deleted] = await Promise.all([
    memory.clearMemory(userId),
    profile.clearProfile(userId),
  ]);
  return NextResponse.json({ ok: true, deleted });
}
