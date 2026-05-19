"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type SessionItem = {
  session_id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  message_count: number;
  first_question: string | null;
};

export default function Sidebar({
  activeSessionId,
  onSelect,
  onNew,
  refreshKey,
  isOpen,
  onClose,
}: {
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  refreshKey: number;
  isOpen: boolean;
  onClose: () => void;
}) {
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameSaving, setRenameSaving] = useState(false);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (renamingId) renameInputRef.current?.select();
  }, [renamingId]);

  function startRename(s: SessionItem, e: React.MouseEvent) {
    e.stopPropagation();
    setRenamingId(s.session_id);
    setRenameDraft(s.title || s.first_question || "");
  }

  function cancelRename() {
    setRenamingId(null);
    setRenameDraft("");
    setRenameSaving(false);
  }

  async function commitRename(id: string) {
    const next = renameDraft.replace(/\s+/g, " ").trim();
    const current = sessions.find((s) => s.session_id === id);
    const previousTitle = current?.title ?? "";
    if (next === previousTitle.trim()) {
      cancelRename();
      return;
    }
    setRenameSaving(true);
    try {
      const resp = await fetch(`/api/sessions/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: next || null }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data?.ok) {
        alert(data?.error || `Rename failed (${resp.status}).`);
        return;
      }
      setSessions((prev) =>
        prev.map((s) =>
          s.session_id === id
            ? { ...s, title: data.session?.title ?? (next || null) }
            : s,
        ),
      );
      cancelRename();
    } catch (err: any) {
      alert(err?.message || "Network error while renaming.");
    } finally {
      setRenameSaving(false);
    }
  }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await fetch("/api/sessions", { credentials: "include" });
      const data = await resp.json();
      if (data?.ok) setSessions(data.sessions);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  async function deleteSession(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm("Delete this conversation? This can't be undone.")) return;
    setDeleting(id);
    try {
      await fetch(`/api/sessions/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      setSessions((prev) => prev.filter((s) => s.session_id !== id));
      if (activeSessionId === id) onNew();
    } finally {
      setDeleting(null);
    }
  }

  return (
    <>
      {/* Mobile backdrop */}
      {isOpen && (
        <div
          className="lg:hidden fixed inset-0 z-40 bg-ink/30 backdrop-blur-sm"
          onClick={onClose}
        />
      )}

      <aside
        className={`fixed lg:sticky lg:top-14 top-14 left-0 z-40 lg:z-auto h-[calc(100svh-3.5rem)] lg:h-[calc(100svh-3.5rem)] w-[85vw] max-w-[320px] sm:w-[300px] sm:max-w-none border-r border-zinc-200/70 bg-white/95 sm:bg-white/80 backdrop-blur-md transform transition-transform duration-200 ${
          isOpen ? "translate-x-0" : "-translate-x-full"
        } lg:translate-x-0 flex flex-col safe-pb`}
      >
        <div className="p-3 border-b border-zinc-200/70">
          <button
            onClick={() => {
              onNew();
              onClose();
            }}
            className="w-full inline-flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl bg-ink text-white text-sm font-medium hover:bg-zinc-800 transition-all shadow-card"
          >
            <svg
              aria-hidden
              className="w-4 h-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M12 5v14M5 12h14" strokeLinecap="round" />
            </svg>
            New chat
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {loading && sessions.length === 0 && (
            <div className="px-3 py-4 space-y-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="skeleton h-12 rounded-lg" />
              ))}
            </div>
          )}

          {!loading && sessions.length === 0 && (
            <div className="px-3 py-8 text-center">
              <div className="text-xs uppercase tracking-[0.18em] text-ink-muted mb-2">
                No conversations yet
              </div>
              <div className="text-xs text-ink-muted/80">
                Start a new chat to see history here.
              </div>
            </div>
          )}

          {sessions.map((s) => {
            const isActive = s.session_id === activeSessionId;
            const isDel = deleting === s.session_id;
            const isRenaming = renamingId === s.session_id;
            const select = () => {
              if (isRenaming) return;
              onSelect(s.session_id);
              onClose();
            };
            // Outer element is a div with role="button" so we can safely
            // nest the delete <button> inside without violating the
            // "no button-in-button" HTML rule (caught as a React hydration
            // error in the console). Keyboard handlers preserve a11y.
            return (
              <div
                key={s.session_id}
                role="button"
                tabIndex={isRenaming ? -1 : 0}
                onClick={select}
                onKeyDown={(e) => {
                  if (isRenaming) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    select();
                  }
                }}
                aria-pressed={isActive}
                aria-label={`Open session: ${s.title || s.first_question || "New chat"}`}
                className={`group w-full text-left px-3 py-2.5 rounded-lg transition-all relative ${
                  isRenaming ? "cursor-default" : "cursor-pointer"
                } ${
                  isActive
                    ? "bg-zinc-100 text-ink"
                    : "hover:bg-zinc-50 text-ink-soft"
                } ${isDel ? "opacity-40" : ""} focus-visible:outline-none`}
              >
                {isRenaming ? (
                  <input
                    ref={renameInputRef}
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitRename(s.session_id);
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        cancelRename();
                      }
                    }}
                    onBlur={() => {
                      if (!renameSaving) commitRename(s.session_id);
                    }}
                    disabled={renameSaving}
                    maxLength={200}
                    placeholder="Untitled chat"
                    aria-label="Rename conversation"
                    className="w-full text-[13px] leading-snug font-medium bg-white border border-zinc-300 rounded px-2 py-1 outline-none focus:ring-2 focus:ring-brand-700/20 focus:border-brand-700 disabled:opacity-60"
                  />
                ) : (
                  <div className="text-[13px] leading-snug font-medium line-clamp-2 pr-14">
                    {s.title || s.first_question || "New chat"}
                  </div>
                )}
                <div className="text-[11px] text-ink-muted mt-0.5">
                  {s.message_count} {s.message_count === 1 ? "message" : "messages"} ·{" "}
                  {relTime(s.updated_at)}
                </div>
                {!isRenaming && (
                  <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5
                                  opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100 transition-opacity">
                    <button
                      type="button"
                      onClick={(e) => startRename(s, e)}
                      aria-label="Rename conversation"
                      title="Rename"
                      className="w-9 h-9 inline-flex items-center justify-center rounded
                                 hover:bg-zinc-100 hover:text-ink text-ink-muted/70 sm:text-ink-muted transition-colors"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" aria-hidden>
                        <path d="M12 20h9M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      onClick={(e) => deleteSession(s.session_id, e)}
                      aria-label="Delete conversation"
                      title="Delete"
                      className="w-9 h-9 inline-flex items-center justify-center rounded
                                 hover:bg-red-50 hover:text-red-700 text-ink-muted/70 sm:text-ink-muted transition-colors"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" aria-hidden>
                        <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="p-3 border-t border-zinc-200/70 space-y-2">
          <ProfilePanel />
          <MemoryControls />
          <div className="text-[0.7rem] tracking-[0.08em] text-ink-muted">
            {sessions.length} {sessions.length === 1 ? "session" : "sessions"} · Neon · pgvector
          </div>
        </div>
      </aside>
    </>
  );
}

