import LoginForm from "./LoginForm";

export const metadata = {
  title: "Sign in · PASHA Real Estate Search",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const params = await searchParams;
  const next = params?.next || "/";
  return (
    <main className="min-h-screen relative overflow-hidden">
      {/* Background — layered radial gradients give a quiet, premium feel */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_10%_10%,rgba(200,145,72,0.18),transparent_55%),radial-gradient(circle_at_90%_90%,rgba(10,10,10,0.08),transparent_60%)] bg-zinc-50" />
      <div className="absolute inset-0 [mask-image:linear-gradient(180deg,black,transparent_80%)] opacity-30"
        style={{
          backgroundImage:
            "linear-gradient(to right, rgba(0,0,0,.04) 1px, transparent 1px), linear-gradient(to bottom, rgba(0,0,0,.04) 1px, transparent 1px)",
          backgroundSize: "32px 32px",
        }}
      />

      <div className="relative grid lg:grid-cols-2 min-h-screen">
        {/* Left: brand panel */}
        <aside className="hidden lg:flex flex-col justify-between p-12 text-ink">
          <div className="flex items-center gap-3 text-sm">
            <span className="inline-block w-2 h-2 rounded-full bg-brand-500" />
            <span className="tracking-[0.2em] uppercase text-ink-muted">PASHA Real Estate</span>
          </div>
          <div className="space-y-6 max-w-md">
            <h1 className="font-display text-5xl xl:text-6xl leading-[1.05] tracking-tight">
              Search Baku's premium addresses,<br />
              <span className="italic font-light text-brand-700">grounded in citations.</span>
            </h1>
            <p className="text-ink-muted leading-relaxed">
              Hybrid retrieval over <span className="font-mono text-ink">pgvector</span> and{" "}
              <span className="font-mono text-ink">Postgres FTS</span>, reranked by{" "}
              <span className="font-mono text-ink">Voyage rerank&#8209;2.5</span>, answered by{" "}
              <span className="font-mono text-ink">Claude Sonnet&#8209;4.6</span>. Every claim
              traceable to its source.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-ink-muted">
            <span>Multilingual EN · AZ · RU</span>
            <span>·</span>
            <span>Streaming SSE</span>
            <span>·</span>
            <span>LLM-as-judge eval</span>
          </div>
        </aside>

        {/* Right: form */}
        <section className="flex items-center justify-center p-6 sm:p-12">
          <div className="w-full max-w-md">
            <div className="lg:hidden mb-8 flex items-center gap-3 text-sm">
              <span className="inline-block w-2 h-2 rounded-full bg-brand-500" />
              <span className="tracking-[0.2em] uppercase text-ink-muted">PASHA Real Estate</span>
            </div>
            <div className="bg-white/70 backdrop-blur-md border border-zinc-200/70 rounded-2xl shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_-12px_rgba(0,0,0,0.12)] p-7 sm:p-9">
              <h2 className="font-display text-3xl mb-1">Welcome back</h2>
              <p className="text-sm text-ink-muted mb-7">
                Sign in to continue.
              </p>
              <LoginForm next={next} />
            </div>
            <p className="mt-6 text-xs text-ink-muted text-center">
              Access is restricted. Contact the project owner for credentials.
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
