"use client";

/**
 * Single source of truth for which docs are saved by the current user.
 * Held in a React context so the heart-button (inside SourceCard) and the
 * Saved-modal (in Header) stay in sync without prop-drilling.
 *
 * - On mount: GET /api/favorites → seeds the Set of saved doc_ids.
 * - toggle(docId): optimistic flip + POST or DELETE; rolls back on failure.
 * - Items shown in the modal carry the joined `documents` row (title, url,
 *   metadata) so the modal can render full listing info without re-fetching.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type Favorite = {
  id: number;
  doc_id: string;
  note: string | null;
  created_at: string;
  url: string;
  title: string | null;
  doc_type: string;
  language: string;
  metadata: any;
};

type Ctx = {
  favorites: Favorite[];
  savedIds: Set<string>;
  loading: boolean;
  toggle: (docId: string, extra?: Partial<Favorite>) => Promise<void>;
  remove: (docId: string) => Promise<void>;
  setNote: (id: number, note: string | null) => Promise<void>;
  refresh: () => Promise<void>;
};

const FavoritesCtx = createContext<Ctx | null>(null);

export function FavoritesProvider({ children }: { children: React.ReactNode }) {
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/favorites", { credentials: "include" });
      const d = await r.json();
      if (d?.ok) setFavorites(d.favorites || []);
    } catch {
      /* silent */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const savedIds = useMemo(() => new Set(favorites.map((f) => f.doc_id)), [favorites]);

  const toggle = useCallback(
    async (docId: string, extra?: Partial<Favorite>) => {
      if (!docId) return;
      const wasSaved = savedIds.has(docId);
      // Optimistic update
      if (wasSaved) {
        setFavorites((prev) => prev.filter((f) => f.doc_id !== docId));
      } else {
        // Insert placeholder; refresh() will replace with the canonical row.
        setFavorites((prev) => [
          {
            id: -Date.now(),
            doc_id: docId,
            note: null,
            created_at: new Date().toISOString(),
            url: extra?.url || "",
            title: extra?.title || null,
            doc_type: extra?.doc_type || "listing",
            language: extra?.language || "en",
            metadata: extra?.metadata || {},
          },
          ...prev,
        ]);
      }
      try {
        if (wasSaved) {
          const r = await fetch(`/api/favorites?doc_id=${encodeURIComponent(docId)}`, {
            method: "DELETE",
            credentials: "include",
          });
          if (!r.ok) throw new Error("delete failed");
        } else {
          const r = await fetch("/api/favorites", {
            method: "POST",
            headers: { "content-type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ doc_id: docId }),
          });
          if (!r.ok) throw new Error("save failed");
        }
        // Resync from server so the placeholder gets replaced with the
        // canonical row (correct id, server-set created_at).
        refresh();
      } catch {
        // Rollback
        refresh();
      }
    },
    [savedIds, refresh],
  );

  const remove = useCallback(
    async (docId: string) => {
      if (!savedIds.has(docId)) return;
      setFavorites((prev) => prev.filter((f) => f.doc_id !== docId));
      try {
        await fetch(`/api/favorites?doc_id=${encodeURIComponent(docId)}`, {
          method: "DELETE",
          credentials: "include",
        });
      } finally {
        refresh();
      }
    },
    [savedIds, refresh],
  );

  const setNote = useCallback(async (id: number, note: string | null) => {
    setFavorites((prev) => prev.map((f) => (f.id === id ? { ...f, note } : f)));
    try {
      await fetch(`/api/favorites/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ note }),
      });
    } catch {
      /* keep optimistic value; refresh on next mount */
    }
  }, []);

  const value: Ctx = useMemo(
    () => ({ favorites, savedIds, loading, toggle, remove, setNote, refresh }),
    [favorites, savedIds, loading, toggle, remove, setNote, refresh],
  );

  return <FavoritesCtx.Provider value={value}>{children}</FavoritesCtx.Provider>;
}

export function useFavorites() {
  const ctx = useContext(FavoritesCtx);
  if (!ctx) throw new Error("useFavorites must be used inside FavoritesProvider");
  return ctx;
}
