#!/usr/bin/env node
"use strict";

/**
 * Offline evaluation harness.
 *
 *   - Retrieval recall@K: did any retrieved chunk contain a `must_match`
 *     keyword for the question?
 *   - Citation rate: did the generated answer include at least one [Sn]
 *     citation marker? (A weak proxy for groundedness; a stricter check
 *     would verify per-claim.)
 *   - Faithfulness lite: every cited Sn must be in the retrieved set.
 *
 * Prints a per-question table and aggregate metrics.
 */

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const { ask } = require("../src/rag");
const db = require("../src/db");

const EVAL_PATH = path.resolve(__dirname, "..", "eval", "eval-set.jsonl");

async function readEvalSet() {
  const stream = fs.createReadStream(EVAL_PATH, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const items = [];
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    items.push(JSON.parse(trimmed));
  }
  return items;
}

function recallAtK(sources, mustMatch) {
  if (!mustMatch?.length) return null;
  const haystack = sources
    .map((s) => `${s.metadata?.title || ""}\n${s.url || ""}\n${s.content}`)
    .join("\n")
    .toLowerCase();
  return mustMatch.some((needle) => haystack.includes(String(needle).toLowerCase()));
}

function citationStats(answer, sources) {
  const ids = new Set(sources.map((s) => s.sid));
  const found = new Set();
  const re = /\[(S\d+)\]/g;
  let match;
  while ((match = re.exec(answer)) !== null) found.add(match[1]);
  const cited = [...found];
  const valid = cited.filter((c) => ids.has(c));
  const invalid = cited.filter((c) => !ids.has(c));
  return {
    hasCitations: cited.length > 0,
    valid,
    invalid,
  };
}

function pad(s, n) {
  const str = String(s);
  return str.length >= n ? str.slice(0, n) : str + " ".repeat(n - str.length);
}

async function main() {
  const items = await readEvalSet();
  console.log(`Running eval over ${items.length} questions...\n`);

  let recallHits = 0;
  let recallTotal = 0;
  let citationHits = 0;
  let invalidCitations = 0;
  let totalLatency = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  console.log(
    `${pad("#", 3)} ${pad("recall", 7)} ${pad("cited", 6)} ${pad("invalid", 8)} ${pad("ms", 6)} question`
  );
  console.log("-".repeat(80));

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const t0 = Date.now();
    const result = await ask(item.question);
    const ms = Date.now() - t0;
    totalLatency += ms;
    if (result.usage) {
      totalInputTokens += result.usage.input_tokens || 0;
      totalOutputTokens += result.usage.output_tokens || 0;
    }

    const recall = recallAtK(result.sources, item.must_match);
    if (recall !== null) {
      recallTotal += 1;
      if (recall) recallHits += 1;
    }

    const cite = citationStats(result.answer, result.sources);
    if (cite.hasCitations) citationHits += 1;
    invalidCitations += cite.invalid.length;

    console.log(
      `${pad(i + 1, 3)} ${pad(recall === null ? "n/a" : recall ? "PASS" : "FAIL", 7)} ${pad(cite.hasCitations ? "yes" : "no", 6)} ${pad(cite.invalid.length, 8)} ${pad(ms, 6)} ${item.question}`
    );
  }

  console.log("\nAGGREGATE");
  console.log("---------");
  if (recallTotal) {
    console.log(`Retrieval recall:   ${recallHits}/${recallTotal} (${((recallHits / recallTotal) * 100).toFixed(1)}%)`);
  }
  console.log(`Citation rate:      ${citationHits}/${items.length} (${((citationHits / items.length) * 100).toFixed(1)}%)`);
  console.log(`Invalid citations:  ${invalidCitations}`);
  console.log(`Avg latency:        ${(totalLatency / items.length).toFixed(0)} ms`);
  console.log(`Total tokens:       in=${totalInputTokens} out=${totalOutputTokens}`);
}

main()
  .catch((err) => {
    console.error(err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.close();
  });
