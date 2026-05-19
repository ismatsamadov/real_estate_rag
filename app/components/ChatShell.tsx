"use client";

import { useCallback, useEffect, useState } from "react";
import Header from "./Header";
import Sidebar from "./Sidebar";
import ChatView from "./ChatView";
import { FavoritesProvider } from "./FavoritesContext";

/**
 * Top-level shell that wires together:
 *   Header (sticky, with sidebar toggle on mobile)
 *   Sidebar (session list + new chat)
 *   ChatView (thread + composer)
 *
 * Session id is held here and synced to ?c=<uuid> in the URL so a tab can
 * be reloaded or shared without losing context.
 */
export default function ChatShell() {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Bumped whenever a session is created/deleted so the sidebar re-fetches.
  const [refreshKey, setRefreshKey] = useState(0);

  // Hydrate from URL on mount and keep in sync.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const c = url.searchParams.get("c");
    if (c) setActiveSessionId(c);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (activeSessionId) url.searchParams.set("c", activeSessionId);
    else url.searchParams.delete("c");
    window.history.replaceState({}, "", url.toString());
  }, [activeSessionId]);

  const handleNew = useCallback(() => {
    setActiveSessionId(null);
  }, []);

  const handleSelect = useCallback((id: string) => {
    setActiveSessionId(id);
  }, []);

  const handleSessionCreated = useCallback((id: string) => {
    setActiveSessionId(id);
    setRefreshKey((k) => k + 1);
  }, []);

  return (
    <FavoritesProvider>
      <div className="min-h-screen flex flex-col">
        <Header onToggleSidebar={() => setSidebarOpen((o) => !o)} />

        <div className="flex-1 flex">
          <Sidebar
            activeSessionId={activeSessionId}
            onSelect={handleSelect}
            onNew={handleNew}
            refreshKey={refreshKey}
            isOpen={sidebarOpen}
            onClose={() => setSidebarOpen(false)}
          />

          <main className="flex-1 min-w-0">
            <ChatView
              key={activeSessionId || "new"}
              sessionId={activeSessionId}
              onSessionCreated={handleSessionCreated}
            />
          </main>
        </div>
      </div>
    </FavoritesProvider>
  );
}
