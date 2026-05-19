/**
 * Node-only instrumentation body. Imported dynamically by
 * `instrumentation.ts` when NEXT_RUNTIME === "nodejs".
 *
 * Job: bootstrap the Postgres schema (tables, indexes, FKs, extensions)
 * so the first request lands on a ready database. Replaces the old
 * `scripts/migrate.js` CLI.
 *
 * Idempotent — every CREATE is gated by IF NOT EXISTS and FK additions
 * are guarded by information_schema lookups. Safe to call on every cold
 * boot of every server.
 */

const db = require("./src/db");

(async () => {
  try {
    await db.ensureSchema();
    // eslint-disable-next-line no-console
    console.log("[instrumentation] schema ready");
  } catch (err: any) {
    // Don't crash the server — surface the error and let DB-touching
    // routes fail loudly. This avoids a misconfigured DATABASE_URL
    // killing static pages and the login form.
    // eslint-disable-next-line no-console
    console.error("[instrumentation] ensureSchema failed:", err?.message || err);
  }
})();
