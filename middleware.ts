import { NextResponse, type NextRequest } from "next/server";

// Routes that don't require auth.
const PUBLIC_PATHS = new Set([
  "/login",
  "/api/auth/login",
  "/api/health",
]);

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Always allow static asset URLs (handled by config.matcher below too, defensive).
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname.startsWith("/public") ||
    PUBLIC_PATHS.has(pathname)
  ) {
    return NextResponse.next();
  }

  const session = req.cookies.get("pasha_session")?.value;
  if (session === "ok") return NextResponse.next();

  // For non-API requests, redirect to /login keeping the original destination.
  if (!pathname.startsWith("/api/")) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  // For API requests, return 401.
  return new NextResponse(
    JSON.stringify({ ok: false, error: "Unauthorized" }),
    { status: 401, headers: { "content-type": "application/json" } },
  );
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|public).*)"],
};
