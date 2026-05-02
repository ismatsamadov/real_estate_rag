#!/usr/bin/env node
"use strict";

/**
 * Sitemap-driven scraper.
 *
 *   1. Walks the configured sitemap (handling sitemap-index nesting).
 *   2. Scrapes each URL via Firecrawl with bounded concurrency and
 *      exponential-backoff retries.
 *   3. Streams JSONL records to disk and atomically renames at the end so
 *      a crash mid-run never leaves a half-written corpus.
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");

const FirecrawlApp = require("@mendable/firecrawl-js").default;
const { XMLParser } = require("fast-xml-parser");

const config = require("../src/config");
const logger = require("../src/logger");

const log = logger.child({ component: "scrape" });

if (!config.firecrawl.apiKey) {
  log.fatal("FIRECRAWL_API_KEY is required for scraping.");
  process.exit(1);
}

function fetchText(targetUrl, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error(`Too many redirects: ${targetUrl}`));
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch {
      return reject(new Error(`Invalid URL: ${targetUrl}`));
    }
    const isHttps = parsed.protocol === "https:";
    const client = isHttps ? https : http;
    const req = client.request(
      parsed,
      {
        method: "GET",
        headers: { "User-Agent": "real-estate-rag-scraper/1.0" },
        timeout: 20_000,
        family: 4,
        rejectUnauthorized: isHttps ? !config.scrape.allowInsecureTls : undefined,
      },
      (res) => {
        const status = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          const next = new URL(res.headers.location, parsed).toString();
          res.resume();
          fetchText(next, redirectCount + 1).then(resolve).catch(reject);
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          return reject(new Error(`HTTP ${status} for ${targetUrl}`));
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      }
    );
    req.on("timeout", () => req.destroy(new Error(`Timeout: ${targetUrl}`)));
    req.on("error", (err) => reject(new Error(`Request failed for ${targetUrl}: ${err.message}`)));
    req.end();
  });
}

async function collectUrls(sitemapUrl, parser, seen = new Set()) {
  if (!sitemapUrl || seen.has(sitemapUrl)) return [];
  seen.add(sitemapUrl);
  const xml = await fetchText(sitemapUrl);
  const parsed = parser.parse(xml);

  if (parsed?.urlset?.url) {
    const nodes = Array.isArray(parsed.urlset.url) ? parsed.urlset.url : [parsed.urlset.url];
    return nodes.map((n) => n?.loc).filter(Boolean);
  }
  if (parsed?.sitemapindex?.sitemap) {
    const sitemaps = Array.isArray(parsed.sitemapindex.sitemap)
      ? parsed.sitemapindex.sitemap
      : [parsed.sitemapindex.sitemap];
    const nested = await Promise.all(
      sitemaps.map((s) => collectUrls(s?.loc, parser, seen))
    );
    return nested.flat();
  }
  return [];
}

function toBase64Url(input) {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function scrapeWithRetry(app, url) {
  let attempt = 0;
  let lastError;
  while (attempt <= config.scrape.retryMax) {
    try {
      const result = await app.scrapeUrl(url, { formats: ["markdown"] });
      return result;
    } catch (err) {
      lastError = err;
      attempt += 1;
      if (attempt > config.scrape.retryMax) break;
      const backoff = Math.min(30_000, 2 ** attempt * 500 + Math.random() * 250);
      log.warn(
        { url, attempt, backoff, err: err.message },
        "scrape failed, retrying"
      );
      await sleep(backoff);
    }
  }
  throw lastError;
}

async function runWithConcurrency(items, worker, concurrency) {
  let cursor = 0;
  let inflight = 0;
  return new Promise((resolve, reject) => {
    const next = () => {
      if (cursor >= items.length && inflight === 0) return resolve();
      while (inflight < concurrency && cursor < items.length) {
        const idx = cursor++;
        inflight += 1;
        Promise.resolve()
          .then(() => worker(items[idx], idx))
          .catch(reject)
          .finally(() => {
            inflight -= 1;
            next();
          });
      }
    };
    next();
  });
}

async function main() {
  if (config.scrape.allowInsecureTls) {
    log.warn("ALLOW_INSECURE_SITEMAP_TLS=1, sitemap TLS validation disabled");
  }

  const parser = new XMLParser();
  const app = new FirecrawlApp({ apiKey: config.firecrawl.apiKey });

  log.info({ sitemap: config.scrape.sitemapUrl }, "collecting sitemap URLs");
  const urls = [...new Set(await collectUrls(config.scrape.sitemapUrl, parser))];
  log.info({ count: urls.length }, "URLs collected");

  const outFinal = config.paths.outputJsonl;
  const outDir = path.dirname(outFinal);
  await fsp.mkdir(outDir, { recursive: true });
  const outTmp = `${outFinal}.${process.pid}.tmp`;
  const writer = fs.createWriteStream(outTmp, { encoding: "utf8" });

  let ok = 0;
  let skipped = 0;
  let failed = 0;
  let processed = 0;

  const writeRecord = (record) =>
    new Promise((resolve, reject) => {
      writer.write(`${JSON.stringify(record)}\n`, (err) => (err ? reject(err) : resolve()));
    });

  const total = urls.length;
  await runWithConcurrency(
    urls,
    async (url) => {
      processed += 1;
      try {
        const result = await scrapeWithRetry(app, url);
        const markdown =
          result?.data?.markdown || result?.markdown || "";
        const metadata = result?.data?.metadata || result?.metadata || {};
        if (!String(markdown).trim()) {
          skipped += 1;
          log.debug({ url, processed, total }, "skip (empty)");
          return;
        }
        await writeRecord({
          id: toBase64Url(url),
          url,
          text: markdown,
          metadata,
        });
        ok += 1;
        log.info({ url, processed, total }, "scraped");
      } catch (err) {
        failed += 1;
        log.warn({ url, err: err.message }, "scrape failed permanently");
      }
    },
    config.scrape.concurrency
  );

  await new Promise((resolve, reject) => writer.end((err) => (err ? reject(err) : resolve())));
  await fsp.rename(outTmp, outFinal);

  log.info({ ok, skipped, failed, total: urls.length, output: outFinal }, "scrape complete");
}

main().catch((err) => {
  log.fatal({ err: err.message, stack: err.stack }, "scrape failed");
  process.exit(1);
});
