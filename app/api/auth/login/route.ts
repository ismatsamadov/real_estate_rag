/**
 * Demo auth endpoint. Single shared credential pair (env-configured) gates
 * the live demo. NOT production auth — swap to NextAuth + a real IdP later.
 */
import { NextResponse } from "next/server";
import config from "../../../../src/config";

export const runtime = "nodejs";

const COOKIE_NAME = "pasha_session";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

export async function POST(request: Request) {
  let body: { username?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  const u = String(body.username || "").trim();
  const p = String(body.password || "");
  if (u !== config.auth.username || p !== config.auth.password) {
    // Constant-ish delay so this doesn't trivially leak username validity in dev tools.
    await new Promise((r) => setTimeout(r, 300));
    return NextResponse.json(
      { ok: false, error: "Invalid username or password." },
      { status: 401 },
    );
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, "ok", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });
  return res;
}
