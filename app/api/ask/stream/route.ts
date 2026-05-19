/**
 * SSE streaming RAG endpoint.
 *
 *   POST { question, topK?, mode?, rerank?, filters? }
 *   -> text/event-stream
 *
 * Runs on Node.js runtime (NOT Edge) so we can require() the existing
 * CommonJS modules in src/ and use the Postgres `pg` driver. Edge would
 * also block us from streaming with the Anthropic SDK in its current shape.
 */

// CommonJS src/ modules — ESM<->CJS interop handles named exports.
import { z } from "zod";
import { askStream } from "../../../../src/rag";

export const runtime = "nodejs";
// 300s ceiling on Vercel Pro (Hobby = 300s too with fluid compute). Claude
// Sonnet answers usually complete in 5-30s; this is a generous safety net.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  question: z.string().min(1).max(4000),
  topK: z.coerce.number().int().min(1).max(20).optional(),
  candidateK: z.coerce.number().int().min(1).max(100).optional(),
  mode: z.enum(["hybrid", "vector", "lexical"]).optional(),
  rerank: z.coerce.boolean().optional(),
  filters: z
    .object({
      language: z.union([z.string(), z.array(z.string())]).optional(),
      doc_type: z.union([z.string(), z.array(z.string())]).optional(),
      listing_type: z.string().optional(),
      property_type: z.string().optional(),
      price_min: z.coerce.number().optional(),
      price_max: z.coerce.number().optional(),
      bedrooms_min: z.coerce.number().optional(),
      bedrooms_max: z.coerce.number().optional(),
    })
    .optional(),
});

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "Invalid JSON body." }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: parsed.error.issues.map((i) => i.message).join("; "),
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      // Heartbeat so proxies don't kill an idle stream during retrieval.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          /* stream closed */
        }
      }, 15_000);

      try {
        for await (const event of askStream(parsed.data.question, {
          topK: parsed.data.topK,
          candidateK: parsed.data.candidateK,
          mode: parsed.data.mode,
          rerank: parsed.data.rerank,
          filters: parsed.data.filters,
        })) {
          send(event);
        }
        send({ type: "end" });
      } catch (err) {
        send({ type: "error", error: err?.message || "Internal error." });
      } finally {
        clearInterval(heartbeat);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
