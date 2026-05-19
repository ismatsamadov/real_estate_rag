import AskInterface from "./components/AskInterface";
import Header from "./components/Header";

export default function Home() {
  return (
    <main className="min-h-screen relative">
      {/* Atmospheric backdrop */}
      <div className="absolute inset-0 -z-10 bg-white" />
      <div
        className="absolute inset-x-0 top-0 -z-10 h-[640px] opacity-100 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse 70% 50% at 50% -10%, rgba(200,145,72,0.25), rgba(200,145,72,0) 70%), radial-gradient(ellipse 50% 40% at 85% 20%, rgba(10,10,10,0.06), transparent 60%), radial-gradient(ellipse 50% 40% at 15% 25%, rgba(10,10,10,0.04), transparent 60%)",
        }}
      />
      <div
        className="absolute inset-0 -z-10 opacity-50 pointer-events-none [mask-image:linear-gradient(180deg,black,transparent_60%)]"
        style={{
          backgroundImage:
            "linear-gradient(to right, rgba(0,0,0,.035) 1px, transparent 1px), linear-gradient(to bottom, rgba(0,0,0,.035) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
        }}
      />

      <Header />

      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8 pt-10 sm:pt-16 lg:pt-20 pb-20">
        {/* Hero */}
        <section className="mb-12 sm:mb-16">
          <div className="inline-flex items-center gap-2 mb-6 px-3 py-1 rounded-full border border-zinc-200/80 bg-white/60 backdrop-blur-sm text-[0.72rem] tracking-[0.18em] uppercase text-ink-muted">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 pulse-dot" />
            <span>Live · grounded answers in EN · AZ · RU</span>
          </div>

          <h1 className="font-display text-[2.5rem] sm:text-[4rem] lg:text-[5.25rem] leading-[0.98] tracking-[-0.02em] text-ink">
            Baku&rsquo;s premium
            <br />
            real estate,
            <br />
            <span className="italic font-light text-brand-700">answered with sources.</span>
          </h1>

          <p className="mt-6 text-base sm:text-lg text-ink-muted max-w-2xl leading-relaxed">
            Ask anything about The Residences at the St.&nbsp;Regis Baku, The Crescent Residences,
            Knightsbridge Residence, The Ritz-Carlton Residences, or Mardi Mekan Estate.
            Every claim links to its source page — no marketing fluff, no hallucination.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-2 text-[0.72rem] uppercase tracking-[0.16em] text-ink-muted">
            <Spec label="Embed" value="voyage-4-large" />
            <Spec label="Rerank" value="rerank-2.5" />
            <Spec label="Generate" value="claude-sonnet-4-6" />
            <Spec label="Store" value="Neon · pgvector + RRF" />
          </div>
        </section>

        <AskInterface />

        {/* Footer */}
        <footer className="mt-24 pt-8 border-t border-zinc-200/70">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between text-sm text-ink-muted">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-medium text-ink">PASHA RE Search</span>
              <span aria-hidden>·</span>
              <span>hybrid retrieval</span>
              <span aria-hidden>·</span>
              <span>cross-encoder rerank</span>
              <span aria-hidden>·</span>
              <span>SSE streaming</span>
            </div>
            <a
              href="https://pasharealestate.az"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs hover:text-ink transition-colors"
            >
              Corpus: pasharealestate.az ↗
            </a>
          </div>
        </footer>
      </div>
    </main>
  );
}

function Spec({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-ink-muted/60">{label}</span>
      <span className="font-mono normal-case tracking-normal text-ink">{value}</span>
    </span>
  );
}
