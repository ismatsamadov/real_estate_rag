/**
 * Next.js config.
 *
 *   - `output: "standalone"` builds a self-contained server.js + minimal node_modules
 *     copy, which keeps the production image small and makes both Vercel and any
 *     container host happy.
 *   - `serverExternalPackages` keeps native/CJS deps (pg, voyageai, Anthropic SDK,
 *     pino) from being bundled by Turbopack — they stay loaded via require() at
 *     runtime so we don't fight tree-shaking warnings or ESM/CJS interop.
 *   - We import from the existing `src/` CommonJS modules directly; no migration
 *     required.
 */
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  serverExternalPackages: [
    "@anthropic-ai/sdk",
    "voyageai",
    "pg",
    "pino",
    "pino-pretty",
    // pdfjs-dist's worker loader needs the package to stay external
    // (otherwise Next bundles `pdf.js` but loses `pdf.worker.mjs`).
    "pdfjs-dist",
  ],
  // pdfjs-dist dynamically `import()`s its worker file, which Next.js's
  // static tracer can't follow. Without this hint Vercel ships pdf.mjs
  // but not pdf.worker.mjs, and the documents route crashes with
  // "Setting up fake worker failed: Cannot find module …pdf.worker.mjs".
  outputFileTracingIncludes: {
    "/api/documents/**": [
      "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
    ],
  },

  // Don't fail the build on lint/type warnings — we use .tsx files purely
  // to get ESM parsing inside a CommonJS-rooted repo, not for type safety.
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },

  // Strip Next.js fingerprinting from responses.
  poweredByHeader: false,

  // Baseline security headers applied to every response.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // Defense in depth even though SSR cookies are httpOnly+sameSite=lax.
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-DNS-Prefetch-Control", value: "off" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          // HSTS only matters on HTTPS; harmless on localhost.
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
