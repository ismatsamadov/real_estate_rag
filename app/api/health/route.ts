/**
 * Health endpoint. Returns 200 if Postgres is reachable, 503 otherwise.
 */
import config from "../../../src/config";
import db from "../../../src/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  let ok = false;
  try {
    ok = await db.ping();
  } catch {
    ok = false;
  }
  return new Response(
    JSON.stringify({
      ok,
      service: "real-estate-rag",
      embedding: { model: config.embedding.model, dim: config.embedding.dim },
      retrieval: {
        mode: config.retrieval.mode,
        topK: config.retrieval.topK,
        rerank: config.retrieval.rerank,
      },
      anthropic: { model: config.anthropic.defaultModel },
    }),
    {
      status: ok ? 200 : 503,
      headers: { "content-type": "application/json" },
    },
  );
}
