const express = require("express");
const path = require("node:path");
const { askQuestion, close } = require("./rag-core");

const PORT = Number(process.env.PORT || 8787);
const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "..", "web")));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/ask", async (req, res) => {
  const question = String(req.body?.question || "").trim();
  const topK = Number(req.body?.topK || 8);

  if (!question) {
    res.status(400).json({ error: "Question is required." });
    return;
  }

  if (question.length > 4000) {
    res.status(400).json({ error: "Question is too long (max 4000 chars)." });
    return;
  }

  try {
    const result = await askQuestion(question, { topK });
    res.json({
      ok: true,
      ...result,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message || "Internal error.",
    });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "web", "index.html"));
});

const server = app.listen(PORT, () => {
  console.log(`RAG UI running at http://localhost:${PORT}`);
});

async function shutdown() {
  server.close(async () => {
    await close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
