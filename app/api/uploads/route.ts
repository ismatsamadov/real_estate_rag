/**
 * GET /api/uploads
 *   Library view: every PDF this user has uploaded across every session.
 *   Owner check is enforced inside listAllUploadsForUser (joins through
 *   sessions on user_id, so other users' uploads never leak in).
 */
import { NextResponse } from "next/server";
import { getUserId } from "../_auth";

const documents = require("../../../src/documents");

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const userId = getUserId(req);
  const uploads = await documents.listAllUploadsForUser(userId);
  return NextResponse.json({ ok: true, uploads });
}
