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
    "@mendable/firecrawl-js",
    "pg",
    "pino",
    "pino-pretty",
  ],
  // Don't fail the build on lint/type warnings — we use .tsx files purely
  // to get ESM parsing inside a CommonJS-rooted repo, not for type safety.
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
};

module.exports = nextConfig;
