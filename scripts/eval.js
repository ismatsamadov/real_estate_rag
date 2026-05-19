#!/usr/bin/env node
"use strict";

/**
 * Honest evaluation harness.
 *
 *   - Deterministic checks:
 *       retrieval_recall   keyword from must_match found in any retrieved chunk
 *       citation_validity  every [Sn] marker maps to a retrieved source
 *
 *   - LLM-as-judge (Claude Sonnet) scores three dimensions per question:
 *       faithfulness     (0-5)  every claim supported by the cited sources
 *       relevance        (0-5)  answer addresses the question
 *       language_match   (bool) answer is in the question's language (or
 *                              correctly mixes when the corpus is partly EN)
 *
 *   - Refusal check: questions tagged `no_match_expected` MUST decline rather
 *     than hallucinate. The judge is told this category exists.
 *
 *   - Output: aggregate metrics, per-question table, and an explicit FAILURE
 *     list with the judge's verbatim reason. No averaging-away of failures.
 *     We'd rather see "20/25 faithful, here are the 5 that drifted" than a
 *     soothing 80%.
 *
 * Writes eval/results-<timestamp>.{json,md} alongside stdout output.
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline");

const config = require("../src/config");
const { ask } = require("../src/rag");
const { complete } = require("../src/llm");
const db = require("../src/db");
const logger = require("../src/logger");

const log = logger.child({ component: "eval" });

const EVAL_PATH = path.resolve(__dirname, "..", "eval", "eval-set.jsonl");
const PASS_THRESHOLD = 4; // out of 5

// ---------------------------------------------------------------------------
// Deterministic checks
// ---------------------------------------------------------------------------

function retrievalRecall(sources, mustMatch) {
  if (!mustMatch?.length) return null;
  const haystack = sources
    .map((s) => `${s.metadata?.title || ""}\n${s.url || ""}\n${s.content || ""}`)
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
  return { count: cited.length, valid, invalid };
}

function looksLikeRefusal(answer) {
  const a = (answer || "").toLowerCase();
  const signals = [
    "could not find",
    "couldn't find",
    "no relevant",
    "not in the sources",
    "not mentioned",
    "does not mention",
    "do not have",
    "don't have",
    "no information",
    "insufficient",
    "not available in",
    "not in the provided",
    "not listed",
  ];
  return signals.some((s) => a.includes(s));
}

// ---------------------------------------------------------------------------
// LLM-as-judge
// ---------------------------------------------------------------------------

const JUDGE_SYSTEM = [
  "You are a strict, skeptical evaluator of a retrieval-augmented QA system over real-estate content.",
  "Your job is to assign honest scores. Do NOT round up to be encouraging. A correct, well-grounded answer scores 5; a hallucination scores 0–1.",
  "Always return STRICT JSON matching this schema:",
  "{",
  '  "faithfulness": number 0-5,         // every claim must be supported by at least one cited source',
  '  "faithfulness_reason": string,      // 1-2 sentences citing specific drift if any',
  '  "relevance": number 0-5,            // did the answer actually address the question',
  '  "relevance_reason": string,',
  '  "language_match": boolean,          // did the answer language match the question language',
  '  "language_match_reason": string,',
  '  "refusal_correct": boolean | null   // null if not applicable; for no_match_expected: true iff the system declined; for other categories: true iff it did NOT incorrectly refuse',
  "}",
  "Only output the JSON object. No prose.",
].join("\n");

function buildJudgeUser({ question, language, category, answer, sources, shouldNotInvent }) {
  const srcBlock = sources
    .map((s) => `[${s.sid}] type=${s.metadata?.doc_type || "?"} lang=${s.metadata?.language || "?"} url=${s.url}\n${(s.content || "").slice(0, 1200)}`)
    .join("\n---\n");
  return [
    `Question (${language}): ${question}`,
    `Category: ${category}`,
    shouldNotInvent ? `Specific risk: ${shouldNotInvent}` : "",
    "",
    "Answer to evaluate:",
    answer || "(empty)",
    "",
    "Sources the system retrieved:",
    srcBlock || "(none)",
  ]
    .filter(Boolean)
    .join("\n");
}

function safeJsonExtract(text) {
  if (!text) return null;
  // Strip code fences if present.
  const cleaned = text.replace(/^```(?:json)?\s*/m, "").replace(/\s*```$/m, "").trim();
  // Find first { ... } block.
  const start = cleaned.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < cleaned.length; i += 1) {
    if (cleaned[i] === "{") depth += 1;
    else if (cleaned[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(cleaned.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

async function judge(item, result) {
  const userText = buildJudgeUser({
    question: item.question,
    language: item.language || "en",
    category: item.category || "general",
    answer: result.answer,
    sources: result.sources,
    shouldNotInvent: item.should_not_invent,
  });
  const { text } = await complete({
    system: [{ type: "text", text: JUDGE_SYSTEM }],
    messages: [{ role: "user", content: userText }],
    maxTokens: 600,
    temperature: 0,
  });
  const parsed = safeJsonExtract(text);
  if (!parsed) {
    return {
      faithfulness: null,
      relevance: null,
      language_match: null,
      refusal_correct: null,
      raw: text,
      error: "judge_parse_failed",
    };
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function pct(n, d) {
  return d ? `${((n / d) * 100).toFixed(1)}%` : "n/a";
}

function summarize(rows) {
  const out = {
    total: rows.length,
    byLang: {},
    byCategory: {},
    retrievalRecall: { hits: 0, total: 0 },
    citationsPresent: 0,
    invalidCitations: 0,
    faithfulnessPass: 0,
    faithfulnessTotal: 0,
    relevancePass: 0,
    relevanceTotal: 0,
    languageMatch: 0,
    refusalCorrect: 0,
    refusalApplicable: 0,
    avgLatencyMs: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    failures: [],
  };
  let totalMs = 0;
  for (const r of rows) {
    out.byLang[r.language] = (out.byLang[r.language] || 0) + 1;
    out.byCategory[r.category] = (out.byCategory[r.category] || 0) + 1;
    if (r.recall !== null) {
      out.retrievalRecall.total += 1;
      if (r.recall) out.retrievalRecall.hits += 1;
    }
    if (r.citations.count > 0) out.citationsPresent += 1;
    out.invalidCitations += r.citations.invalid.length;
    if (r.judge?.faithfulness != null) {
      out.faithfulnessTotal += 1;
      if (r.judge.faithfulness >= PASS_THRESHOLD) out.faithfulnessPass += 1;
    }
    if (r.judge?.relevance != null) {
      out.relevanceTotal += 1;
      if (r.judge.relevance >= PASS_THRESHOLD) out.relevancePass += 1;
    }
    if (r.judge?.language_match) out.languageMatch += 1;
    if (r.judge?.refusal_correct != null) {
      out.refusalApplicable += 1;
      if (r.judge.refusal_correct) out.refusalCorrect += 1;
    }
    totalMs += r.ms;
    out.totalInputTokens += r.usage?.input_tokens || 0;
    out.totalOutputTokens += r.usage?.output_tokens || 0;
    if (r.failed) out.failures.push(r);
  }
  out.avgLatencyMs = rows.length ? Math.round(totalMs / rows.length) : 0;
  return out;
}

function renderMarkdown(summary, rows, meta) {
  const lines = [];
  lines.push("# Eval results");
  lines.push("");
  lines.push(`Generated: ${meta.startedAt}`);
  lines.push(`Model: ${meta.model}  •  Embedder: ${meta.embedModel}  •  Reranker: ${meta.rerankModel}`);
  lines.push(`Retrieval: mode=${meta.mode} topK=${meta.topK} candidateK=${meta.candidateK} rerank=${meta.rerank}`);
  lines.push("");
  lines.push("## Aggregate");
  lines.push("");
  lines.push(`| Metric | Result |`);
  lines.push(`|---|---|`);
  lines.push(`| Questions | ${summary.total} |`);
  lines.push(`| Retrieval recall | ${summary.retrievalRecall.hits}/${summary.retrievalRecall.total} (${pct(summary.retrievalRecall.hits, summary.retrievalRecall.total)}) |`);
  lines.push(`| Faithfulness ≥ ${PASS_THRESHOLD}/5 | ${summary.faithfulnessPass}/${summary.faithfulnessTotal} (${pct(summary.faithfulnessPass, summary.faithfulnessTotal)}) |`);
  lines.push(`| Relevance ≥ ${PASS_THRESHOLD}/5 | ${summary.relevancePass}/${summary.relevanceTotal} (${pct(summary.relevancePass, summary.relevanceTotal)}) |`);
  lines.push(`| Language match | ${summary.languageMatch}/${summary.total} (${pct(summary.languageMatch, summary.total)}) |`);
  lines.push(`| Refusal correct (where applicable) | ${summary.refusalCorrect}/${summary.refusalApplicable} (${pct(summary.refusalCorrect, summary.refusalApplicable)}) |`);
  lines.push(`| Citation present | ${summary.citationsPresent}/${summary.total} (${pct(summary.citationsPresent, summary.total)}) |`);
  lines.push(`| Invalid citations | ${summary.invalidCitations} |`);
  lines.push(`| Avg latency | ${summary.avgLatencyMs} ms |`);
  lines.push(`| Total tokens | in=${summary.totalInputTokens} out=${summary.totalOutputTokens} |`);
  lines.push("");
  lines.push("## By language");
  lines.push("");
  for (const [k, v] of Object.entries(summary.byLang)) lines.push(`- ${k.toUpperCase()}: ${v}`);
  lines.push("");
  lines.push("## By category");
  lines.push("");
  for (const [k, v] of Object.entries(summary.byCategory)) lines.push(`- ${k}: ${v}`);
  lines.push("");
  if (summary.failures.length) {
    lines.push("## Failures");
    lines.push("");
    for (const f of summary.failures) {
      lines.push(`### [${f.idx}] ${f.language.toUpperCase()} / ${f.category} — ${f.question}`);
      lines.push("");
      const j = f.judge || {};
      if (j.faithfulness != null) lines.push(`- **Faithfulness ${j.faithfulness}/5** — ${j.faithfulness_reason || ""}`);
      if (j.relevance != null) lines.push(`- **Relevance ${j.relevance}/5** — ${j.relevance_reason || ""}`);
      if (j.language_match === false) lines.push(`- **Language mismatch** — ${j.language_match_reason || ""}`);
      if (j.refusal_correct === false) lines.push(`- **Refusal incorrect** — should have declined`);
      if (f.citations.invalid.length) lines.push(`- **Invalid citations**: ${f.citations.invalid.join(", ")}`);
      if (f.recall === false) lines.push(`- **Retrieval miss**: no must_match keyword in retrieved chunks`);
      lines.push("");
      lines.push("Answer:");
      lines.push("```");
      lines.push(f.answer || "(empty)");
      lines.push("```");
      lines.push("");
    }
  } else {
    lines.push("## Failures");
    lines.push("");
    lines.push("None.");
  }
  lines.push("");
  lines.push("## Per-question scores");
  lines.push("");
  lines.push(`| # | lang | category | recall | faith | rel | lang | refuse | cite | ms |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|---|`);
  for (const r of rows) {
    const j = r.judge || {};
    lines.push(
      `| ${r.idx} | ${r.language} | ${r.category} | ${r.recall === null ? "n/a" : r.recall ? "✓" : "✗"} | ${j.faithfulness ?? "?"} | ${j.relevance ?? "?"} | ${j.language_match ? "✓" : j.language_match === false ? "✗" : "?"} | ${j.refusal_correct == null ? "n/a" : j.refusal_correct ? "✓" : "✗"} | ${r.citations.count}/${r.citations.invalid.length || 0} | ${r.ms} |`,
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

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

async function main() {
  const items = await readEvalSet();
  const startedAt = new Date().toISOString();

  log.info({ total: items.length, model: config.anthropic.defaultModel }, "starting eval");

  const rows = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const idx = i + 1;
    const t0 = Date.now();
    let result;
    try {
      result = await ask(item.question);
    } catch (err) {
      log.error({ err: err.message, idx }, "ask failed");
      rows.push({
        idx,
        question: item.question,
        language: item.language || "en",
        category: item.category || "general",
        answer: null,
        sources: [],
        recall: null,
        citations: { count: 0, valid: [], invalid: [] },
        ms: Date.now() - t0,
        usage: null,
        judge: null,
        failed: true,
        error: err.message,
      });
      continue;
    }
    const ms = Date.now() - t0;
    const recall = retrievalRecall(result.sources, item.must_match);
    const citations = citationStats(result.answer, result.sources);

    let judgeResult = null;
    try {
      judgeResult = await judge(item, result);
    } catch (err) {
      log.warn({ err: err.message, idx }, "judge failed");
    }

    const failed =
      (recall === false) ||
      citations.invalid.length > 0 ||
      (judgeResult?.faithfulness != null && judgeResult.faithfulness < PASS_THRESHOLD) ||
      (judgeResult?.relevance != null && judgeResult.relevance < PASS_THRESHOLD) ||
      (judgeResult?.refusal_correct === false);

    const row = {
      idx,
      question: item.question,
      language: item.language || "en",
      category: item.category || "general",
      answer: result.answer,
      sources: result.sources,
      recall,
      citations,
      ms,
      usage: result.usage,
      judge: judgeResult,
      failed,
    };
    rows.push(row);

    // Compact stdout line per question.
    const j = judgeResult || {};
    process.stdout.write(
      `[${String(idx).padStart(2, "0")}] ${row.language} ${row.category.padEnd(20)} ` +
        `recall=${recall === null ? "-" : recall ? "✓" : "✗"} ` +
        `faith=${j.faithfulness ?? "?"} rel=${j.relevance ?? "?"} ` +
        `lang=${j.language_match ? "✓" : j.language_match === false ? "✗" : "?"} ` +
        `refuse=${j.refusal_correct == null ? "-" : j.refusal_correct ? "✓" : "✗"} ` +
        `cite=${citations.count}/${citations.invalid.length} ` +
        `${ms}ms ` +
        `${failed ? "❌" : "✓"}  ` +
        `${item.question.slice(0, 70)}\n`,
    );
  }

  const summary = summarize(rows);
  const meta = {
    startedAt,
    model: config.anthropic.defaultModel,
    embedModel: config.embedding.model,
    rerankModel: config.voyage.rerankModel,
    mode: config.retrieval.mode,
    topK: config.retrieval.topK,
    candidateK: config.retrieval.candidateK,
    rerank: config.retrieval.rerank,
  };

  // Write report files
  const stamp = startedAt.replace(/[:.]/g, "-");
  const outJson = path.resolve(__dirname, "..", "eval", `results-${stamp}.json`);
  const outMd = path.resolve(__dirname, "..", "eval", `results-${stamp}.md`);
  await fsp.writeFile(outJson, JSON.stringify({ meta, summary, rows }, null, 2));
  await fsp.writeFile(outMd, renderMarkdown(summary, rows, meta));

  // Print aggregate
  console.log("\nAGGREGATE");
  console.log("---------");
  console.log(`Questions:            ${summary.total}`);
  if (summary.retrievalRecall.total) {
    console.log(`Retrieval recall:     ${summary.retrievalRecall.hits}/${summary.retrievalRecall.total} (${pct(summary.retrievalRecall.hits, summary.retrievalRecall.total)})`);
  }
  console.log(`Faithfulness ≥ ${PASS_THRESHOLD}/5:    ${summary.faithfulnessPass}/${summary.faithfulnessTotal} (${pct(summary.faithfulnessPass, summary.faithfulnessTotal)})`);
  console.log(`Relevance ≥ ${PASS_THRESHOLD}/5:       ${summary.relevancePass}/${summary.relevanceTotal} (${pct(summary.relevancePass, summary.relevanceTotal)})`);
  console.log(`Language match:       ${summary.languageMatch}/${summary.total} (${pct(summary.languageMatch, summary.total)})`);
  console.log(`Refusal correct:      ${summary.refusalCorrect}/${summary.refusalApplicable} (${pct(summary.refusalCorrect, summary.refusalApplicable)})`);
  console.log(`Citation present:     ${summary.citationsPresent}/${summary.total}`);
  console.log(`Invalid citations:    ${summary.invalidCitations}`);
  console.log(`Avg latency:          ${summary.avgLatencyMs} ms`);
  console.log(`Tokens:               in=${summary.totalInputTokens} out=${summary.totalOutputTokens}`);
  console.log(`Failures listed:      ${summary.failures.length}`);
  console.log(`\nReport written to:`);
  console.log(`  ${outMd}`);
  console.log(`  ${outJson}`);
}

main()
  .catch((err) => {
    console.error(err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.close();
  });
