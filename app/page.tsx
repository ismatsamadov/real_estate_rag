import AskInterface from "./components/AskInterface";

export default function Home() {
  return (
    <main className="min-h-screen bg-gradient-to-b from-white via-brand-50/40 to-white">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 py-8 sm:py-12">
        <header className="mb-8 sm:mb-12">
          <div className="flex items-center gap-3 text-sm text-ink-muted mb-3">
            <span className="badge bg-brand-100 text-brand-700">RAG</span>
            <span>•</span>
            <span className="font-mono">voyage-4-large</span>
            <span>•</span>
            <span className="font-mono">rerank-2.5</span>
            <span>•</span>
            <span className="font-mono">claude-sonnet-4-6</span>
            <span>•</span>
            <span className="font-mono">pgvector</span>
          </div>
          <h1 className="text-3xl sm:text-5xl font-semibold tracking-tight text-ink leading-tight">
            PASHA Real Estate Search
          </h1>
          <p className="mt-3 text-base sm:text-lg text-ink-muted max-w-2xl">
            Ask questions about Baku's premium luxury developments — The Residences at the St.&nbsp;Regis Baku,
            The Crescent Residences, Knightsbridge Residence, The Ritz-Carlton Residences.
            Every claim is grounded in citations linking to the source page.
          </p>
        </header>

        <AskInterface />

        <footer className="mt-16 pt-8 border-t border-zinc-100 text-sm text-ink-muted">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <span>Hybrid retrieval (pgvector + Postgres FTS, RRF fusion)</span>
            <span>•</span>
            <span>Voyage cross-encoder rerank</span>
            <span>•</span>
            <span>Streaming SSE</span>
            <span>•</span>
            <span>Multilingual EN/AZ/RU</span>
          </div>
        </footer>
      </div>
    </main>
  );
}
