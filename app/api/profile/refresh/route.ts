/**
 * POST /api/profile/refresh — synchronously rebuild the LLM-derived summary.
 * Returns the updated profile so the UI can show it without polling.
 */
import { NextResponse } from "next/server";
import { getUserId } from "../../_auth";

const profile = require("../../../../src/profile");

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const userId = getUserId(req);
  const updated = await profile.forceRefresh(userId);
  return NextResponse.json({ ok: true, profile: updated });
}
