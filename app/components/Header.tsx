"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { useFavorites } from "./FavoritesContext";
import SavedModal from "./SavedModal";

export default function Header({
  onToggleSidebar,
}: {
  onToggleSidebar?: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [signingOut, setSigningOut] = useState(false);
  const [savedOpen, setSavedOpen] = useState(false);
  const { favorites } = useFavorites();
  const onUploads = pathname === "/uploads";

  async function signOut() {
    setSigningOut(true);
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-zinc-200/60 bg-white/70 backdrop-blur-md">
        <div className="safe-px px-3 sm:px-4 lg:px-6 h-14 sm:h-16 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {onToggleSidebar && (
              <button
                onClick={onToggleSidebar}
                aria-label="Toggle sidebar"
                className="lg:hidden flex-none inline-flex w-11 h-11 items-center justify-center rounded-lg text-ink-muted hover:text-ink hover:bg-zinc-100 transition-colors -ml-2"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                  <path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round" />
                </svg>
              </button>
            )}
            <div className="flex items-center gap-2.5 select-none min-w-0">
              <span className="inline-flex flex-none items-center justify-center w-7 h-7 sm:w-8 sm:h-8 rounded-md bg-ink text-white font-display text-base sm:text-lg leading-none">
                P
              </span>
              <div className="leading-none min-w-0">
                <div className="font-display text-base sm:text-lg tracking-tight truncate">
                  PASHA <span className="text-brand-700 italic font-light">Search</span>
                </div>
                <div className="hidden sm:block text-[0.62rem] uppercase tracking-[0.18em] text-ink-muted mt-0.5 truncate">
                  Grounded real-estate Q&amp;A
                </div>
              </div>
            </div>
          </div>

          <nav className="flex items-center gap-0.5 sm:gap-1 text-sm flex-none">
            <Link
              href={onUploads ? "/" : "/uploads"}
              prefetch={false}
              className={`inline-flex items-center gap-1.5 min-h-[44px] sm:min-h-0 px-2.5 sm:px-3 py-1.5 rounded-lg transition-colors ${
                onUploads
                  ? "text-ink bg-zinc-100"
                  : "text-ink-muted hover:text-ink hover:bg-zinc-100"
              }`}
              aria-label={onUploads ? "Back to chat" : "Open uploads library"}
              title={onUploads ? "Back to chat" : "Uploaded documents"}
            >
              <svg
                className="w-4 h-4"
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
              <span className="hidden sm:inline">
                {onUploads ? "Chat" : "Uploads"}
              </span>
            </Link>
            <a
              href="https://github.com/ismatsamadov/real_estate_rag"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="View source on GitHub"
              title="View source on GitHub"
              className="hidden sm:inline-flex w-9 h-9 items-center justify-center rounded-lg text-ink-muted hover:text-ink hover:bg-zinc-100 transition-colors"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M12 0a12 12 0 0 0-3.79 23.4c.6.1.82-.26.82-.58v-2.02c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.08-.74.08-.72.08-.72 1.2.09 1.83 1.24 1.83 1.24 1.07 1.83 2.81 1.3 3.49 1 .11-.78.42-1.3.76-1.6-2.66-.31-5.47-1.34-5.47-5.93 0-1.31.47-2.38 1.23-3.22-.12-.3-.54-1.52.12-3.17 0 0 1-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.3-1.55 3.3-1.23 3.3-1.23.66 1.65.25 2.87.12 3.17.77.84 1.23 1.91 1.23 3.22 0 4.6-2.81 5.61-5.49 5.91.43.37.81 1.1.81 2.22v3.29c0 .32.21.69.83.58A12 12 0 0 0 12 0z" />
              </svg>
            </a>
            <button
              onClick={() => setSavedOpen(true)}
              className="inline-flex items-center gap-1.5 min-h-[44px] sm:min-h-0 px-2.5 sm:px-3 py-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-zinc-100 transition-colors"
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
