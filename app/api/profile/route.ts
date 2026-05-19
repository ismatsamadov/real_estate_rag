/**
 * GET    /api/profile           — read the current user's intent context
 *                                 (summary + favorites + recent topics + uploads + counts).
 *                                 What the LLM sees about you, every turn.
 * POST   /api/profile/refresh   — force a refresh of the LLM-derived summary
 *                                 (bypasses the 60s / 3-signal throttle).
 *                                 Useful for testing or manual "rebuild me".
 * DELETE /api/profile           — wipe the cached summary (signals stay,
 *                                 they're computed from other tables).
 */
import { NextResponse } from "next/server";
import { getUserId } from "../_auth";

const profile = require("../../../src/profile");

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const userId = getUserId(req);
  const context = await profile.getUserContext(userId);
  return NextResponse.json({ ok: true, profile: context });
}

export async function DELETE(req: Request) {
  const userId = getUserId(req);
  const deleted = await profile.clearProfile(userId);
  return NextResponse.json({ ok: true, deleted });
}
