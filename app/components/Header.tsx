"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function Header({
  onToggleSidebar,
}: {
  onToggleSidebar?: () => void;
}) {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <header className="sticky top-0 z-30 border-b border-zinc-200/60 bg-white/70 backdrop-blur-md">
      <div className="px-3 sm:px-4 lg:px-6 h-14 sm:h-16 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {/* Mobile sidebar toggle */}
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
            onClick={signOut}
            disabled={signingOut}
            className="btn-ghost text-sm"
          >
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </nav>
      </div>
    </header>
  );
}
