/**
 * GET    /api/favorites              — list current user's saved listings
 * POST   /api/favorites {doc_id,note} — save a listing (idempotent)
 * DELETE /api/favorites?doc_id=...    — unsave by doc_id (UI calls this from the heart)
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getUserId } from "../_auth";
import favorites from "../../../src/favorites";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const postBody = z.object({
  doc_id: z.string().min(1).max(64),
  note: z.string().max(2000).optional().nullable(),
});

export async function GET(req: Request) {
  const userId = getUserId(req);
  const rows = await favorites.listFavorites(userId);
  return NextResponse.json({ ok: true, favorites: rows });
}

export async function POST(req: Request) {
  const userId = getUserId(req);
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = postBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") },
      { status: 400 },
    );
  }
  const result = await favorites.addFavorite(
    userId,
    parsed.data.doc_id,
    parsed.data.note ?? null,
  );
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true, favorite: result.favorite });
}

export async function DELETE(req: Request) {
  const userId = getUserId(req);
  const url = new URL(req.url);
  const docId = url.searchParams.get("doc_id");
  if (!docId) {
    return NextResponse.json({ ok: false, error: "doc_id required" }, { status: 400 });
  }
  const ok = await favorites.removeFavoriteByDoc(userId, docId);
  if (!ok) {
    return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
