/**
 * SSE streaming RAG endpoint with persistent chat sessions.
 *
 *   POST { question, sessionId?, topK?, mode?, rerank?, filters? }
 *   -> text/event-stream
 *
 *   1. Resolves user_id from the auth helper.
 *   2. Persists the user message (auto-creates the session on first turn).
 *   3. Emits a `session` event so the client can route to /c/[id].
 *   4. Loads recent history and passes it to rag.askStream for multi-turn
 *      context (Anthropic messages array; system prompt stays cached).
 *   5. Collects assistant deltas + final metadata and persists the
 *      assistant message + sources + usage at stream end.
 *
 * Runs on Node.js runtime (NOT Edge) so we can require() the CommonJS src/
 * modules and use the pg driver.
 */
import { z } from "zod";
import { getUserId } from "../../_auth";
import { askStream } from "../../../../src/rag";
import sessions from "../../../../src/sessions";
import memory from "../../../../src/memory";
import { classifyError } from "../../../../src/errors";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const bodySchema = z.object({
  question: z.string().min(1).max(4000),
  sessionId: z.string().regex(UUID_RE, "sessionId must be a UUID").optional().nullable(),
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

export async function POST(request: Request) {
  const userId = getUserId(request);

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

  const { question, sessionId: inputSessionId } = parsed.data;

  // 1) Persist the user message (auto-creates session on first turn).
  let appended;
  try {
    appended = await sessions.appendUserMessage(userId, inputSessionId || null, question);
  } catch (err: any) {
    return new Response(
      JSON.stringify({ ok: false, error: err?.message || "Failed to persist message." }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }
  if (!appended) {
    return new Response(JSON.stringify({ ok: false, error: "Session not found." }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  const sessionId: string = appended.sessionId;

  // 2) Load recent history EXCLUDING the user message we just appended —
  //    rag.askStream adds the current turn itself with fresh sources.
  let history: Array<{ role: string; content: string }> = [];
  try {
    const all = await sessions.recentHistory(userId, sessionId, {
      limit: sessions.HISTORY_LIMIT + 1,
    });
    if (all.length && all[all.length - 1].role === "user") all.pop();
    history = all;
  } catch (err: any) {
    console.warn("history load failed:", err?.message);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: any) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          /* stream closed */
        }
      };

      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          /* closed */
        }
      }, 15_000);

      // 3) Tell the client which session this turn belongs to (especially
      //    important when sessionId was auto-created).
      send({ type: "session", sessionId, isNew: appended.isNewSession });

      // Accumulate state for assistant-message persistence at stream end.
      let finalSources: any = null;
      let finalRetrieval: any = null;
      let finalModel: string | null = null;
      let finalUsage: any = null;
      let finalStopReason: string | null = null;
      let answerBuf = "";

      try {
        for await (const event of askStream(question, {
          topK: parsed.data.topK,
          candidateK: parsed.data.candidateK,
          mode: parsed.data.mode,
          rerank: parsed.data.rerank,
          filters: parsed.data.filters,
          history,
          userId,
          sessionId,
        })) {
          if (event.type === "sources") {
            finalSources = event.sources;
            finalRetrieval = {
              mode: event.mode,
              reranked: event.reranked,
              fallback: event.fallback,
              cached: event.cached,
              topK: event.topK,
            };
          } else if (event.type === "model") {
            finalModel = event.model;
          } else if (event.type === "delta") {
            answerBuf += event.text;
          } else if (event.type === "usage") {
            finalUsage = event.usage;
          } else if (event.type === "done") {
            finalStopReason = event.stop_reason;
          }
          send(event);
        }
        send({ type: "end" });
      } catch (err: any) {
        // Use the pre-attached classification if the LLM layer set it,
        // otherwise classify here. Falls back gracefully for any error
        // source (Postgres, Voyage, network).
        const cls = err?.classified || classifyError(err);
        console.warn("ask/stream error:", cls.kind, cls.devMessage);
        send({
          type: "error",
          kind: cls.kind,
          error: cls.userMessage,
          retryable: cls.retryable,
          status: cls.status,
        });
      } finally {
        clearInterval(heartbeat);

        // 4) Persist the assistant message + sources + metadata. Best-effort —
        //    failure here shouldn't fail the user-visible request.
        let assistantMessageId: number | null = null;
        if (answerBuf) {
          try {
            const persisted = await sessions.appendAssistantMessage(userId, sessionId, {
              content: answerBuf,
              sources: finalSources,
              metadata: {
                model: finalModel,
                usage: finalUsage,
                stop_reason: finalStopReason,
                retrieval: finalRetrieval,
              },
            });
            assistantMessageId = persisted?.messageId ?? null;
          } catch (err: any) {
            console.warn("assistant persist failed:", err?.message);
          }

          // 5) Persist memory for cross-session recall (best-effort).
          //    appendMemory applies its own keep/skip heuristics
          //    (refusal detection, citation presence, length, language).
          //    Awaiting here costs ~300ms and runs after the SSE end event.
          //    Also skip if streaming aborted before reaching end_turn —
          //    a partial answer isn't worth retaining as durable memory.
          if (finalStopReason === "end_turn") {
            try {
              await memory.appendMemory(userId, {
                sessionId,
                messageId: assistantMessageId,
                question,
                answer: answerBuf,
              });
            } catch (err: any) {
              console.warn("memory persist failed:", err?.message);
            }
          }
        }
        try {
          controller.close();
        } catch {
          /* already closed */
        }
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
