/**
 * Next.js instrumentation entry point — runs once per server boot.
 *
 * The actual DB work lives in `./instrumentation-node` and is loaded with
 * a DYNAMIC import gated by NEXT_RUNTIME. This is the Next.js-blessed
 * pattern: it keeps `pg` (Node-only) out of the edge bundle, so the
 * webpack tree-shaker doesn't try to resolve `fs` / `path` for the edge
 * runtime.
 *
 * See: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
