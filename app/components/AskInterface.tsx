"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const EXAMPLES = [
  "What apartments are available at The Residences at the St. Regis Baku?",
  "Tell me about the Crescent Residences and its amenities",
  "Какие 2-комнатные апартаменты есть в Ritz-Carlton?",
  "Knightsbridge Residence-də neçə otaqlı mənzillər var?",
  "What sustainability initiatives does PASHA Real Estate run?",
];

const MODE_LABELS = { hybrid: "Hybrid", vector: "Vector only", lexical: "Lexical only" };

export default function AskInterface() {
  const [question, setQuestion] = useState("");
  const [topK, setTopK] = useState(6);
  const [mode, setMode] = useState("hybrid");
  const [rerank, setRerank] = useState(true);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState(null);

  const [sources, setSources] = useState([]);
  const [retrievalMeta, setRetrievalMeta] = useState(null);
  const [answer, setAnswer] = useState("");
  const [genMeta, setGenMeta] = useState(null);
  const [activeSid, setActiveSid] = useState(null);
  const [startedAt, setStartedAt] = useState(null);
  const [doneAt, setDoneAt] = useState(null);

  const abortRef = useRef(null);
  const sourceRefs = useRef({});

  const reset = () => {
    setError(null);
    setSources([]);
    setRetrievalMeta(null);
    setAnswer("");
    setGenMeta(null);
    setActiveSid(null);
    setDoneAt(null);
  };

  const submit = useCallback(async (q) => {
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
          let event;
          try {
            event = JSON.parse(payload);
          } catch {
            continue;
          }
          handleEvent(event);
        }
      }
    } catch (err) {
      if (err.name !== "AbortError") setError(err.message || "Request failed.");
    } finally {
      setStreaming(false);
      setDoneAt(Date.now());
      abortRef.current = null;
    }
  }, [question, topK, mode, rerank, streaming]);

  const handleEvent = (event) => {
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
        setGenMeta((m) => ({ ...(m || {}), model: event.model }));
        break;
      case "delta":
        setAnswer((a) => a + event.text);
        break;
      case "usage":
        setGenMeta((m) => ({ ...(m || {}), usage: event.usage }));
        break;
      case "done":
        setGenMeta((m) => ({ ...(m || {}), stop_reason: event.stop_reason }));
        break;
      case "error":
        setError(event.error || "Stream error.");
        break;
    }
  };

  const cancel = () => {
    abortRef.current?.abort();
  };

  const scrollToSource = (sid) => {
    setActiveSid(sid);
    const el = sourceRefs.current[sid];
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("ring-2", "ring-brand-500");
      setTimeout(() => el.classList.remove("ring-2", "ring-brand-500"), 1200);
    }
  };

  const ms = doneAt && startedAt ? doneAt - startedAt : null;

  // Render answer with [S1] pills as interactive elements.
  const renderedAnswer = useMemo(() => renderAnswerWithCitations(answer, scrollToSource, activeSid), [answer, activeSid]);

  return (
    <section className="space-y-6">
      {/* Search bar */}
      <div className="bg-white border border-zinc-200 rounded-xl shadow-sm overflow-hidden">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="flex flex-col sm:flex-row gap-2 p-3"
        >
          <input
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask about a property, amenities, prices, comparisons…"
            className="flex-1 px-4 py-3 text-base bg-transparent border border-zinc-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
            disabled={streaming}
          />
          {streaming ? (
            <button
              type="button"
              onClick={cancel}
              className="px-5 py-3 rounded-lg bg-zinc-100 hover:bg-zinc-200 text-ink font-medium transition-colors"
            >
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!question.trim()}
              className="px-5 py-3 rounded-lg bg-brand-500 hover:bg-brand-600 text-white font-medium disabled:opacity-40 disabled:hover:bg-brand-500 transition-colors"
            >
              Ask
            </button>
          )}
        </form>

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 border-t border-zinc-100 bg-zinc-50/50 text-sm">
          <label className="flex items-center gap-2">
            <span className="text-ink-muted">Mode</span>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value)}
              disabled={streaming}
              className="bg-white border border-zinc-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
            >
              {Object.entries(MODE_LABELS).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2">
            <span className="text-ink-muted">Top K</span>
            <input
              type="range"
              min={1}
              max={15}
              value={topK}
              onChange={(e) => setTopK(parseInt(e.target.value, 10))}
              disabled={streaming}
              className="w-32"
            />
            <span className="font-mono w-6 text-right">{topK}</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={rerank}
              onChange={(e) => setRerank(e.target.checked)}
              disabled={streaming}
              className="accent-brand-500"
            />
            <span className="text-ink-muted">Voyage rerank</span>
          </label>
        </div>
      </div>

      {/* Example chips */}
      {!streaming && !answer && (
        <div>
          <div className="text-sm text-ink-muted mb-2">Try one of these:</div>
          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                onClick={() => submit(ex)}
                className="text-sm px-3 py-1.5 bg-white border border-zinc-200 rounded-full hover:border-brand-500 hover:text-brand-700 transition-colors"
              >
                {ex}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="p-4 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
          <strong>Error:</strong> {error}
        </div>
      )}

      {/* Status bar (after first sources event) */}
      {retrievalMeta && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-muted">
          <span>
            <span className="font-mono text-ink">{retrievalMeta.mode}</span>
            {retrievalMeta.fallback ? <span className="ml-1 text-amber-600">(fallback: {retrievalMeta.fallback})</span> : null}
          </span>
          <span>•</span>
          <span>
            {retrievalMeta.reranked ? (
              <span className="text-emerald-700">reranked</span>
            ) : (
              <span>no rerank</span>
            )}
          </span>
          <span>•</span>
          <span>top {sources.length}</span>
          {retrievalMeta.cached && (
            <>
              <span>•</span>
              <span className="text-blue-700">cache hit</span>
            </>
          )}
          {genMeta?.model && (
            <>
              <span>•</span>
              <span className="font-mono">{genMeta.model}</span>
            </>
          )}
          {genMeta?.usage && (
            <>
              <span>•</span>
              <span>
                in {genMeta.usage.input_tokens} / out {genMeta.usage.output_tokens} tok
                {(genMeta.usage.cache_read_input_tokens || 0) > 0 ? (
                  <span className="text-emerald-700"> · cache+{genMeta.usage.cache_read_input_tokens}</span>
                ) : null}
              </span>
            </>
          )}
          {ms != null && (
            <>
              <span>•</span>
              <span>{ms} ms</span>
            </>
          )}
        </div>
      )}

      {/* Two-column: answer + sources */}
      {(answer || sources.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          <article className="lg:col-span-3 prose prose-zinc max-w-none">
            <div className={`text-[15px] leading-relaxed whitespace-pre-wrap ${streaming ? "streaming-cursor" : ""}`}>
              {renderedAnswer}
            </div>
          </article>

          <aside className="lg:col-span-2 space-y-3">
            <div className="text-sm font-medium text-ink-muted uppercase tracking-wide">Sources</div>
            {sources.map((s) => (
              <SourceCard
                key={s.sid}
                source={s}
                active={activeSid === s.sid}
                onClick={() => setActiveSid(s.sid)}
                refFn={(el) => (sourceRefs.current[s.sid] = el)}
              />
            ))}
          </aside>
        </div>
      )}
    </section>
  );
}

