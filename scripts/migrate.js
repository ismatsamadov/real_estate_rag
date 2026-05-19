#!/usr/bin/env node
"use strict";

/**
 * Schema migration + connectivity check.
 *
 *   npm run migrate            # idempotent: creates tables/indexes if missing
 *   npm run migrate -- --drop  # destructive: drops + recreates (re-ingest required)
 *
 * Also verifies Voyage AI embedding + rerank endpoints work end-to-end.
 */

const { VoyageAIClient } = require("voyageai");
const config = require("../src/config");
const logger = require("../src/logger");
const db = require("../src/db");

const log = logger.child({ component: "migrate" });

async function checkVoyage() {
  const client = new VoyageAIClient({ apiKey: config.voyage.apiKey });

  log.info({ model: config.voyage.embedModel }, "voyage embed check");
  const embed = await client.embed({
    input: ["Real estate in Baku", "Apartment for sale in Yasamal"],
    model: config.voyage.embedModel,
    inputType: "document",
  });
  const dim = embed?.data?.[0]?.embedding?.length;
  if (!dim) throw new Error("Voyage embed returned no vectors");
  if (dim !== config.embedding.dim) {
    throw new Error(
      `Voyage returned ${dim}-d vectors but VECTOR_DIM=${config.embedding.dim}. ` +
        `Update VECTOR_DIM in .env to match the model output.`,
    );
  }
  log.info({ dim, model: embed.model, usage: embed.usage }, "embed OK");

  log.info({ model: config.voyage.rerankModel }, "voyage rerank check");
  const rerank = await client.rerank({
    query: "apartment for sale",
    documents: [
      "A 3-bedroom apartment in central Baku, 95 sqm, sale.",
      "A guide to property taxes in Azerbaijan.",
      "Office space rental on Nizami street.",
    ],
    model: config.voyage.rerankModel,
    topK: 2,
  });
  const ranked = rerank?.data || [];
  if (ranked.length === 0) throw new Error("Voyage rerank returned no results");
  log.info(
    {
      model: rerank.model,
      results: ranked.map((r) => ({
        index: r.index,
        score: r.relevanceScore?.toFixed?.(3) ?? r.relevance_score,
      })),
      usage: rerank.usage,
    },
    "rerank OK",
  );
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const drop = args.has("--drop");

  log.info({ host: maskUrl(config.db.url) }, "postgres ping");
  const ok = await db.ping();
  if (!ok) throw new Error("Postgres ping failed");

  if (drop) {
    log.warn("--drop flag set: dropping existing tables");
    await db.dropSchema();
  }

  await db.ensureSchema();
  await checkVoyage();

  log.info("migration complete");
  await db.close();
}

function maskUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.username ? "***@" : ""}${u.hostname}${u.pathname}`;
  } catch {
    return "<invalid-url>";
  }
}

main().catch((err) => {
  log.error({ err: err.message, stack: err.stack }, "migration failed");
  process.exit(1);
});
