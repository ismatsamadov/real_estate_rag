const { askQuestion, close } = require("..\\app\\rag-core");

const question = process.argv.slice(2).join(" ").trim();
if (!question) {
  console.error('Usage: npm run ask-rag -- "Your question here"');
  process.exit(1);
}

askQuestion(question)
  .then((result) => {
    console.log("ANSWER");
    console.log("------");
    console.log(result.answer);
    console.log("");
    console.log("TRACEABLE SOURCES");
    console.log("-----------------");
    result.sources.forEach((s) => {
      const meta = s.metadata && typeof s.metadata === "object" ? s.metadata : {};
      console.log(
        `${s.sid} | score=${s.score.toFixed(4)} | url=${s.url} | doc_id=${s.doc_id} | chunk_index=${s.chunk_index}`
      );
      console.log(`meta: title=${meta.title || "n/a"} | type=${meta.pageKind || "n/a"} | lang=${meta.language || "n/a"}`);
      console.log(`snippet: ${s.snippet}`);
      console.log("");
    });
  })
  .catch((err) => {
    console.error(err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await close();
  });
