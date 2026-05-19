/**
 * DELETE /api/favorites/[id]            — unsave by row id (alt to ?doc_id=)
 * PATCH  /api/favorites/[id] {note}     — edit the note on a saved listing
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getUserId } from "../../_auth";
import favorites from "../../../../src/favorites";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchBody = z.object({
  note: z.string().max(2000).nullable(),
});

function parseId(s: string): number | null {
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = getUserId(req);
  const { id } = await params;
  const numeric = parseId(id);
  if (!numeric) {
    return NextResponse.json({ ok: false, error: "Invalid id" }, { status: 400 });
  }
  const ok = await favorites.removeFavorite(userId, numeric);
  if (!ok) {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = getUserId(req);
  const { id } = await params;
  const numeric = parseId(id);
  if (!numeric) {
    return NextResponse.json({ ok: false, error: "Invalid id" }, { status: 400 });
  }
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = patchBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") },
      { status: 400 },
    );
  }
  const row = await favorites.updateNote(userId, numeric, parsed.data.note);
  if (!row) {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, favorite: row });
}
