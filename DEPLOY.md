# Deploying to Vercel

## One-time setup

```bash
# 1. Install Vercel CLI (or use `npx vercel`)
npm i -g vercel

# 2. Log in (opens browser)
vercel login

# 3. From the repo root, link the project
vercel link
```

## Set production env vars

```bash
vercel env add DATABASE_URL production          # Neon connection string
vercel env add ANTHROPIC_API_KEY production
vercel env add VOYAGE_AI_API_KEY production
vercel env add FIRECRAWL_API_KEY production     # only needed if you re-scrape from CI
```

Tip: paste each value when prompted. To copy from `.env` non-interactively:

```bash
grep -E "^(DATABASE_URL|ANTHROPIC_API_KEY|VOYAGE_AI_API_KEY|FIRECRAWL_API_KEY)=" .env \
  | while IFS='=' read -r k v; do echo "$v" | vercel env add "$k" production; done
```

## Deploy

```bash
# Preview deploy (any branch)
vercel

# Production deploy
vercel --prod
```

## What's wired

- **Framework**: Next.js 15 (App Router) — detected automatically.
- **Region**: `fra1` (Frankfurt) — closest to Baku users. See `vercel.json`.
- **Function `app/api/ask/stream/route.ts`**:
  - `runtime: "nodejs"` (needs `pg` and CJS interop with `src/`)
  - `maxDuration: 60` (Hobby tier supports up to 300; 60s is enough for Sonnet streams)
  - `memory: 1024` MB
- **Function `app/api/health/route.ts`**: 10s, 512 MB.
- **Excluded from deploy**: `data/`, `scripts/`, `screenshots/`, `web/` — see `.vercelignore`.

## Verify the live deploy

```bash
URL=https://your-app.vercel.app

# Health
curl -s "$URL/api/health" | jq .

# Streaming (first event = sources)
curl -sN -X POST "$URL/api/ask/stream" \
  -H "content-type: application/json" \
  -d '{"question":"What apartments are at St Regis Baku?","topK":5}' \
  | head -3
```

## Troubleshooting

- **Function timeout**: bump `maxDuration` in `vercel.json` (300s Hobby max, 800s Pro).
- **`pg` connection pool exhausted**: Neon's serverless mode allows ~100 connections by default; if you scale up traffic, set `NEON_POOL_MAX=5` and ensure `src/db.js` uses `max: 5`.
- **Cold start latency**: first request after idle hits a ~500ms cold start. Acceptable for demo; for production add `vercel cron` to ping `/api/health` every 5 min.
- **Anthropic 429 on demo day**: prompt cache hits aren't possible because the system prompt is below 1024 tokens. Mitigation: add a payment method to lift the lowest-tier per-org limit.
