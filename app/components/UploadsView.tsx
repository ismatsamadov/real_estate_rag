"use client";

/**
 * Uploads library page — every PDF the signed-in user has uploaded
 * across every session. Owner-scoped on the server.
 *
 *   - Lists docs newest first (max 200)
 *   - Each row shows title / pages / size / chunks / when / which session
 *   - Click the session pill → jumps into that chat with the doc loaded
 *   - Trash icon → DELETE /api/documents/[docId]?sessionId=...
 *     (existing endpoint, FK CASCADE wipes chunks)
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import Header from "./Header";

type Upload = {
  doc_id: string;
  title: string;
  total_pages: number | null;
  size_kb: number | null;
  chunk_count: number;
  uploaded_at: string;
  session_id: string;
  session_title: string | null;
};

function formatBytes(kb: number | null) {
  if (!kb) return "—";
  if (kb < 1024) return `${kb} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function formatWhen(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = Date.now();
  const diff = now - d.getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString();
}

export default function UploadsView() {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/uploads", { credentials: "include" });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        setError(d?.error || "Failed to load uploads.");
        setUploads([]);
      } else {
        setUploads(Array.isArray(d.uploads) ? d.uploads : []);
      }
    } catch (e: any) {
      setError(e?.message || "Network error.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onDelete = useCallback(
    async (u: Upload) => {
      const ok = window.confirm(
        `Delete "${u.title}"?\n\nThis removes the document and all its embeddings. Past chat citations remain visible but won't be retrievable for new questions.`,
      );
      if (!ok) return;
      setPendingDelete(u.doc_id);
      try {
        const r = await fetch(
          `/api/documents/${encodeURIComponent(u.doc_id)}?sessionId=${u.session_id}`,
          { method: "DELETE", credentials: "include" },
        );
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d?.ok) {
          alert(d?.error || `Delete failed (${r.status})`);
        } else {
          setUploads((prev) => prev.filter((x) => x.doc_id !== u.doc_id));
        }
      } catch (e: any) {
        alert(e?.message || "Network error during delete.");
      } finally {
        setPendingDelete(null);
      }
    },
    [],
  );

  const totalChunks = uploads.reduce((n, u) => n + (u.chunk_count || 0), 0);
  const totalSize = uploads.reduce((n, u) => n + (u.size_kb || 0), 0);

  return (
    <div className="min-h-svh flex flex-col bg-zinc-50">
      <Header />
      <main className="flex-1 safe-px px-3 sm:px-4 lg:px-6 py-6 sm:py-10 max-w-5xl w-full mx-auto">
        <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
          <div>
            <h1 className="font-display text-2xl sm:text-3xl tracking-tight">
              Uploaded documents
            </h1>
            <p className="text-sm text-ink-muted mt-1">
              Your library of PDFs across all chat sessions. Each document is
              chunked, embedded with{" "}
              <code className="font-mono text-xs px-1 py-0.5 bg-zinc-200/60 rounded">
                voyage-4-large
              </code>
              , and stored in Postgres + pgvector — retrieved by the same
              hybrid pipeline as the public corpus.
            </p>
          </div>
          <Link
            href="/"
            className="btn-ghost text-sm whitespace-nowrap"
            prefetch={false}
          >
            ← Back to chat
          </Link>
        </div>

        {/* Stats strip */}
        {!loading && !error && uploads.length > 0 && (
          <div className="grid grid-cols-3 gap-3 mb-6">
            <div className="rounded-xl border border-zinc-200 bg-white p-3 sm:p-4">
              <div className="text-[0.62rem] uppercase tracking-[0.18em] text-ink-muted">
                Documents
              </div>
              <div className="font-display text-2xl mt-1 tabular">
                {uploads.length}
              </div>
            </div>
            <div className="rounded-xl border border-zinc-200 bg-white p-3 sm:p-4">
              <div className="text-[0.62rem] uppercase tracking-[0.18em] text-ink-muted">
                Embedded chunks
              </div>
              <div className="font-display text-2xl mt-1 tabular">
                {totalChunks.toLocaleString()}
              </div>
            </div>
            <div className="rounded-xl border border-zinc-200 bg-white p-3 sm:p-4">
              <div className="text-[0.62rem] uppercase tracking-[0.18em] text-ink-muted">
                Total size
              </div>
              <div className="font-display text-2xl mt-1 tabular">
                {formatBytes(totalSize)}
              </div>
            </div>
          </div>
        )}

        {/* Body */}
        {loading ? (
          <div className="rounded-xl border border-zinc-200 bg-white p-8 text-center text-sm text-ink-muted">
            Loading…
          </div>
        ) : error ? (
          <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
            {error}
            <button
              onClick={load}
              className="ml-3 underline hover:no-underline"
            >
              Retry
            </button>
          </div>
        ) : uploads.length === 0 ? (
          <div className="rounded-xl border border-zinc-200 bg-white p-8 text-center">
            <div className="mx-auto w-12 h-12 rounded-full bg-zinc-100 flex items-center justify-center mb-3">
              <svg
                className="w-6 h-6 text-ink-muted"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden
              >
                <path
                  d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path d="M14 2v6h6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <div className="font-medium">No uploads yet</div>
            <p className="text-sm text-ink-muted mt-1">
              Drop a PDF onto any chat (paperclip icon) and it'll show up here.
            </p>
            <Link
              href="/"
              prefetch={false}
              className="mt-4 inline-flex btn-primary text-sm"
            >
              Open chat
            </Link>
          </div>
        ) : (
          <ul className="rounded-xl border border-zinc-200 bg-white divide-y divide-zinc-200 overflow-hidden">
            {uploads.map((u) => (
              <li
                key={u.doc_id}
                className="p-3 sm:p-4 flex items-start gap-3 sm:gap-4 hover:bg-zinc-50/60 transition-colors"
              >
                <div className="flex-none mt-0.5 w-9 h-9 sm:w-10 sm:h-10 rounded-lg bg-rose-50 text-rose-600 flex items-center justify-center">
                  <svg
                    className="w-5 h-5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    aria-hidden
                  >
                    <path
                      d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <path
                      d="M14 2v6h6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <h3 className="font-medium text-ink truncate max-w-full">
                      {u.title}
                    </h3>
                    <span className="text-xs text-ink-muted tabular">
                      {formatWhen(u.uploaded_at)}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
                    <span className="tabular">
                      {u.total_pages ?? "—"} pages
                    </span>
                    <span aria-hidden>·</span>
                    <span className="tabular">{formatBytes(u.size_kb)}</span>
                    <span aria-hidden>·</span>
                    <span className="tabular">
                      {u.chunk_count.toLocaleString()} chunk
                      {u.chunk_count === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div className="mt-2">
                    <Link
                      href={`/?c=${u.session_id}`}
                      prefetch={false}
                      className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-md bg-zinc-100 hover:bg-zinc-200 text-ink-soft hover:text-ink transition-colors"
                      title="Open the chat where this PDF was uploaded"
                    >
                      <svg
                        className="w-3 h-3"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        aria-hidden
                      >
                        <path
                          d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                      <span className="truncate max-w-[16rem]">
                        {u.session_title || "Untitled chat"}
                      </span>
                    </Link>
                  </div>
                </div>

                <button
                  onClick={() => onDelete(u)}
                  disabled={pendingDelete === u.doc_id}
                  className="flex-none inline-flex w-9 h-9 sm:w-10 sm:h-10 items-center justify-center rounded-lg text-ink-muted hover:text-rose-600 hover:bg-rose-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  aria-label={`Delete ${u.title}`}
                  title="Delete document and its embeddings"
                >
                  {pendingDelete === u.doc_id ? (
                    <svg
                      className="w-4 h-4 animate-spin"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      aria-hidden
                    >
                      <path d="M21 12a9 9 0 1 1-6.2-8.6" strokeLinecap="round" />
                    </svg>
                  ) : (
                    <svg
                      className="w-4 h-4"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      aria-hidden
                    >
                      <path
                        d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M10 11v6M14 11v6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* Foot note — explicit honesty about what storage is */}
        <p className="mt-6 text-xs text-ink-muted">
          Pipeline: page-aware extraction →{" "}
          <code className="font-mono px-1 bg-zinc-200/60 rounded">chunkText</code>{" "}
          → Voyage embeddings → Postgres + pgvector. Retrieved at query time
          by the same hybrid (vector + FTS + RRF + rerank) pipeline as the
          scraped corpus. Deleting here removes the row from{" "}
          <code className="font-mono px-1 bg-zinc-200/60 rounded">documents</code>{" "}
          and cascades to{" "}
          <code className="font-mono px-1 bg-zinc-200/60 rounded">rag_chunks</code>.
          Citations already saved in past messages are immutable and remain
          visible.
        </p>
      </main>
    </div>
  );
}