function renderAnswerWithCitations(text, onCite, activeSid) {
  if (!text) return null;
  const parts = [];
  const re = /\[S(\d+)\]/g;
  let last = 0;
  let m;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const sid = `S${m[1]}`;
    parts.push(
      <button
        key={`c${key++}`}
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

function SourceCard({ source, active, onClick, refFn }) {
  const m = source.metadata || {};
  const url = source.url || "";
  const host = url.replace(/^https?:\/\//, "").split("/")[0];
  const pathName = url.replace(/^https?:\/\/[^/]+/, "");

  return (
    <div
      ref={refFn}
      className="source-card cursor-pointer"
      data-active={active}
      onClick={onClick}
    >
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="flex items-center gap-2 text-xs">
          <span className="badge bg-brand-100 text-brand-700">{source.sid}</span>
          {m.doc_type && <span className="badge bg-zinc-100 text-zinc-700">{m.doc_type}</span>}
          {m.language && m.language !== "en" && (
            <span className="badge bg-zinc-100 text-zinc-700 uppercase">{m.language}</span>
          )}
        </div>
        <div className="text-xs font-mono text-ink-muted">
          {source.rerank_score
            ? `${source.rerank_score.toFixed(2)}`
            : (source.rrf_score || source.vector_score || 0).toFixed(3)}
        </div>
      </div>
      <div className="text-sm font-medium text-ink line-clamp-2 mb-1">
        {m.location || pathName || host}
      </div>
      {(m.price || m.bedrooms || m.area_sqm) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-ink-muted mb-1">
          {m.price && (
            <span>
              <span className="font-mono">{Number(m.price).toLocaleString()}</span>
              {m.currency ? ` ${m.currency}` : ""}
            </span>
          )}
          {m.bedrooms && <span>{m.bedrooms} bed</span>}
          {m.bathrooms && <span>{m.bathrooms} bath</span>}
          {m.area_sqm && <span>{m.area_sqm} m²</span>}
          {m.property_type && <span>{m.property_type}</span>}
          {m.listing_type && <span className="text-brand-700">{m.listing_type}</span>}
        </div>
      )}
      <p className="text-xs text-ink-muted line-clamp-3">{source.snippet}</p>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs text-brand-700 hover:underline mt-1 inline-block font-mono break-all"
        onClick={(e) => e.stopPropagation()}
      >
        {host}{pathName}
      </a>
    </div>
  );
}
