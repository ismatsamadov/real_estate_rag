const FirecrawlApp = require("@mendable/firecrawl-js").default;
const { XMLParser } = require("fast-xml-parser");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const { URL } = require("node:url");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const START_SITEMAP = "https://pasharealestate.az/sitemap.xml";
const ALLOW_INSECURE_SITEMAP_TLS = process.env.ALLOW_INSECURE_SITEMAP_TLS === "1";
const OUTPUT_JSONL = process.env.OUTPUT_JSONL || path.resolve(__dirname, "..", "data", "rag-ready.jsonl");

function requestText(targetUrl, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error(`Too many redirects for ${targetUrl}`));
      return;
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(targetUrl);
    } catch {
      reject(new Error(`Invalid URL: ${targetUrl}`));
      return;
    }

    const isHttps = parsedUrl.protocol === "https:";
    const client = isHttps ? https : http;
    const req = client.request(
      parsedUrl,
      {
        method: "GET",
        headers: { "User-Agent": "rag-export-script/1.0" },
        timeout: 20000,
        family: 4,
        rejectUnauthorized: isHttps ? !ALLOW_INSECURE_SITEMAP_TLS : undefined,
      },
      (res) => {
        const status = res.statusCode || 0;

        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          const next = new URL(res.headers.location, parsedUrl).toString();
          res.resume();
          requestText(next, redirectCount + 1).then(resolve).catch(reject);
          return;
        }

        if (status < 200 || status >= 300) {
          res.resume();
          reject(new Error(`Failed to fetch ${targetUrl}: HTTP ${status}`));
          return;
        }

        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error(`Timeout fetching ${targetUrl}`));
    });
    req.on("error", (err) => reject(new Error(`Request failed for ${targetUrl}: ${err.message}`)));
    req.end();
  });
}

async function fetchText(url) {
  try {
    return await requestText(url);
  } catch (err) {
    throw new Error(err.message);
  }
}

async function collectUrls(sitemapUrl, parser, seen = new Set()) {
  if (!sitemapUrl || seen.has(sitemapUrl)) return [];
  seen.add(sitemapUrl);

  const parsed = parser.parse(await fetchText(sitemapUrl));

  if (parsed && parsed.urlset && parsed.urlset.url) {
    const nodes = Array.isArray(parsed.urlset.url) ? parsed.urlset.url : [parsed.urlset.url];
    return nodes.map((node) => node && node.loc).filter(Boolean);
  }

  if (parsed && parsed.sitemapindex && parsed.sitemapindex.sitemap) {
    const sitemaps = Array.isArray(parsed.sitemapindex.sitemap)
      ? parsed.sitemapindex.sitemap
      : [parsed.sitemapindex.sitemap];
    const nested = await Promise.all(
      sitemaps.map((entry) => collectUrls(entry && entry.loc, parser, seen))
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

async function main() {
  if (!process.env.FIRECRAWL_API_KEY) {
    throw new Error("FIRECRAWL_API_KEY is not set in environment.");
  }
  if (ALLOW_INSECURE_SITEMAP_TLS) {
    console.log("Warning: ALLOW_INSECURE_SITEMAP_TLS=1, TLS cert validation is disabled for sitemap fetch.");
  }

  const parser = new XMLParser();
  const app = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });

  const uniqueUrls = [...new Set(await collectUrls(START_SITEMAP, parser))];
  console.log(`Found ${uniqueUrls.length} URLs in sitemap(s).`);

  const docs = [];
  for (const url of uniqueUrls) {
    try {
      const result = await app.scrapeUrl(url, { formats: ["markdown"] });
      const markdown =
        (result && result.data && result.data.markdown) ||
        (result && result.markdown) ||
        "";

      if (!String(markdown).trim()) {
        console.log(`SKIP (empty): ${url}`);
        continue;
      }

      const metadata =
        (result && result.data && result.data.metadata) ||
        (result && result.metadata) ||
        {};

      docs.push({
        id: toBase64Url(url),
        url,
        text: markdown,
        metadata,
      });
      console.log(`OK: ${url}`);
    } catch (err) {
      console.log(`SKIP (error): ${url} -> ${err.message}`);
    }
  }

  const outputFile = path.resolve(OUTPUT_JSONL);
  const outputDir = path.dirname(outputFile);
  const jsonl = docs.map((doc) => JSON.stringify(doc)).join("\n");
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(outputFile, jsonl, "utf8");
  console.log(`Saved ${outputFile} with ${docs.length} documents.`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
