#!/usr/bin/env node
"use strict";

/**
 * Full-site scraper.
 *
 *   1. DISCOVER URLs via Firecrawl's map endpoint (sitemap + crawl-based
 *      discovery). This catches pages the sitemap misses — paginated
 *      listings, deep links from category pages, JS-rendered routes, etc.
 *   2. CLASSIFY each URL as `listing` | `article` | `static` and tag the
 *      detected language (en | az | ru) from the URL path.
 *   3. SCRAPE in batches via Firecrawl with JS render + onlyMainContent so
 *      we get clean Markdown without nav/footer noise.
 *   4. Stream JSONL to disk, atomic rename at end.
 *
 * Flags:
 *   --urls-only          Discover + classify only; no scraping (debug)
 *   --limit <N>          Cap total URLs after classification
 *   --include-types a,b  Keep only these doc_types (e.g. listing,article)
 *   --languages a,b      Override SCRAPE_LANGUAGES env
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const FirecrawlApp = require("@mendable/firecrawl-js").default;

const config = require("../src/config");
const logger = require("../src/logger");

const log = logger.child({ component: "scrape" });

if (!config.firecrawl.apiKey) {
  log.fatal("FIRECRAWL_API_KEY is required for scraping.");
  process.exit(1);
}

// ----------------------------------------------------------------------------
// URL classification
// ----------------------------------------------------------------------------

// Patterns reflect the actual URL structure observed on pasharealestate.az:
//   /units/<slug>          individual unit listings (EN)
//   /menziller/<slug>      individual unit listings (AZ; "menziller" = apartments)
//   /kvartiry/<slug>       individual unit listings (RU)
//   /portfolio/<slug>      development/project pages (treated as listings —
//                          they carry pricing + amenity facts that retrieval
//                          should ground answers on)
const LISTING_PATTERNS = [
  /\/(property|properties|listing|listings|estate|estates|object|objects)\b/i,
  /\/(units|menziller|portfolio)\//i, // pasharealestate.az specific (EN/AZ)
  /\/(elan|elanlar|obyekt|obyektler)\b/i, // generic Azerbaijani
  /\/(obyavlen|nedvizhimost|kvartir)\w*/i, // Russian
  /-\d{3,}$/, // slug ending in long numeric ID (PRE unit IDs)
  /\/\d{4,}(?:[/?]|$)/, // numeric ID segment
];

const ARTICLE_PATTERNS = [
  /\/(news|blog|article|articles|post|posts|insights|guide|guides|press)\b/i,
  /\/(xeber|xeberler|meqale)\b/i, // Azerbaijani
  /\/(novost|stat)\w*/i, // Russian
];

const LANGUAGE_PREFIX_RE = /^\/(en|az|ru|tr)(?:\/|$)/i;

const EXCLUDE_PATTERNS = [
  /\/(login|signin|signup|register|account|cart|checkout|wp-admin|admin)\b/i,
  /\.(jpg|jpeg|png|gif|svg|webp|pdf|zip|mp4|css|js|xml|txt|json|ico|woff2?|ttf|eot)(\?|$)/i,
  /\/(sitemap|robots|feed|rss|atom)(\.|$)/i,
  /^mailto:/i,
  /^tel:/i,
  /^javascript:/i,
];

function classifyUrl(rawUrl, baseUrl) {
  let u;
  try {
    u = new URL(rawUrl, baseUrl);
  } catch {
    return null;
  }
  if (EXCLUDE_PATTERNS.some((re) => re.test(u.href))) return null;
  // Same-origin only.
  if (new URL(baseUrl).hostname !== u.hostname) return null;

  const pathname = u.pathname || "/";
  const langMatch = pathname.match(LANGUAGE_PREFIX_RE);
  const language = langMatch ? langMatch[1].toLowerCase() : "en";

  let docType = "static";
  if (LISTING_PATTERNS.some((re) => re.test(pathname))) docType = "listing";
  else if (ARTICLE_PATTERNS.some((re) => re.test(pathname))) docType = "article";

  return {
    url: u.href,
    pathname,
    language,
    docType,
  };
}

// ----------------------------------------------------------------------------
// Discovery
// ----------------------------------------------------------------------------

async function discoverUrls(app, baseUrl) {
  // Firecrawl's map endpoint returns the union of sitemap URLs and
  // crawl-discovered URLs. useIndex=true lets it use cached site indexes
  // for speed; includeSubdomains=true catches subdomain variants.
  log.info({ baseUrl }, "discovering URLs via Firecrawl map");
  const res = await app.mapUrl(baseUrl, {
    includeSubdomains: false,
    sitemapOnly: false,
    useIndex: true,
    limit: config.scrape.maxPages * 2, // overfetch; we'll filter below
  });
  if (!res?.success) {
    throw new Error(`Firecrawl map failed: ${res?.error || "unknown"}`);
  }
  const links = res.links || [];
  log.info({ found: links.length }, "raw URLs discovered");
  return links;
}

// ----------------------------------------------------------------------------
// Scraping
// ----------------------------------------------------------------------------

async function batchScrape(app, urls) {
  // batchScrapeUrls polls until all done. We use markdown + html so the
  // chunker can fall back to HTML for structured tables. onlyMainContent
  // strips nav/footer/cookies. waitFor gives JS-heavy listing pages time
  // to hydrate.
  log.info({ count: urls.length }, "batch scraping");
  const res = await app.batchScrapeUrls(
    urls,
    {
      formats: ["markdown", "html"],
      onlyMainContent: true,
      waitFor: 1500,
      timeout: 30_000,
      blockAds: true,
    },
    /* pollInterval */ 5,
    /* idempotencyKey */ undefined,
    /* webhook */ undefined,
    /* ignoreInvalidURLs */ true,
    /* maxConcurrency */ config.scrape.concurrency,
  );
  if (!res?.success && res?.status !== "completed") {
    throw new Error(`Batch scrape failed: ${res?.error || JSON.stringify(res).slice(0, 200)}`);
  }
  return res.data || [];
}

