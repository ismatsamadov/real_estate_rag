#!/usr/bin/env node
"use strict";

/**
 * CLI ask: streams the answer to stdout while it's being generated, then
 * prints traceable sources.
 *
 *   npm run ask -- "Question text"
 *   npm run ask -- --top-k 12 "Question text"
 *   npm run ask -- --mode lexical "Question text"
 */

const { askStream } = require("../src/rag");
const db = require("../src/db");

function parseArgs(argv) {
  const out = { topK: undefined, mode: undefined, question: "" };
  const tokens = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--top-k" || arg === "-k") {
      out.topK = Number(argv[++i]);
    } else if (arg === "--mode") {
      out.mode = argv[++i];
    } else {
      tokens.push(arg);
    }
  }
  out.question = tokens.join(" ").trim();
  return out;
}

async function main() {
  const { topK, mode, question } = parseArgs(process.argv.slice(2));
  if (!question) {
    console.error('Usage: npm run ask -- [--top-k N] [--mode hybrid|vector|lexical] "Your question"');
    process.exit(1);
  }

  let sources = [];
  let model = null;
  let usage = null;
  let mode_ = null;

  process.stdout.write("ANSWER\n------\n");

  for await (const event of askStream(question, { topK, mode })) {
    if (event.type === "sources") {
      sources = event.sources;
      mode_ = event.mode;
    } else if (event.type === "model") {
      model = event.model;
    } else if (event.type === "delta") {
      process.stdout.write(event.text);
    } else if (event.type === "usage") {
      usage = event.usage;
    } else if (event.type === "done") {
      process.stdout.write("\n");
    } else if (event.type === "error") {
      console.error(`\nERROR: ${event.error}`);
      process.exitCode = 1;
      return;
    }
  }

  console.log("\nTRACEABLE SOURCES");
  console.log("-----------------");
  for (const s of sources) {
    const meta = s.metadata || {};
    console.log(
      `${s.sid} | rrf=${(s.score || 0).toFixed(4)} | vec=${(s.vector_score || 0).toFixed(4)} | lex=${(s.lexical_score || 0).toFixed(4)}`
    );
    console.log(`     url=${s.url}`);
    console.log(`     title=${meta.title || "n/a"} | type=${meta.pageKind || "n/a"} | lang=${meta.language || "n/a"}`);
    console.log(`     doc_id=${s.doc_id} chunk=${s.chunk_index}`);
    console.log(`     ${s.snippet}`);
    console.log("");
  }

  if (model || usage || mode_) {
    console.log(
      `META | model=${model || "n/a"} | mode=${mode_ || "n/a"} | usage=${
        usage ? `in=${usage.input_tokens} out=${usage.output_tokens} cache_read=${usage.cache_read_input_tokens || 0} cache_write=${usage.cache_creation_input_tokens || 0}` : "n/a"
      }`
    );
  }
}

main()
  .catch((err) => {
    console.error(err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.close();
  });
