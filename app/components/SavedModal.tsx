"use client";

/**
 * Saved listings modal — triggered from the header.
 *
 * Shows every doc the user has hearted, with editable note + open / unsave
 * actions. Uses the FavoritesContext as the SSOT so list reflects toggles
 * from anywhere in the app in real time.
 */

import { useEffect, useState } from "react";
import { useFavorites, type Favorite } from "./FavoritesContext";

export default function SavedModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { favorites, loading, remove, setNote, refresh } = useFavorites();

  // Re-fetch on open in case other tabs/sessions changed state.
  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Saved listings"
    >
      <div className="absolute inset-0 bg-ink/40 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-2xl flex flex-col bg-white shadow-2xl border-t sm:border border-zinc-200 overflow-hidden
                   rounded-t-2xl sm:rounded-2xl
                   h-[88svh] sm:h-auto sm:max-h-[88vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-200">
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5 text-rose-500" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path d="M12 21s-7-4.35-7-10a4 4 0 0 1 7-2.65A4 4 0 0 1 19 11c0 5.65-7 10-7 10z" />
            </svg>
            <h2 className="font-display text-xl">Saved listings</h2>
            <span className="text-xs tabular text-ink-muted ml-1">
              {favorites.length}
            </span>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-11 h-11 sm:w-8 sm:h-8 inline-flex items-center justify-center rounded-lg text-ink-muted hover:text-ink hover:bg-zinc-100 transition-colors -mr-2 sm:mr-0"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto p-3 sm:p-5">
          {loading && favorites.length === 0 && (
            <div className="space-y-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="skeleton h-20 rounded-xl" />
              ))}
            </div>
          )}

          {!loading && favorites.length === 0 && (
            <div className="py-12 text-center">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-rose-50 text-rose-500 mb-3">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden>
                  <path d="M12 21s-7-4.35-7-10a4 4 0 0 1 7-2.65A4 4 0 0 1 19 11c0 5.65-7 10-7 10z" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <div className="text-sm text-ink-muted">No saved listings yet.</div>
              <div className="text-xs text-ink-muted/70 mt-1">
                Tap the heart on a source card to save it for later.
              </div>
            </div>
          )}

          <div className="space-y-3">
            {favorites.map((f) => (
              <FavoriteRow key={f.id} fav={f} onRemove={() => remove(f.doc_id)} onSetNote={(n) => setNote(f.id, n)} />
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-zinc-200 text-[0.7rem] text-ink-muted safe-pb">
          Saved listings live in <span className="font-mono">favorites</span> table in Neon — one row per (user, doc_id).
        </div>
      </div>
    </div>
  );
}

function FavoriteRow({
  fav,
  onRemove,
  onSetNote,
}: {
  fav: Favorite;
  onRemove: () => void;
  onSetNote: (n: string | null) => void;
}) {
  const [editingNote, setEditingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState(fav.note || "");
  const m = fav.metadata || {};
  const url = fav.url || "";
  const pathName = url.replace(/^https?:\/\/[^/]+/, "");
  const title = fav.title || m.location || pathName || url;

  const facts: string[] = [];
  if (m.price) facts.push(`${Number(m.price).toLocaleString()}${m.currency ? " " + m.currency : ""}`);
  if (m.bedrooms != null) facts.push(`${m.bedrooms} bed`);
  if (m.area_sqm) facts.push(`${m.area_sqm} m²`);
  if (m.property_type) facts.push(m.property_type);

  return (
    <div className="border border-zinc-200 rounded-xl p-3 hover:border-zinc-300 transition-colors">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="block text-[0.95rem] font-medium text-ink hover:text-brand-700 transition-colors line-clamp-1"
          >
            {title}
          </a>
          <div className="text-[11px] font-mono text-ink-muted line-clamp-1 mt-0.5">
            {url.replace(/^https?:\/\//, "")}
          </div>
          {facts.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {facts.map((f, i) => (
                <span
                  key={i}
                  className="text-[0.66rem] px-1.5 py-0.5 rounded border border-zinc-200 bg-zinc-50 text-ink-muted tabular"
                >
                  {f}
                </span>
              ))}
              {fav.language !== "en" && (
                <span className="badge bg-zinc-100 text-zinc-700 uppercase">{fav.language}</span>
              )}
            </div>
          )}
          <div className="mt-2">
            {editingNote ? (
              <div className="flex items-stretch gap-2">
                <input
                  type="text"
                  value={noteDraft}
                  onChange={(e) => setNoteDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      onSetNote(noteDraft.trim() || null);
                      setEditingNote(false);
                    } else if (e.key === "Escape") {
                      setNoteDraft(fav.note || "");
                      setEditingNote(false);
                    }
                  }}
                  autoFocus
                  placeholder="Add a note (Enter to save)…"
                  className="flex-1 px-2 py-1 text-xs border border-zinc-200 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500"
                />
                <button
                  onClick={() => {
                    onSetNote(noteDraft.trim() || null);
                    setEditingNote(false);
                  }}
                  className="text-xs px-2 py-1 rounded bg-ink text-white hover:bg-zinc-800"
                >
                  Save
                </button>
              </div>
            ) : (
              <button
                onClick={() => setEditingNote(true)}
                className="text-xs text-ink-muted hover:text-ink italic transition-colors text-left"
              >
                {fav.note ? `"${fav.note}"` : "+ add note"}
              </button>
            )}
          </div>
        </div>
        <button
          onClick={onRemove}
          aria-label="Unsave"
          title="Unsave"
          className="flex-none w-8 h-8 inline-flex items-center justify-center rounded-lg text-rose-500 hover:bg-rose-50 transition-colors"
        >
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
            <path d="M12 21s-7-4.35-7-10a4 4 0 0 1 7-2.65A4 4 0 0 1 19 11c0 5.65-7 10-7 10z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
