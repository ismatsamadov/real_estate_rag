"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { upload } from "@vercel/blob/client";
import { useFavorites } from "./FavoritesContext";

type MemoryChip = {
  mid: string;
  content: string;
  created_at: string;
  similarity: number;
};

type ChatError = {
  kind: string;
  message: string;
  retryable: boolean;
  status: number | null;
};

type ChatMessage = {
  id?: number | string;
  role: "user" | "assistant";
  content: string;
  sources?: any[] | null;
  metadata?: any;
  streaming?: boolean;
  retrieval?: any;
  rewritten?: { original: string; rewritten: string } | null;
  memories?: MemoryChip[] | null;
  error?: ChatError | null;
};

const EXAMPLES = [
  "What apartments are available at The Residences at the St. Regis Baku?",
  "Compare unit sizes at Crescent Residences vs Knightsbridge",
  "Какие квартиры доступны в Ritz-Carlton Residences?",
  "Knightsbridge Residence-də neçə otaqlı mənzillər var?",
];

export default function ChatView({
  sessionId,
  onSessionCreated,
}: {
  sessionId: string | null;
  onSessionCreated: (id: string) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [activeSid, setActiveSid] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Uploaded documents for this session.
  type UploadedDoc = {
    doc_id: string;
    title: string;
    total_pages?: number | null;
    chunk_count?: number | null;
    size_kb?: number | null;
    uploading?: boolean;
    error?: string | null;
  };
  const [uploadedDocs, setUploadedDocs] = useState<UploadedDoc[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Load history when sessionId changes.
  useEffect(() => {
    if (!sessionId) {
      setMessages([]);
      setUploadedDocs([]);
      return;
    }
    // Also pull any uploaded documents already attached to this session
    // (e.g. after a reload).
    fetch(`/api/documents?sessionId=${sessionId}`, { credentials: "include" })
      .then((r) => r.json())
      .then((d) => {
        if (d?.ok && Array.isArray(d.documents)) setUploadedDocs(d.documents);
      })
      .catch(() => {});
    let cancelled = false;
    setLoadingHistory(true);
    (async () => {
      try {
        const resp = await fetch(`/api/sessions/${sessionId}`, { credentials: "include" });
        const data = await resp.json();
        if (cancelled) return;
        if (data?.ok && Array.isArray(data.messages)) {
          setMessages(
            data.messages.map((m: any) => ({
              id: m.id,
              role: m.role,
              content: m.content,
              sources: m.sources,
              metadata: m.metadata,
              retrieval: m.metadata?.retrieval || null,
            })),
          );
        }
      } finally {
        if (!cancelled) setLoadingHistory(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // Autoscroll on new content.
  useEffect(() => {
    if (!threadRef.current) return;
    threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [messages, streaming]);

  // Auto-resize textarea.
  useEffect(() => {
    if (!inputRef.current) return;
    inputRef.current.style.height = "0px";
    inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, 200) + "px";
  }, [input]);

  const submit = useCallback(
    async (qOverride?: string) => {
      const q = (qOverride ?? input).trim();
      if (!q || streaming) return;
      setInput("");
      setStreaming(true);

      const userMsg: ChatMessage = { role: "user", content: q };
      const placeholder: ChatMessage = {
        role: "assistant",
        content: "",
        streaming: true,
        sources: null,
      };
      setMessages((prev) => [...prev, userMsg, placeholder]);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const resp = await fetch("/api/ask/stream", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ question: q, sessionId }),
          signal: controller.signal,
          credentials: "include",
        });
        if (!resp.ok || !resp.body) {
          const j = await resp.json().catch(() => ({}));
          throw new Error(j.error || `HTTP ${resp.status}`);
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let createdSession: string | null = null;

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() || "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(":")) continue;
            if (!trimmed.startsWith("data:")) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload) continue;
            let event: any;
            try {
              event = JSON.parse(payload);
            } catch {
              continue;
            }

            if (event.type === "session") {
              if (event.isNew && event.sessionId !== sessionId) {
                createdSession = event.sessionId;
              }
            } else if (event.type === "sources") {
              setMessages((prev) => updateLast(prev, (m) => ({
                ...m,
                sources: event.sources,
                retrieval: {
                  mode: event.mode,
                  reranked: event.reranked,
                  fallback: event.fallback,
                  cached: event.cached,
                  topK: event.topK,
                },
              })));
            } else if (event.type === "rewritten") {
              setMessages((prev) => updateLast(prev, (m) => ({
                ...m,
                rewritten: { original: event.original, rewritten: event.rewritten },
              })));
            } else if (event.type === "memories") {
              setMessages((prev) => updateLast(prev, (m) => ({
                ...m,
                memories: event.memories,
              })));
            } else if (event.type === "delta") {
              setMessages((prev) => updateLast(prev, (m) => ({
                ...m,
                content: (m.content || "") + event.text,
              })));
            } else if (event.type === "model") {
              setMessages((prev) => updateLast(prev, (m) => ({
                ...m,
                metadata: { ...(m.metadata || {}), model: event.model },
              })));
            } else if (event.type === "usage") {
              setMessages((prev) => updateLast(prev, (m) => ({
                ...m,
                metadata: { ...(m.metadata || {}), usage: event.usage },
              })));
            } else if (event.type === "done") {
              setMessages((prev) => updateLast(prev, (m) => ({
                ...m,
                streaming: false,
              })));
            } else if (event.type === "error") {
              setMessages((prev) => updateLast(prev, (m) => ({
                ...m,
                streaming: false,
                error: {
                  kind: event.kind || "unknown",
                  message: event.error || "Something went wrong.",
                  retryable: Boolean(event.retryable),
                  status: event.status ?? null,
                },
              })));
            }
          }
        }

        if (createdSession) onSessionCreated(createdSession);
      } catch (err: any) {
        if (err?.name === "AbortError") {
          setMessages((prev) => updateLast(prev, (m) => ({
            ...m,
            streaming: false,
          })));
        } else {
          // Client-side network failure before any SSE event arrived.
          setMessages((prev) => updateLast(prev, (m) => ({
            ...m,
            streaming: false,
            error: {
              kind: "network",
              message: "Couldn't reach the server. Check your connection and try again.",
              retryable: true,
              status: null,
            },
          })));
        }
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [input, streaming, sessionId, onSessionCreated],
  );

  const cancel = () => abortRef.current?.abort();

  // -------------- Document upload --------------
  const uploadFile = useCallback(
    async (file: File) => {
      // Optimistic placeholder so the chip shows a "uploading…" state.
      const placeholderId = `pending-${Date.now()}`;
      const placeholder: UploadedDoc = {
        doc_id: placeholderId,
        title: file.name,
        uploading: true,
      };
      setUploadedDocs((prev) => [placeholder, ...prev]);

      // Vercel serverless functions cap request bodies at ~4.5 MB. Anything
      // larger has to take the Blob detour: the browser PUTs the PDF
      // directly to Vercel Blob, then we hand the URL to the indexing
      // route. Below the cap, we use the plain multipart path so users
      // without a Blob store configured can still upload small PDFs.
      const NEEDS_BLOB_BYTES = 4 * 1024 * 1024;

      try {
        let resp: Response;
        if (file.size > NEEDS_BLOB_BYTES) {
          const blob = await upload(file.name, file, {
            access: "public",
            handleUploadUrl: "/api/documents/upload-token",
            contentType: file.type || "application/pdf",
          });
          resp = await fetch("/api/documents", {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              blobUrl: blob.url,
              ...(sessionId ? { sessionId } : {}),
            }),
          });
        } else {
          const form = new FormData();
          form.append("file", file);
          if (sessionId) form.append("sessionId", sessionId);
          resp = await fetch("/api/documents", {
            method: "POST",
            body: form,
            credentials: "include",
          });
        }
        const data = await resp.json();
        if (!resp.ok || !data?.ok) {
          throw new Error(data?.error || `Upload failed (HTTP ${resp.status})`);
        }
        // If the server auto-created the session for us, propagate that.
        if (!sessionId && data.sessionId) {
          onSessionCreated(data.sessionId);
        }
        // Replace the placeholder with the canonical row from the server.
        setUploadedDocs((prev) =>
          prev.map((d) =>
            d.doc_id === placeholderId
              ? {
                  doc_id: data.document.docId,
                  title: data.document.title,
                  total_pages: data.document.totalPages,
                  chunk_count: data.document.totalChunks,
                  size_kb: data.document.sizeKb,
                }
              : d,
          ),
        );
      } catch (err: any) {
        setUploadedDocs((prev) =>
          prev.map((d) =>
            d.doc_id === placeholderId
              ? { ...d, uploading: false, error: err?.message || "Upload failed" }
              : d,
          ),
        );
        // Auto-remove the failed chip after a few seconds.
        setTimeout(() => {
          setUploadedDocs((prev) => prev.filter((d) => d.doc_id !== placeholderId));
        }, 6000);
      }
    },
    [sessionId, onSessionCreated],
  );

  const removeUpload = useCallback(
    async (docId: string) => {
      // Always remove the chip optimistically. The previous guard returned
      // before this line on fresh chats (sessionId not yet propagated) and
      // on upload-error chips, making the X look dead.
      setUploadedDocs((prev) => prev.filter((d) => d.doc_id !== docId));

      // Skip the server DELETE for placeholder/error chips (no DB row yet)
      // and when we have no session id to scope the call.
      if (!sessionId || docId.startsWith("pending-")) return;
      try {
        await fetch(
          `/api/documents/${encodeURIComponent(docId)}?sessionId=${sessionId}`,
          { method: "DELETE", credentials: "include" },
        );
      } catch {
        // best-effort
      }
    },
    [sessionId],
  );

  const isEmpty = messages.length === 0 && !loadingHistory;

  return (
    <div className="relative flex flex-col h-[calc(100svh-3.5rem)] sm:h-[calc(100svh-4rem)]">
      {/* svh (small viewport height) so iOS Safari's collapsible URL bar
          doesn't push the composer out of view. */}
      {/* Thread */}
      <div ref={threadRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 sm:px-6 py-6 lg:py-10">
          {loadingHistory && (
            <div className="space-y-6">
              <Skeleton align="right" />
              <Skeleton />
            </div>
          )}

          {isEmpty && (
            <EmptyState onExample={(q) => submit(q)} />
          )}

          {messages.map((m, i) =>
            m.role === "user" ? (
              <UserBubble key={i} content={m.content} />
            ) : (
              <AssistantBlock
                key={i}
                msg={m}
                activeSid={activeSid}
                setActiveSid={setActiveSid}
                onRetry={() => {
                  // Find the user message immediately preceding this assistant block.
                  const prev = messages[i - 1];
                  if (prev && prev.role === "user") submit(prev.content);
                }}
              />
            ),
          )}
        </div>
      </div>

      {/* Composer — sticks to bottom; safe-pb respects iPhone home bar. */}
      <div className="border-t border-zinc-200/70 bg-white/80 backdrop-blur-md">
        <div className="mx-auto max-w-3xl px-3 sm:px-6 py-2 sm:py-3 safe-pb">
          {/* Uploaded-doc chips */}
          {uploadedDocs.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {uploadedDocs.map((d) => (
                <UploadedDocChip
                  key={d.doc_id}
                  doc={d}
                  onRemove={() => removeUpload(d.doc_id)}
                />
              ))}
            </div>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
            className="flex items-end gap-2"
          >
            {/* Hidden file input + paperclip trigger */}
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf,.pdf"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadFile(f);
                // Reset so picking the same file twice still fires onChange.
                if (e.target) e.target.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={streaming}
              aria-label="Upload PDF"
              title="Upload a PDF to ask questions about it"
              className="flex-none w-11 h-11 sm:w-12 sm:h-12 inline-flex items-center justify-center rounded-xl border border-zinc-200 bg-white/70 hover:bg-white hover:border-brand-500/60 transition-colors text-ink-muted hover:text-brand-700 disabled:opacity-40"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path d="M21 12.5V7a4 4 0 0 0-8 0v10a2.5 2.5 0 0 0 5 0V8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>

            <div className="flex-1 relative glass rounded-2xl">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submit();
                  }
                }}
                placeholder={
                  uploadedDocs.length
                    ? "Ask about the uploaded document(s) or the corpus…"
                    : messages.length
                    ? "Ask a follow-up… (Shift+Enter for newline)"
                    : "Ask about a property, amenities, prices…"
                }
                rows={1}
                disabled={streaming && !abortRef.current}
                className="w-full resize-none px-4 py-3.5 pr-12 text-[15px] bg-transparent placeholder:text-ink-muted/80 focus:outline-none rounded-2xl"
              />
            </div>
            {streaming ? (
              <button type="button" onClick={cancel} className="btn-stop self-stretch">
                <span className="w-2.5 h-2.5 rounded-[3px] bg-ink" />
                Stop
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim()}
                className="btn-primary self-stretch px-4 py-3.5"
                aria-label="Send"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" aria-hidden>
                  <path d="M5 12h14M13 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
          </form>
          <div className="mt-2 text-[0.68rem] text-ink-muted text-center tracking-[0.04em]">
            Grounded answers · multilingual EN · AZ · RU · history persisted in Neon
          </div>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------
   Subcomponents
   ------------------------------------------------------------------------- */

function EmptyState({ onExample }: { onExample: (q: string) => void }) {
  return (
    <div className="py-12 sm:py-20">
      <div className="text-center mb-10">
        <div className="inline-flex items-center gap-2 mb-4 px-3 py-1 rounded-full border border-zinc-200/80 bg-white/60 text-[0.7rem] tracking-[0.18em] uppercase text-ink-muted">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 pulse-dot" />
          Live · grounded · EN · AZ · RU
        </div>
        <h1 className="font-display text-4xl sm:text-5xl leading-tight tracking-tight">
          Baku&rsquo;s premium real estate,
          <br />
          <span className="italic font-light text-brand-700">answered with sources.</span>
        </h1>
        <p className="mt-4 text-ink-muted max-w-xl mx-auto">
          Ask anything about The Residences at the St.&nbsp;Regis Baku, Crescent
          Residences, Knightsbridge, Ritz-Carlton Residences, or Mardi Mekan
          Estate. Every claim links to its source.
        </p>
      </div>
      <div className="grid sm:grid-cols-2 gap-2 max-w-xl mx-auto">
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            onClick={() => onExample(ex)}
            className="text-left text-sm px-4 py-3 bg-white border border-zinc-200 rounded-xl hover:border-brand-500/60 hover:shadow-card transition-all"
          >
            <span className="text-ink-muted hover:text-ink">{ex}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function UserBubble({ content }: { content: string }) {
  return (
    <div className="flex justify-end mb-6 fade-up">
      <div className="max-w-[85%] sm:max-w-[75%] bg-ink text-white rounded-2xl rounded-tr-md px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap shadow-sm">
        {content}
      </div>
    </div>
  );
}

function AssistantBlock({
  msg,
  activeSid,
  setActiveSid,
  onRetry,
}: {
  msg: ChatMessage;
  activeSid: string | null;
  setActiveSid: (sid: string) => void;
  onRetry?: () => void;
}) {
  // Per-message disclosure state. Sources stay collapsed by default to
  // keep the chat flow clean; clicking the toggle OR a [Sn] citation
  // pill in the answer expands the panel and scrolls to the matching card.
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const sourceRefs = useRef<Record<string, HTMLElement | null>>({});
  const sourcesPanelRef = useRef<HTMLDivElement | null>(null);

  // Citation click handler — first expand if needed, then on next tick
  // scroll to the matching card (refs exist only after expansion).
  const onCite = (sid: string) => {
    setActiveSid(sid);
    setSourcesOpen(true);
    requestAnimationFrame(() => {
      const el = sourceRefs.current[sid];
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };

  const meta = msg.metadata || {};
  const retrieval = msg.retrieval || meta.retrieval;
  const usage = meta.usage;
  const hasSources = !!msg.sources && msg.sources.length > 0;
  const sourcesLoading = !!msg.streaming && !hasSources;

  return (
    <div className="mb-10 fade-up">
      <div className="flex items-center gap-2 mb-3 text-[0.68rem] tracking-[0.16em] uppercase text-ink-muted">
        <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-ink text-white font-display text-[10px]">
          P
        </span>
        <span>PASHA Search</span>
        {meta.model && (
          <span className="font-mono normal-case tracking-normal text-ink-muted/70">
            · {meta.model}
          </span>
        )}
      </div>

      {/* Inline meta chips (rewrite + recalled memories) */}
      {(msg.rewritten || (msg.memories && msg.memories.length > 0)) && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {msg.rewritten && (
            <span className="inline-flex items-center gap-2 text-[0.7rem] px-2 py-1 rounded-md bg-amber-50 border border-amber-200 text-amber-900">
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path d="M9 18l6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="font-mono">{msg.rewritten.rewritten}</span>
              <span className="text-amber-700/80">(rewrite for retrieval)</span>
            </span>
          )}
          {msg.memories && msg.memories.length > 0 && (
            <details className="group">
              <summary className="cursor-pointer list-none inline-flex items-center gap-2 text-[0.7rem] px-2 py-1 rounded-md bg-violet-50 border border-violet-200 text-violet-900 hover:bg-violet-100 transition-colors">
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" aria-hidden>
                  <path d="M12 2a10 10 0 1 0 10 10M12 6v6l4 2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span>Recalled {msg.memories.length} from earlier sessions</span>
                <svg className="w-3 h-3 transition-transform group-open:rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" aria-hidden>
                  <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </summary>
              <div className="mt-2 space-y-1.5 max-w-xl">
                {msg.memories.map((m) => (
                  <div key={m.mid} className="text-[11px] text-ink-muted p-2 rounded bg-violet-50/60 border border-violet-100">
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="font-mono text-violet-700 font-semibold">{m.mid}</span>
                      <span className="font-mono tabular text-violet-700/70">
                        {(m.similarity * 100).toFixed(0)}% match
                      </span>
                    </div>
                    <div className="whitespace-pre-line line-clamp-3">{m.content}</div>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      {/* Error block — only when the upstream call failed.
          Tone, icon, and retry presence vary by error kind. */}
      {msg.error && (
        <ErrorAlert error={msg.error} onRetry={onRetry} />
      )}

      {/* Answer — full-width prose, no side panel */}
      <div className="min-w-0">
        {msg.streaming && !msg.content && <AnswerSkeleton />}
        {(msg.content || !msg.streaming) && (
          <div
            className={`prose prose-zinc max-w-none
                        prose-headings:font-display prose-headings:tracking-tight
                        prose-h2:text-2xl prose-h2:mt-6 prose-h2:mb-3
                        prose-h3:text-xl prose-h3:mt-5 prose-h3:mb-2
                        prose-p:my-3 prose-li:my-1 prose-hr:my-7
                        prose-strong:text-ink prose-strong:font-semibold
                        ${msg.streaming ? "streaming-cursor" : ""}`}
          >
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={citationComponents(onCite, activeSid)}
            >
              {msg.content || ""}
            </ReactMarkdown>
          </div>
        )}
      </div>

      {/* Status pills */}
      {(retrieval || usage) && !msg.streaming && (
        <div className="mt-4 flex flex-wrap items-center gap-1.5 text-xs">
          {retrieval?.mode && (
            <Pill>
              <Dot />
              <span className="font-mono">{retrieval.mode}</span>
            </Pill>
          )}
          {retrieval?.reranked && <Pill tone="emerald">reranked</Pill>}
          {retrieval?.fallback && <Pill tone="amber">fallback: {retrieval.fallback}</Pill>}
          {retrieval?.cached && <Pill tone="blue">cache hit</Pill>}
          {usage && (
            <Pill>
              <span className="text-ink-muted">in</span>{" "}
              <span className="font-mono tabular">{usage.input_tokens}</span>{" "}
              <span className="text-ink-muted">/ out</span>{" "}
              <span className="font-mono tabular">{usage.output_tokens}</span>
            </Pill>
          )}
        </div>
      )}

      {/* Sources disclosure — collapsed by default; expands on toggle
          OR when a [Sn] citation in the answer is clicked. */}
      {(hasSources || sourcesLoading) && (
        <div className="mt-4" ref={sourcesPanelRef}>
          <button
            type="button"
            onClick={() => setSourcesOpen((o) => !o)}
            disabled={sourcesLoading}
            aria-expanded={sourcesOpen}
            className="inline-flex items-center gap-1.5 text-[0.72rem] uppercase tracking-[0.14em] text-ink-muted hover:text-ink transition-colors disabled:opacity-60"
          >
            <svg
              aria-hidden
              className={`w-3 h-3 transition-transform ${sourcesOpen ? "rotate-90" : ""}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>
              {sourcesLoading
                ? "Retrieving sources…"
                : `Sources (${msg.sources?.length || 0})`}
            </span>
            {!sourcesLoading && hasSources && !sourcesOpen && (
              <span className="text-ink-muted/60 normal-case tracking-normal lowercase">
                · click to reveal
              </span>
            )}
          </button>

          {sourcesOpen && (hasSources || sourcesLoading) && (
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
              {sourcesLoading && (
                <>
                  <SourceSkeleton />
                  <SourceSkeleton />
                </>
              )}
              {hasSources &&
                msg.sources!.map((s, i) => (
                  <div
                    key={s.sid + "-" + i}
                    className="fade-up"
                    style={{ animationDelay: `${i * 25}ms` }}
                  >
                    <SourceCard
                      source={s}
                      active={activeSid === s.sid}
                      onClick={() => setActiveSid(s.sid)}
                      refFn={(el) => (sourceRefs.current[s.sid] = el)}
                    />
                  </div>
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Compact chip showing an uploaded document in the composer.
// States: uploading (animated dot), error (red), ready (with page count).
function UploadedDocChip({
  doc,
  onRemove,
}: {
  doc: {
    doc_id: string;
    title: string;
    total_pages?: number | null;
    chunk_count?: number | null;
    size_kb?: number | null;
    uploading?: boolean;
    error?: string | null;
  };
  onRemove: () => void;
}) {
  const isErr = !!doc.error;
  return (
    <div
      className={`inline-flex items-center gap-1.5 max-w-full px-2.5 py-1 rounded-full border text-[11px] ${
        isErr
          ? "border-red-200 bg-red-50 text-red-800"
          : doc.uploading
          ? "border-zinc-200 bg-white text-ink-muted"
          : "border-brand-200 bg-brand-50 text-brand-900"
      }`}
      title={isErr ? doc.error || "" : doc.title}
    >
      {/* Icon */}
      {doc.uploading ? (
        <span className="w-2 h-2 rounded-full bg-amber-500 pulse-dot" aria-hidden />
      ) : isErr ? (
        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
          <path d="M12 8v5M12 17h.01" strokeLinecap="round" />
        </svg>
      ) : (
        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6M9 13h6M9 17h6" strokeLinecap="round" />
        </svg>
      )}
      <span className="truncate max-w-[180px] sm:max-w-[260px]">{doc.title}</span>
      {!doc.uploading && !isErr && doc.total_pages ? (
        <span className="font-mono tabular text-[10px] opacity-80">
          · {doc.total_pages}p
        </span>
      ) : null}
      {doc.uploading && (
        <span className="text-[10px] uppercase tracking-wider opacity-70">indexing…</span>
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove document"
        className="ml-0.5 -mr-1 w-5 h-5 inline-flex items-center justify-center rounded-full hover:bg-black/10"
      >
        <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5" aria-hidden>
          <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

// Error alert — kind-aware styling, retry button when the error is
// classified as retryable. Severity maps to color: red for things the
// user/operator can't fix (billing, auth, permission), amber for
// transient (rate limit, overloaded, network, server), orange for
// validation/oversize, neutral red for unknown.
function ErrorAlert({
  error,
  onRetry,
}: {
  error: ChatError;
  onRetry?: () => void;
}) {
  const { kind, message, retryable, status } = error;

  const tone = pickTone(kind);
  const Icon = pickIcon(kind);
  const headline = pickHeadline(kind);

  return (
    <div
      role="alert"
      className={`mb-4 border rounded-xl p-3.5 sm:p-4 flex items-start gap-3
        ${tone.bg} ${tone.border}`}
    >
      <div
        className={`flex-none w-6 h-6 rounded-full flex items-center justify-center ${tone.iconBg} ${tone.iconFg}`}
        aria-hidden
      >
        <Icon className="w-3.5 h-3.5" />
      </div>
      <div className="flex-1 min-w-0">
        <div className={`text-sm font-medium ${tone.headline}`}>
          {headline}
          {status ? (
            <span className={`ml-2 font-mono text-[11px] ${tone.muted}`}>
              HTTP {status}
            </span>
          ) : null}
          <span className={`ml-2 font-mono text-[11px] ${tone.muted}`}>
            ({kind})
          </span>
        </div>
        <p className={`mt-1 text-[13px] leading-relaxed ${tone.body}`}>
          {message}
        </p>
        {retryable && onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className={`mt-2.5 inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors ${tone.btnBg} ${tone.btnFg}`}
          >
            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M3 12a9 9 0 1 0 3.5-7.1M3 4v6h6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Try again
          </button>
        ) : null}
      </div>
    </div>
  );
}

function pickTone(kind: string) {
  // billing / auth / permission / validation / request_too_large / model_unavailable
  // → red (action needed, often by operator)
  if (["billing", "auth", "permission"].includes(kind)) {
    return {
      bg: "bg-red-50",
      border: "border-red-200",
      iconBg: "bg-red-200",
      iconFg: "text-red-900",
      headline: "text-red-900",
      body: "text-red-800",
      muted: "text-red-700/70",
      btnBg: "bg-red-100 hover:bg-red-200",
      btnFg: "text-red-900",
    };
  }
  if (["validation", "request_too_large", "model_unavailable"].includes(kind)) {
    return {
      bg: "bg-orange-50",
      border: "border-orange-200",
      iconBg: "bg-orange-200",
      iconFg: "text-orange-900",
      headline: "text-orange-900",
      body: "text-orange-800",
      muted: "text-orange-700/70",
      btnBg: "bg-orange-100 hover:bg-orange-200",
      btnFg: "text-orange-900",
    };
  }
  // rate_limit / overloaded / server / network / timeout / db → amber/transient
  return {
    bg: "bg-amber-50",
    border: "border-amber-200",
    iconBg: "bg-amber-200",
    iconFg: "text-amber-900",
    headline: "text-amber-900",
    body: "text-amber-800",
    muted: "text-amber-700/70",
    btnBg: "bg-amber-100 hover:bg-amber-200",
    btnFg: "text-amber-900",
  };
}

function pickIcon(kind: string) {
  const exclaim = (props: any) => (
    <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
      <path d="M12 8v5M12 17h.01" strokeLinecap="round" />
    </svg>
  );
  const clock = (props: any) => (
    <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
  const wifi = (props: any) => (
    <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
      <path d="M5 12a10 10 0 0 1 14 0M8 15a6 6 0 0 1 8 0M12 19h.01" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
  const lock = (props: any) => (
    <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
      <rect x="4" y="11" width="16" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
  if (kind === "rate_limit" || kind === "overloaded" || kind === "timeout") return clock;
  if (kind === "network" || kind === "server" || kind === "db") return wifi;
  if (kind === "auth" || kind === "permission") return lock;
  return exclaim;
}

function pickHeadline(kind: string) {
  switch (kind) {
    case "billing":            return "Out of API credits";
    case "auth":               return "Authentication failed";
    case "permission":         return "Permission denied";
    case "rate_limit":         return "Rate-limited";
    case "overloaded":         return "Model overloaded";
    case "request_too_large":  return "Request too large";
    case "model_unavailable":  return "Model unavailable";
    case "validation":         return "Bad request";
    case "timeout":            return "Request timed out";
    case "network":            return "Network error";
    case "server":             return "Upstream error";
    case "db":                 return "Database error";
    default:                   return "Something went wrong";
  }
}

function AnswerSkeleton() {
  return (
    <div className="space-y-3">
      <div className="skeleton h-5 w-2/3" />
      <div className="skeleton h-4 w-full" />
      <div className="skeleton h-4 w-11/12" />
      <div className="skeleton h-4 w-4/5" />
    </div>
  );
}

function SourceSkeleton() {
  return (
    <div className="border border-zinc-200 rounded-xl p-3 space-y-2">
      <div className="skeleton h-4 w-1/3" />
      <div className="skeleton h-4 w-2/3" />
      <div className="skeleton h-3 w-full" />
    </div>
  );
}

function Skeleton({ align }: { align?: "right" }) {
  return (
    <div className={`flex ${align === "right" ? "justify-end" : ""}`}>
      <div className="space-y-2 max-w-[75%]">
        <div className="skeleton h-4 w-48 rounded-md" />
        <div className="skeleton h-4 w-64 rounded-md" />
      </div>
    </div>
  );
}

function Pill({
  children,
  tone = "default",
}: {
  children: React.ReactNode;
  tone?: "default" | "emerald" | "amber" | "blue";
}) {
  const cl = {
    default: "bg-white border-zinc-200 text-ink",
    emerald: "bg-emerald-50 border-emerald-200 text-emerald-800",
    amber: "bg-amber-50 border-amber-200 text-amber-800",
    blue: "bg-blue-50 border-blue-200 text-blue-800",
  }[tone];
  return <span className={`status-pill ${cl}`}>{children}</span>;
}

function Dot() {
  return <span className="inline-block w-1.5 h-1.5 rounded-full bg-brand-500" />;
}

function CopyChip({
  label,
  value,
  display,
  title,
}: {
  label: string;
  value: string | number;
  display?: string;
  title: string;
}) {
  const [copied, setCopied] = useState(false);
  const fullText = String(value);
  if (!fullText) return null;
  const shown = display ?? fullText;
  return (
    <button
      type="button"
      title={`${title} — click to copy "${fullText}"`}
      onClick={(e) => {
        e.stopPropagation();
        // Always copy the FULL value, never the truncated display version.
        navigator.clipboard?.writeText(fullText).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1100);
        });
      }}
      className={`inline-flex items-center gap-1 font-mono text-[10px] px-1.5 py-0.5 rounded border transition-all
        ${copied
          ? "border-emerald-300 bg-emerald-50 text-emerald-800"
          : "border-zinc-200 bg-zinc-50 text-ink-muted hover:bg-zinc-100 hover:text-ink hover:border-zinc-300"}`}
    >
      <span className="opacity-70">{label}</span>
      <span className="tabular">{copied ? "copied ✓" : shown}</span>
    </button>
  );
}

function shortHash(s: string, n = 8) {
  if (!s) return "";
  return s.length <= n ? s : s.slice(0, n) + "…";
}

function SourceCard({
  source,
  active,
  onClick,
  refFn,
}: {
  source: any;
  active: boolean;
  onClick: () => void;
  refFn: (el: HTMLDivElement | null) => void;
}) {
  const m = source.metadata || {};
  const url = source.url || "";
  const isUpload = (m.doc_type || "").toLowerCase() === "upload";
  const host = url.replace(/^https?:\/\//, "").split("/")[0];
  const pathName = url.replace(/^https?:\/\/[^/]+/, "");
  // Uploaded docs have synthetic upload:// URLs; show the filename + page
  // instead of an ugly hostname.
  const titleText = isUpload
    ? m.filename || "Uploaded document"
    : m.location || prettifyPath(pathName) || host;

  const facts: { key: string; value: string; tone?: "brand" }[] = [];
  if (isUpload && m.page) {
    facts.push({ key: "page", value: `page ${m.page}`, tone: "brand" });
  }
  if (m.price)
    facts.push({
      key: "price",
      value: `${Number(m.price).toLocaleString()}${m.currency ? " " + m.currency : ""}`,
    });
  if (m.bedrooms != null) facts.push({ key: "bd", value: `${m.bedrooms} bed` });
  if (m.total_rooms != null) facts.push({ key: "rm", value: `${m.total_rooms} rooms` });
  if (m.area_sqm) facts.push({ key: "area", value: `${m.area_sqm} m²` });
  if (m.property_type) facts.push({ key: "ptype", value: m.property_type });
  if (m.listing_type) facts.push({ key: "ltype", value: m.listing_type, tone: "brand" });

  const score = source.rerank_score || source.rrf_score || source.vector_score || 0;
  const isListing = (m.doc_type || "").toLowerCase() === "listing";

  return (
    <div ref={refFn} className="source-card cursor-pointer" data-active={active} onClick={onClick}>
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="flex items-center gap-1.5 text-[0.66rem]">
          <span className="font-mono font-semibold text-brand-700 bg-brand-100 px-1.5 py-0.5 rounded">
            {source.sid}
          </span>
          {m.doc_type && <span className="badge bg-zinc-100 text-zinc-700">{m.doc_type}</span>}
          {m.language && m.language !== "en" && (
            <span className="badge bg-zinc-100 text-zinc-700 uppercase">{m.language}</span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {isListing && source.doc_id && (
            <FavoriteHeart
              docId={source.doc_id}
              extra={{
                url: source.url,
                title: m.location || prettifyPath(pathName) || host,
                doc_type: m.doc_type,
                language: m.language,
                metadata: m,
              }}
            />
          )}
          <div className="text-[0.7rem] font-mono tabular text-ink-muted">{score.toFixed(2)}</div>
        </div>
      </div>
      <div className="text-sm font-medium text-ink line-clamp-2 mb-1 leading-snug">{titleText}</div>
      {facts.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-1">
          {facts.map((f) => (
            <span
              key={f.key}
              className={`text-[0.66rem] px-1.5 py-0.5 rounded border tabular ${
                f.tone === "brand"
                  ? "border-brand-200 bg-brand-50 text-brand-700"
                  : "border-zinc-200 bg-white text-ink-muted"
              }`}
            >
              {f.value}
            </span>
          ))}
        </div>
      )}
      <p className="text-[11px] text-ink-muted line-clamp-2 leading-relaxed mb-1">
        {source.snippet}
      </p>

      {isUpload ? (
        <div className="inline-flex items-center gap-1 text-[0.68rem] font-mono text-ink-muted">
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" aria-hidden>
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <path d="M14 2v6h6" strokeLinecap="round" />
          </svg>
          <span className="truncate max-w-full">
            {m.filename || "uploaded.pdf"}
            {m.page ? <span className="text-brand-700"> · p. {m.page}</span> : null}
          </span>
        </div>
      ) : (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[0.68rem] font-mono text-brand-700 hover:underline truncate max-w-full"
          onClick={(e) => e.stopPropagation()}
        >
          {host}
          {pathName}
          <svg className="w-3 h-3 flex-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" aria-hidden>
            <path d="M14 4h6v6M14 14l6-6M5 5h6M5 5v14h14v-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </a>
      )}

      {/* DB traceability footer — click any chip to copy the value to clipboard
          so you can paste straight into a SQL WHERE clause. */}
      {(source.id || source.doc_id || source.chunk_index != null) && (
        <div className="mt-2 pt-2 border-t border-zinc-100 flex flex-wrap items-center gap-1">
          {source.id != null && (
            <CopyChip label="chunk_id" value={source.id} title="rag_chunks.id" />
          )}
          {source.doc_id && (
            <CopyChip
              label="doc_id"
              value={source.doc_id}
              display={shortHash(source.doc_id, 10)}
              title="documents.doc_id"
            />
          )}
          {source.chunk_index != null && (
            <CopyChip
              label="chunk_index"
              value={source.chunk_index}
              title="position within document"
            />
          )}
        </div>
      )}
    </div>
  );
}

function FavoriteHeart({
  docId,
  extra,
}: {
  docId: string;
  extra?: any;
}) {
  const { savedIds, toggle } = useFavorites();
  const saved = savedIds.has(docId);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        toggle(docId, extra);
      }}
      aria-pressed={saved}
      aria-label={saved ? "Unsave listing" : "Save listing"}
      title={saved ? "Saved — click to unsave" : "Save for later"}
      className={`inline-flex items-center justify-center w-6 h-6 rounded transition-all
        ${saved
          ? "text-rose-500 hover:bg-rose-50"
          : "text-zinc-300 hover:text-rose-500 hover:bg-rose-50"}`}
    >
      <svg
        className="w-3.5 h-3.5 transition-transform hover:scale-110"
        fill={saved ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="2"
        viewBox="0 0 24 24"
        aria-hidden
      >
        <path d="M12 21s-7-4.35-7-10a4 4 0 0 1 7-2.65A4 4 0 0 1 19 11c0 5.65-7 10-7 10z" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

function prettifyPath(pathName: string) {
  if (!pathName || pathName === "/") return "";
  const last = pathName.split("/").filter(Boolean).pop() || "";
  return last.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/* -------------------------------------------------------------------------
   Markdown citation interpolation
   ------------------------------------------------------------------------- */

function updateLast<T>(arr: T[], fn: (last: T) => T): T[] {
  if (!arr.length) return arr;
  const out = arr.slice();
  out[out.length - 1] = fn(out[out.length - 1]);
  return out;
}

function interpolateCitations(
  text: string,
  onCite: (sid: string) => void,
  activeSid: string | null,
  keyPrefix = "c",
) {
  if (typeof text !== "string") return text;
  const parts: any[] = [];
  const re = /\[S(\d+)\]/g;
  let last = 0;
  let m;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const sid = `S${m[1]}`;
    parts.push(
      <button
        key={`${keyPrefix}${key++}`}
        type="button"
        className="citation-pill"
        data-active={activeSid === sid}
        onClick={() => onCite(sid)}
        title={`Jump to source ${sid}`}
      >
        {sid}
      </button>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function transformChildren(
  children: any,
  onCite: (sid: string) => void,
  activeSid: string | null,
) {
  if (children == null) return children;
  const arr = Array.isArray(children) ? children : [children];
  const out: any[] = [];
  arr.forEach((child, i) => {
    if (typeof child === "string") {
      const replaced = interpolateCitations(child, onCite, activeSid, `c${i}_`);
      if (Array.isArray(replaced)) out.push(...replaced);
      else out.push(replaced);
    } else {
      out.push(child);
    }
  });
  return out;
}

function citationComponents(onCite: (sid: string) => void, activeSid: string | null) {
  const wrap = (Tag: any) =>
    function CitationAware({ node, children, ...rest }: any) {
      return <Tag {...rest}>{transformChildren(children, onCite, activeSid)}</Tag>;
    };
  return {
    p: wrap("p"),
    li: wrap("li"),
    strong: wrap("strong"),
    em: wrap("em"),
    h1: wrap("h1"),
    h2: wrap("h2"),
    h3: wrap("h3"),
    h4: wrap("h4"),
    td: wrap("td"),
    th: wrap("th"),
    a: ({ node, children, href, ...rest }: any) => (
      <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
        {transformChildren(children, onCite, activeSid)}
      </a>
    ),
  };
}