// ----------------------------------------------------------------------------
// Output helpers
// ----------------------------------------------------------------------------

function urlToDocId(url) {
  // Stable, filesystem-safe ID derived from URL hash.
  return crypto.createHash("sha1").update(url).digest("hex").slice(0, 16);
}

function pickTitle(metadata, markdown) {
  if (metadata?.title) return String(metadata.title).trim();
  if (metadata?.ogTitle) return String(metadata.ogTitle).trim();
  // Fallback: first non-empty H1 in markdown.
  const m = String(markdown || "").match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

// ----------------------------------------------------------------------------
// CLI parsing
// ----------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { urlsOnly: false, limit: null, includeTypes: null, languages: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--urls-only") args.urlsOnly = true;
    else if (a === "--limit") args.limit = parseInt(argv[++i], 10);
    else if (a === "--include-types") args.includeTypes = argv[++i].split(",");
    else if (a === "--languages") args.languages = argv[++i].split(",");
  }
  return args;
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const app = new FirecrawlApp({ apiKey: config.firecrawl.apiKey });
  const baseUrl = config.scrape.baseUrl;
  const languages = new Set((args.languages || config.scrape.languages).map((l) => l.toLowerCase()));
  const includeTypes = args.includeTypes ? new Set(args.includeTypes) : null;

  // 1. Discover
  const rawUrls = await discoverUrls(app, baseUrl);

  // 2. Classify + filter
  const classified = [];
  const stats = { total: 0, excluded: 0, byLang: {}, byType: {} };
  for (const raw of rawUrls) {
    stats.total += 1;
    const c = classifyUrl(raw, baseUrl);
    if (!c) {
      stats.excluded += 1;
      continue;
    }
    if (!languages.has(c.language)) {
      stats.excluded += 1;
      continue;
    }
    if (includeTypes && !includeTypes.has(c.docType)) {
      stats.excluded += 1;
      continue;
    }
    classified.push(c);
    stats.byLang[c.language] = (stats.byLang[c.language] || 0) + 1;
    stats.byType[c.docType] = (stats.byType[c.docType] || 0) + 1;
  }

  // De-dupe (Firecrawl can return duplicates with/without trailing slash).
  const seen = new Set();
  const deduped = classified.filter((c) => {
    const key = c.url.replace(/\/$/, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const max = args.limit ?? config.scrape.maxPages;
  const final = deduped.slice(0, max);

  log.info(
    { discovered: stats.total, kept: final.length, excluded: stats.excluded, byLang: stats.byLang, byType: stats.byType },
    "classification complete",
  );

  if (args.urlsOnly) {
    const out = path.resolve(config.paths.repoRoot, "data/urls.json");
    await fsp.mkdir(path.dirname(out), { recursive: true });
    await fsp.writeFile(out, JSON.stringify(final, null, 2));
    log.info({ output: out, count: final.length }, "URLs written (--urls-only)");
    return;
  }

  // 3. Batch scrape
  const urlList = final.map((c) => c.url);
  const classByUrl = new Map(final.map((c) => [c.url, c]));

  const outFinal = config.paths.outputJsonl;
  await fsp.mkdir(path.dirname(outFinal), { recursive: true });
  const outTmp = `${outFinal}.${process.pid}.tmp`;
  const writer = fs.createWriteStream(outTmp, { encoding: "utf8" });

  // Process in chunks of 100 to keep batch-scrape responses manageable.
  const CHUNK = 100;
  let ok = 0, empty = 0, failed = 0;

  for (let i = 0; i < urlList.length; i += CHUNK) {
    const slice = urlList.slice(i, i + CHUNK);
    log.info({ from: i, to: i + slice.length, total: urlList.length }, "batch slice");
    let data;
    try {
      data = await batchScrape(app, slice);
    } catch (err) {
      failed += slice.length;
      log.error({ err: err.message, from: i, count: slice.length }, "batch failed");
      continue;
    }

    for (const item of data) {
      // Firecrawl returns items shaped differently across versions; defensive.
      const url = item?.metadata?.sourceURL || item?.url || item?.metadata?.url;
      const markdown = item?.markdown || item?.data?.markdown || "";
      const html = item?.html || item?.data?.html || "";
      const meta = item?.metadata || item?.data?.metadata || {};
      if (!url) {
        empty += 1;
        continue;
      }
      const cls = classByUrl.get(url) || classifyUrl(url, baseUrl);
      if (!cls) {
        empty += 1;
        continue;
      }
      if (!String(markdown).trim()) {
        empty += 1;
        log.debug({ url }, "skip empty");
        continue;
      }
      const record = {
        doc_id: urlToDocId(url),
        url,
        title: pickTitle(meta, markdown),
        language: cls.language,
        doc_type: cls.docType,
        markdown,
        html,
        source_metadata: meta,
        scraped_at: new Date().toISOString(),
      };
      await new Promise((resolve, reject) =>
        writer.write(`${JSON.stringify(record)}\n`, (err) => (err ? reject(err) : resolve())),
      );
      ok += 1;
    }
  }

  await new Promise((resolve, reject) => writer.end((err) => (err ? reject(err) : resolve())));
  await fsp.rename(outTmp, outFinal);

  log.info({ ok, empty, failed, output: outFinal }, "scrape complete");
}

main().catch((err) => {
  log.fatal({ err: err.message, stack: err.stack }, "scrape failed");
  process.exit(1);
});
