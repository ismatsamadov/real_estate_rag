"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type MemoryChip = {
  mid: string;
  content: string;
  created_at: string;
  similarity: number;
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

  // Load history when sessionId changes.
  useEffect(() => {
    if (!sessionId) {
      setMessages([]);
      return;
    }
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
                content: m.content + `\n\n_Error: ${event.error}_`,
                streaming: false,
              })));
            }
          }
        }

        if (createdSession) onSessionCreated(createdSession);
      } catch (err: any) {
        if (err?.name !== "AbortError") {
          setMessages((prev) => updateLast(prev, (m) => ({
            ...m,
            content: m.content || `_Error: ${err?.message || "request failed"}_`,
            streaming: false,
          })));
        } else {
          setMessages((prev) => updateLast(prev, (m) => ({
            ...m,
            streaming: false,
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

  const isEmpty = messages.length === 0 && !loadingHistory;

  return (
    <div className="relative flex flex-col h-[calc(100dvh-3.5rem)] sm:h-[calc(100dvh-4rem)]">
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
              />
            ),
          )}
        </div>
      </div>

      {/* Composer */}
      <div className="border-t border-zinc-200/70 bg-white/80 backdrop-blur-md">
        <div className="mx-auto max-w-3xl px-4 sm:px-6 py-3">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
            className="flex items-end gap-2"
          >
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
                  messages.length
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
}: {
  msg: ChatMessage;
  activeSid: string | null;
  setActiveSid: (sid: string) => void;
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
  const host = url.replace(/^https?:\/\//, "").split("/")[0];
  const pathName = url.replace(/^https?:\/\/[^/]+/, "");
  const titleText = m.location || prettifyPath(pathName) || host;
  const facts: { key: string; value: string; tone?: "brand" }[] = [];
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
        <div className="text-[0.7rem] font-mono tabular text-ink-muted">{score.toFixed(2)}</div>
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
