"use client";

import { useCallback, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const EXAMPLES = [
  "What apartments are available at The Residences at the St. Regis Baku?",
  "Compare unit sizes at Crescent Residences vs Knightsbridge",
  "Какие квартиры доступны в Ritz-Carlton Residences?",
  "Knightsbridge Residence-də neçə otaqlı mənzillər var?",
  "What sustainability initiatives does PASHA run?",
];

const MODE_LABELS: Record<string, string> = {
  hybrid: "Hybrid",
  vector: "Vector",
  lexical: "Lexical",
};

export default function AskInterface() {
  const [question, setQuestion] = useState("");
  const [topK, setTopK] = useState(6);
  const [mode, setMode] = useState("hybrid");
  const [rerank, setRerank] = useState(true);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [sources, setSources] = useState<any[]>([]);
  const [retrievalMeta, setRetrievalMeta] = useState<any>(null);
  const [answer, setAnswer] = useState("");
  const [genMeta, setGenMeta] = useState<any>(null);
  const [activeSid, setActiveSid] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [doneAt, setDoneAt] = useState<number | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const sourceRefs = useRef<Record<string, HTMLElement | null>>({});

  const reset = () => {
    setError(null);
    setSources([]);
    setRetrievalMeta(null);
    setAnswer("");
    setGenMeta(null);
    setActiveSid(null);
    setDoneAt(null);
  };

  const submit = useCallback(
    async (q?: string) => {
      const text = (q ?? question).trim();
      if (!text || streaming) return;
      reset();
      setQuestion(text);
      setStreaming(true);
      setStartedAt(Date.now());

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const resp = await fetch("/api/ask/stream", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ question: text, topK, mode, rerank }),
          signal: controller.signal,
        });
        if (!resp.ok || !resp.body) {
          const j = await resp.json().catch(() => ({}));
          throw new Error(j.error || `HTTP ${resp.status}`);
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(":")) continue;
            if (!trimmed.startsWith("data:")) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload) continue;
            try {
              handleEvent(JSON.parse(payload));
            } catch {
              /* skip malformed */
            }
          }
        }
      } catch (err: any) {
        if (err?.name !== "AbortError") setError(err?.message || "Request failed.");
      } finally {
        setStreaming(false);
        setDoneAt(Date.now());
        abortRef.current = null;
      }
    },
    [question, topK, mode, rerank, streaming],
  );

  const handleEvent = (event: any) => {
    switch (event.type) {
      case "sources":
        setSources(event.sources || []);
        setRetrievalMeta({
          mode: event.mode,
          reranked: event.reranked,
          cached: event.cached,
          fallback: event.fallback,
          topK: event.topK,
        });
        break;
      case "model":
        setGenMeta((m: any) => ({ ...(m || {}), model: event.model }));
        break;
      case "delta":
        setAnswer((a) => a + event.text);
        break;
      case "usage":
        setGenMeta((m: any) => ({ ...(m || {}), usage: event.usage }));
        break;
      case "done":
        setGenMeta((m: any) => ({ ...(m || {}), stop_reason: event.stop_reason }));
        break;
      case "error":
        setError(event.error || "Stream error.");
        break;
    }
  };

  const cancel = () => abortRef.current?.abort();

  const scrollToSource = (sid: string) => {
    setActiveSid(sid);
    const el = sourceRefs.current[sid];
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  };

  const ms = doneAt && startedAt ? doneAt - startedAt : null;
  const showResults = answer || sources.length > 0 || streaming;

  return (
    <section className="space-y-8">
      {/* Search bar */}
      <div className="relative">
        <div className="glass rounded-2xl overflow-hidden">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
            className="flex flex-col sm:flex-row gap-2 p-2 sm:p-2.5"
          >
            <div className="relative flex-1">
              <svg
                aria-hidden
                className="absolute left-4 top-1/2 -translate-y-1/2 w-[18px] h-[18px] text-ink-muted/70"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth="1.75"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3-3" strokeLinecap="round" />
              </svg>
              <input
                type="text"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="Ask about a property, amenities, prices, comparisons…"
                aria-label="Question"
                className="w-full pl-11 pr-4 py-4 text-[16px] bg-white/60 border border-transparent rounded-xl placeholder:text-ink-muted/70 focus:bg-white transition-all"
                disabled={streaming}
              />
            </div>
            {streaming ? (
              <button type="button" onClick={cancel} className="btn-stop">
                <span className="w-2.5 h-2.5 rounded-[3px] bg-ink" />
                Stop
              </button>
            ) : (
              <button
                type="submit"
                disabled={!question.trim()}
                className="btn-primary text-[15px]"
              >
                Ask
                <svg
                  aria-hidden
                  className="w-4 h-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M5 12h14M13 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
          </form>

          <div className="hr-fade" />

          <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-3 px-4 sm:px-5 py-3">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
              <Segmented
                label="Mode"
                value={mode}
                options={Object.entries(MODE_LABELS)}
                onChange={setMode}
                disabled={streaming}
              />
              <RangeControl
                label="Top K"
                value={topK}
                min={1}
                max={15}
                onChange={setTopK}
                disabled={streaming}
              />
              <Toggle
                label="Rerank"
                value={rerank}
                onChange={setRerank}
                disabled={streaming}
              />
            </div>
            <div className="text-[0.7rem] uppercase tracking-[0.16em] text-ink-muted/80 hidden sm:block">
              Hybrid · Vector · Lexical
            </div>
          </div>
        </div>
      </div>

      {/* Example chips — only when fresh */}
      {!showResults && !error && (
        <div>
          <div className="text-[0.72rem] uppercase tracking-[0.2em] text-ink-muted mb-3">
            Try asking
          </div>
          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                onClick={() => submit(ex)}
                className="group text-sm px-3.5 py-2 bg-white/80 backdrop-blur border border-zinc-200 rounded-full hover:border-brand-500/60 hover:bg-white hover:shadow-card transition-all"
              >
                <span className="text-ink-muted group-hover:text-ink transition-colors">
                  {ex}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="p-4 rounded-xl bg-red-50 border border-red-200 text-sm text-red-800 flex items-start gap-3">
          <span className="mt-0.5 inline-flex items-center justify-center w-5 h-5 rounded-full bg-red-200 text-red-900 text-xs font-bold">
            !
          </span>
          <div>
            <div className="font-medium mb-0.5">Something went wrong</div>
            <div className="text-red-700">{error}</div>
          </div>
        </div>
      )}

      {/* Status bar */}
      {retrievalMeta && (
        <div className="flex flex-wrap items-center gap-2 text-xs tabular">
          <StatusPill>
            <Dot color="brand" />
            <span className="font-mono text-ink">{retrievalMeta.mode}</span>
          </StatusPill>
          {retrievalMeta.fallback && (
            <StatusPill tone="amber">fallback: {retrievalMeta.fallback}</StatusPill>
          )}
          <StatusPill tone={retrievalMeta.reranked ? "emerald" : "muted"}>
            {retrievalMeta.reranked ? "reranked" : "no rerank"}
          </StatusPill>
          <StatusPill>top {sources.length}</StatusPill>
          {retrievalMeta.cached && <StatusPill tone="blue">cache hit</StatusPill>}
          {genMeta?.model && (
            <StatusPill>
              <span className="font-mono text-ink">{genMeta.model}</span>
            </StatusPill>
          )}
          {genMeta?.usage && (
            <StatusPill>
              <span className="text-ink-muted">in</span>{" "}
              <span className="font-mono text-ink">{genMeta.usage.input_tokens}</span>{" "}
              <span className="text-ink-muted">/ out</span>{" "}
              <span className="font-mono text-ink">{genMeta.usage.output_tokens}</span>{" "}
              <span className="text-ink-muted">tok</span>
              {(genMeta.usage.cache_read_input_tokens || 0) > 0 && (
                <span className="text-emerald-700 ml-1">
                  · cache+{genMeta.usage.cache_read_input_tokens}
                </span>
              )}
            </StatusPill>
          )}
          {ms != null && (
            <StatusPill>
              <span className="font-mono text-ink">{ms}</span>
              <span className="text-ink-muted">ms</span>
            </StatusPill>
          )}
        </div>
      )}

      {/* Two-column: answer + sources */}
      {showResults && (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 lg:gap-10">
          <article className="lg:col-span-3 min-w-0">
            {streaming && !answer && (
              <AnswerSkeleton />
            )}
            {(answer || !streaming) && (
              <div
                className={`prose prose-zinc max-w-none
                            prose-headings:font-display prose-headings:tracking-tight
                            prose-h2:text-2xl prose-h2:mt-6 prose-h2:mb-3
                            prose-h3:text-xl prose-h3:mt-5 prose-h3:mb-2
                            prose-p:my-3 prose-li:my-1 prose-hr:my-7
                            prose-strong:text-ink prose-strong:font-semibold
                            prose-a:text-brand-700 prose-a:no-underline hover:prose-a:underline
                            ${streaming ? "streaming-cursor" : ""}`}
              >
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={citationComponents(scrollToSource, activeSid)}
                >
                  {answer || ""}
                </ReactMarkdown>
              </div>
            )}
          </article>

          <aside className="lg:col-span-2 min-w-0">
            <div className="flex items-center justify-between mb-3">
              <div className="text-[0.72rem] uppercase tracking-[0.2em] text-ink-muted">
                Sources
              </div>
              <div className="text-xs text-ink-muted font-mono tabular">
                {sources.length || (streaming ? "…" : 0)} retrieved
              </div>
            </div>
            <div className="space-y-3">
              {sources.length === 0 && streaming && (
                <>
                  <SourceSkeleton />
                  <SourceSkeleton />
                  <SourceSkeleton />
                </>
              )}
              {sources.map((s, i) => (
                <div
                  key={s.sid}
                  className="fade-up"
                  style={{ animationDelay: `${i * 35}ms` }}
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
          </aside>
        </div>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------
   Subcomponents
   ------------------------------------------------------------------------- */

function Segmented({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="text-[0.68rem] uppercase tracking-[0.16em] text-ink-muted">{label}</span>
      <div className={`inline-flex items-center bg-zinc-100/80 rounded-lg p-0.5 ${disabled ? "opacity-50" : ""}`}>
        {options.map(([v, l]) => (
          <button
            key={v}
            type="button"
            onClick={() => onChange(v)}
            disabled={disabled}
            className={`px-2.5 py-1 text-xs rounded-md transition-all ${
              v === value
                ? "bg-white text-ink shadow-sm"
                : "text-ink-muted hover:text-ink"
            }`}
          >
            {l}
          </button>
        ))}
      </div>
    </div>
  );
}

function RangeControl({
  label,
  value,
  min,
  max,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-center gap-2.5">
      <span className="text-[0.68rem] uppercase tracking-[0.16em] text-ink-muted">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
        disabled={disabled}
        className="w-24 sm:w-28 accent-brand-500"
      />
      <span className="font-mono tabular text-xs w-5 text-right text-ink">{value}</span>
    </label>
  );
}

function Toggle({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      disabled={disabled}
      className={`group flex items-center gap-2.5 disabled:opacity-50`}
      aria-pressed={value}
    >
      <span className="text-[0.68rem] uppercase tracking-[0.16em] text-ink-muted">{label}</span>
      <span
        className={`relative inline-flex items-center w-8 h-[18px] rounded-full transition-colors ${
          value ? "bg-brand-500" : "bg-zinc-300"
        }`}
      >
        <span
          className={`inline-block w-3.5 h-3.5 rounded-full bg-white shadow-sm transform transition-transform ${
            value ? "translate-x-[15px]" : "translate-x-[1px]"
          }`}
        />
      </span>
    </button>
  );
}

function StatusPill({
  children,
  tone = "default",
}: {
  children: React.ReactNode;
  tone?: "default" | "muted" | "emerald" | "amber" | "blue";
}) {
  const toneClass = {
    default: "bg-white border-zinc-200 text-ink",
    muted: "bg-white border-zinc-200 text-ink-muted",
    emerald: "bg-emerald-50 border-emerald-200 text-emerald-800",
    amber: "bg-amber-50 border-amber-200 text-amber-800",
    blue: "bg-blue-50 border-blue-200 text-blue-800",
  }[tone];
  return <span className={`status-pill ${toneClass}`}>{children}</span>;
}

function Dot({ color = "brand" }: { color?: "brand" | "emerald" }) {
  const c = color === "emerald" ? "bg-emerald-500" : "bg-brand-500";
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${c}`} />;
}

function AnswerSkeleton() {
  return (
    <div className="space-y-3" aria-label="Generating answer">
      <div className="skeleton h-6 w-3/5" />
      <div className="skeleton h-4 w-full" />
      <div className="skeleton h-4 w-11/12" />
      <div className="skeleton h-4 w-4/5" />
      <div className="skeleton h-4 w-full" />
      <div className="skeleton h-4 w-2/3" />
    </div>
  );
}

function SourceSkeleton() {
  return (
    <div className="border border-zinc-200 rounded-xl p-3.5 space-y-2">
      <div className="flex items-center justify-between">
        <div className="skeleton h-4 w-16" />
        <div className="skeleton h-4 w-10" />
      </div>
      <div className="skeleton h-4 w-3/4" />
      <div className="skeleton h-3 w-full" />
      <div className="skeleton h-3 w-5/6" />
    </div>
  );
}

/* -------------------------------------------------------------------------
   Source card
   ------------------------------------------------------------------------- */

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

  const facts = [
    m.price && {
      key: "price",
      value: `${Number(m.price).toLocaleString()}${m.currency ? " " + m.currency : ""}`,
    },
    m.bedrooms != null && { key: "bd", value: `${m.bedrooms} bed` },
    m.bathrooms != null && { key: "ba", value: `${m.bathrooms} bath` },
    m.area_sqm && { key: "area", value: `${m.area_sqm} m²` },
    m.property_type && { key: "ptype", value: m.property_type },
    m.listing_type && { key: "ltype", value: m.listing_type, tone: "brand" as const },
  ].filter(Boolean) as { key: string; value: string; tone?: "brand" }[];

  const score =
    source.rerank_score
      ? source.rerank_score
      : source.rrf_score || source.vector_score || 0;

  return (
    <div ref={refFn} className="source-card" data-active={active} onClick={onClick}>
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-1.5 text-[0.66rem] tracking-[0.04em]">
          <span className="font-mono font-semibold text-brand-700 bg-brand-100 px-1.5 py-0.5 rounded">
            {source.sid}
          </span>
          {m.doc_type && (
            <span className="badge bg-zinc-100 text-zinc-700">{m.doc_type}</span>
          )}
          {m.language && m.language !== "en" && (
            <span className="badge bg-zinc-100 text-zinc-700 uppercase">{m.language}</span>
          )}
        </div>
        <div className="text-[0.7rem] font-mono tabular text-ink-muted">
          {score.toFixed(2)}
        </div>
      </div>

      <div className="text-sm font-medium text-ink line-clamp-2 mb-1.5 leading-snug">
        {titleText}
      </div>

      {facts.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-1.5">
          {facts.map((f) => (
            <span
              key={f.key}
              className={`text-[0.68rem] px-1.5 py-0.5 rounded border tabular ${
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

      <p className="text-xs text-ink-muted line-clamp-2 leading-relaxed mb-2">
        {source.snippet}
      </p>

      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-[0.7rem] font-mono text-brand-700 hover:text-brand-900 hover:underline truncate max-w-full"
        onClick={(e) => e.stopPropagation()}
      >
        {host}{pathName}
        <svg
          aria-hidden
          className="w-3 h-3 flex-none"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M14 4h6v6M14 14l6-6M5 5h6M5 5v14h14v-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </a>
    </div>
  );
}

function prettifyPath(pathName: string) {
  if (!pathName || pathName === "/") return "";
  const last = pathName.split("/").filter(Boolean).pop() || "";
  return last.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/* -------------------------------------------------------------------------
   Markdown → citation pill interpolation
   ------------------------------------------------------------------------- */

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
