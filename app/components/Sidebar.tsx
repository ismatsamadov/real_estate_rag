"use client";

import { useCallback, useEffect, useState } from "react";

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
        className={`fixed lg:sticky lg:top-14 top-14 left-0 z-40 lg:z-auto h-[calc(100dvh-3.5rem)] lg:h-[calc(100dvh-3.5rem)] w-[280px] sm:w-[300px] border-r border-zinc-200/70 bg-white/80 backdrop-blur-md transform transition-transform duration-200 ${
          isOpen ? "translate-x-0" : "-translate-x-full"
        } lg:translate-x-0 flex flex-col`}
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
            const select = () => {
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
                tabIndex={0}
                onClick={select}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    select();
                  }
                }}
                aria-pressed={isActive}
                aria-label={`Open session: ${s.title || s.first_question || "New chat"}`}
                className={`group w-full text-left px-3 py-2.5 rounded-lg transition-all relative cursor-pointer ${
                  isActive
                    ? "bg-zinc-100 text-ink"
                    : "hover:bg-zinc-50 text-ink-soft"
                } ${isDel ? "opacity-40" : ""} focus-visible:outline-none`}
              >
                <div className="text-[13px] leading-snug font-medium line-clamp-2 pr-7">
                  {s.title || s.first_question || "New chat"}
                </div>
                <div className="text-[11px] text-ink-muted mt-0.5">
                  {s.message_count} {s.message_count === 1 ? "message" : "messages"} ·{" "}
                  {relTime(s.updated_at)}
                </div>
                <button
                  type="button"
                  onClick={(e) => deleteSession(s.session_id, e)}
                  aria-label="Delete conversation"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1.5 rounded opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-red-50 hover:text-red-700 text-ink-muted transition-all"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" aria-hidden>
                    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>
            );
          })}
        </div>

        <div className="p-3 border-t border-zinc-200/70 space-y-2">
          <MemoryControls />
          <div className="text-[0.7rem] tracking-[0.08em] text-ink-muted">
            {sessions.length} {sessions.length === 1 ? "session" : "sessions"} · Neon · pgvector
          </div>
        </div>
      </aside>
    </>
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
