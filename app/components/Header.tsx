"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useFavorites } from "./FavoritesContext";
import SavedModal from "./SavedModal";

export default function Header({
  onToggleSidebar,
}: {
  onToggleSidebar?: () => void;
}) {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);
  const [savedOpen, setSavedOpen] = useState(false);
  const { favorites } = useFavorites();

  async function signOut() {
    setSigningOut(true);
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-zinc-200/60 bg-white/70 backdrop-blur-md">
        <div className="px-3 sm:px-4 lg:px-6 h-14 sm:h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {onToggleSidebar && (
              <button
                onClick={onToggleSidebar}
                aria-label="Toggle sidebar"
                className="lg:hidden inline-flex w-9 h-9 items-center justify-center rounded-lg text-ink-muted hover:text-ink hover:bg-zinc-100 transition-colors"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                  <path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round" />
                </svg>
              </button>
            )}
            <div className="flex items-center gap-2.5 select-none">
              <span className="inline-flex items-center justify-center w-7 h-7 sm:w-8 sm:h-8 rounded-md bg-ink text-white font-display text-base sm:text-lg leading-none">
                P
              </span>
              <div className="leading-none">
                <div className="font-display text-base sm:text-lg tracking-tight">
                  PASHA <span className="text-brand-700 italic font-light">Search</span>
                </div>
                <div className="hidden sm:block text-[0.62rem] uppercase tracking-[0.18em] text-ink-muted mt-0.5">
                  Grounded real-estate Q&amp;A
                </div>
              </div>
            </div>
          </div>

          <nav className="flex items-center gap-1 text-sm">
            <button
              onClick={() => setSavedOpen(true)}
              className="inline-flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-zinc-100 transition-colors"
              aria-label={`Saved listings (${favorites.length})`}
            >
              <svg
                className="w-4 h-4 text-rose-500"
                fill={favorites.length > 0 ? "currentColor" : "none"}
                stroke="currentColor"
                strokeWidth="2"
                viewBox="0 0 24 24"
                aria-hidden
              >
                <path d="M12 21s-7-4.35-7-10a4 4 0 0 1 7-2.65A4 4 0 0 1 19 11c0 5.65-7 10-7 10z" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="hidden sm:inline">Saved</span>
              {favorites.length > 0 && (
                <span className="font-mono tabular text-xs px-1 rounded bg-zinc-100 text-ink-soft">
                  {favorites.length}
                </span>
              )}
            </button>
            <button
              onClick={signOut}
              disabled={signingOut}
              className="btn-ghost text-sm"
            >
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
          </nav>
        </div>
      </header>

      <SavedModal open={savedOpen} onClose={() => setSavedOpen(false)} />
    </>
  );
}