type ProfileContext = {
  summary: string | null;
  summaryRefreshedAt: string | null;
  favorites: { title: string }[];
  recentTopics: string[];
  uploads: { title: string; total_pages: number | null }[];
  counts: { memory_n: number; favorite_n: number; upload_n: number };
};

function ProfilePanel() {
  const [ctx, setCtx] = useState<ProfileContext | null>(null);
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/profile", { credentials: "include" });
      const d = await r.json();
      if (d?.ok) setCtx(d.profile);
    } catch {}
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function refresh() {
    setRefreshing(true);
    try {
      const r = await fetch("/api/profile/refresh", {
        method: "POST",
        credentials: "include",
      });
      const d = await r.json();
      if (d?.ok) setCtx(d.profile);
    } finally {
      setRefreshing(false);
    }
  }

  const hasSignals =
    !!ctx &&
    (ctx.counts.memory_n > 0 ||
      ctx.counts.favorite_n > 0 ||
      ctx.counts.upload_n > 0);

  if (!hasSignals) return null;

  return (
    <div className="rounded-lg bg-gradient-to-br from-violet-50 to-fuchsia-50 border border-violet-100/80 p-2.5">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 text-left"
        aria-expanded={open}
        aria-label="Toggle user profile"
      >
        <svg
          className="w-3.5 h-3.5 text-violet-700 flex-none"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden
        >
          <path
            d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0z"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="text-[0.7rem] uppercase tracking-[0.14em] text-violet-900 font-medium">
          What the LLM knows
        </span>
        <span className="flex-1" />
        <svg
          className={`w-3 h-3 text-violet-700 transition-transform ${open ? "rotate-180" : ""}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          aria-hidden
        >
          <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {ctx?.summary && (
        <p
          className={`mt-1.5 text-[11px] leading-snug text-ink-soft ${
            open ? "" : "line-clamp-2"
          }`}
          title={ctx.summary}
        >
          {ctx.summary}
        </p>
      )}
      {!ctx?.summary && (
        <p className="mt-1.5 text-[11px] leading-snug text-ink-muted italic">
          Profile not built yet. Click rebuild below to generate one.
        </p>
      )}

      {open && (
        <div className="mt-2 pt-2 border-t border-violet-100 space-y-1.5">
          <div className="text-[10px] tracking-[0.12em] uppercase text-violet-700/80">
            Signals
          </div>
          <div className="flex flex-wrap gap-1 text-[11px] text-ink-soft">
            <span className="px-1.5 py-0.5 rounded bg-white/60 tabular">
              {ctx!.counts.memory_n} memories
            </span>
            <span className="px-1.5 py-0.5 rounded bg-white/60 tabular">
              {ctx!.counts.favorite_n} saved
            </span>
            <span className="px-1.5 py-0.5 rounded bg-white/60 tabular">
              {ctx!.counts.upload_n} uploads
            </span>
          </div>
          {ctx!.recentTopics.length > 0 && (
            <>
              <div className="text-[10px] tracking-[0.12em] uppercase text-violet-700/80 mt-1.5">
                Recent topics
              </div>
              <ul className="space-y-0.5">
                {ctx!.recentTopics.slice(0, 3).map((q, i) => (
                  <li
                    key={i}
                    className="text-[11px] text-ink-soft truncate"
                    title={q}
                  >
                    · {q}
                  </li>
                ))}
              </ul>
            </>
          )}
          <button
            onClick={refresh}
            disabled={refreshing}
            className="mt-1.5 text-[11px] text-violet-700 hover:text-violet-900 disabled:opacity-50 inline-flex items-center gap-1"
          >
            <svg
              className={`w-3 h-3 ${refreshing ? "animate-spin" : ""}`}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden
            >
              <path
                d="M21 12a9 9 0 1 1-3-6.7M21 3v6h-6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {refreshing ? "Rebuilding…" : "Rebuild profile"}
          </button>
        </div>
      )}
    </div>
  );
}

function MemoryControls() {
  const [stats, setStats] = useState<{ total: number; newest: string | null } | null>(null);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    fetch("/api/memory", { credentials: "include" })
      .then((r) => r.json())
      .then((d) => d?.ok && setStats(d.stats))
      .catch(() => {});
  }, []);

  async function clearAll() {
    if (!confirm("Erase all cross-session memory? Active sessions stay; only the LLM's recall of past sessions is wiped.")) return;
    setClearing(true);
    try {
      const resp = await fetch("/api/memory", {
        method: "DELETE",
        credentials: "include",
      });
      const data = await resp.json();
      if (data?.ok) {
        setStats({ total: 0, newest: null });
      }
    } finally {
      setClearing(false);
    }
  }

  return (
    <div className="flex items-center justify-between text-[0.7rem] text-ink-muted">
      <span className="inline-flex items-center gap-1.5">
        <svg className="w-3 h-3 text-violet-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M12 2a10 10 0 1 0 10 10M12 6v6l4 2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>{stats?.total ?? "·"} memories</span>
      </span>
      <button
        onClick={clearAll}
        disabled={clearing || (stats?.total ?? 0) === 0}
        className="text-ink-muted hover:text-red-700 disabled:opacity-40 disabled:hover:text-ink-muted transition-colors"
      >
        {clearing ? "Clearing…" : "Clear"}
      </button>
    </div>
  );
}

function relTime(iso: string) {
  const d = new Date(iso).getTime();
  const now = Date.now();
  const s = Math.floor((now - d) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
