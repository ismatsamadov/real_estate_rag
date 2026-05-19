/**
 * Auth helper used by API routes.
 *
 * Today: single-user demo gated by middleware.ts. Every authenticated
 * request maps to the shared DEMO_USERNAME. Sessions are keyed by this
 * user_id so the data model is already multi-tenant-ready — when real
 * auth lands (NextAuth + IdP), only this function changes; it returns
 * the JWT subject claim from the request cookie/header.
 */
import config from "../../src/config";

export function getUserId(_req: Request): string {
  // The middleware already verified the cookie. The cookie value is opaque
  // ("ok") today; we tag every session with the configured DEMO_USERNAME.
  return config.auth.username;
}

export function unauthorized(message = "Unauthorized") {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}
