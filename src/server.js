"use strict";

const path = require("node:path");
const express = require("express");
const helmet = require("helmet");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const { z } = require("zod");

const config = require("./config");
const logger = require("./logger");
const db = require("./db");
const { ask, askStream } = require("./rag");
const { warmup } = require("./embedder");
const { resolveModelOrder } = require("./llm");

const log = logger.child({ component: "server" });

const askSchema = z.object({
  question: z.string().min(1, "question is required").max(4000, "question too long"),
  topK: z.coerce.number().int().min(1).max(20).optional(),
  mode: z.enum(["hybrid", "vector", "lexical"]).optional(),
});

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

// Helmet with a CSP that allows our inline-free static assets.
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'"],
        "style-src": ["'self'", "https:"],
        "img-src": ["'self'", "data:", "https:"],
        "connect-src": ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);
app.use(compression());
app.use(express.json({ limit: "256kb" }));

// Static assets.
app.use(express.static(path.join(__dirname, "..", "web"), { extensions: ["html"] }));
app.use("/public", express.static(path.join(__dirname, "..", "public")));

// Lightweight request logger.
app.use((req, _res, next) => {
  log.debug({ method: req.method, path: req.path }, "request");
  next();
});

// API rate limiter — applies only to /api/ask*. Cheap reads (health) bypass.
const askLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many requests. Try again shortly." },
});

// --- Routes -----------------------------------------------------------------

app.get("/api/health", async (_req, res) => {
  let dbOk = false;
  try {
    dbOk = await db.ping();
  } catch (err) {
    log.warn({ err: err.message }, "db ping failed");
  }
  res.json({
    ok: dbOk,
    service: "real-estate-rag",
    table: config.db.table,
    embedding: { model: config.embedding.model, dim: config.embedding.dim },
    retrieval: { mode: config.retrieval.mode, topK: config.retrieval.topK },
  });
});

app.post("/api/ask", askLimiter, async (req, res) => {
  const parsed = askSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      error: parsed.error.issues.map((i) => i.message).join("; "),
    });
  }
  try {
    const result = await ask(parsed.data.question, {
      topK: parsed.data.topK,
      mode: parsed.data.mode,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    log.error({ err: err.message }, "ask failed");
    res.status(500).json({ ok: false, error: err.message || "Internal error." });
  }
});

app.post("/api/ask/stream", askLimiter, async (req, res) => {
  const parsed = askSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      error: parsed.error.issues.map((i) => i.message).join("; "),
    });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const send = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // Heartbeat every 15s so proxies don't kill an idle stream.
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);

  let clientGone = false;
  req.on("close", () => {
    clientGone = true;
  });

  try {
    for await (const event of askStream(parsed.data.question, {
      topK: parsed.data.topK,
      mode: parsed.data.mode,
    })) {
      if (clientGone) break;
      send(event);
    }
    if (!clientGone) send({ type: "end" });
  } catch (err) {
    log.error({ err: err.message }, "stream failed");
    send({ type: "error", error: err.message || "Internal error." });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

// SPA-style fallback for the single-page UI. Anything not matching a static
// asset or API route returns the index.
app.get(/^(?!\/api\/).*/, (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "web", "index.html"));
});

// --- Errors -----------------------------------------------------------------

app.use((err, _req, res, _next) => {
  log.error({ err: err.message, stack: err.stack }, "unhandled error");
  res.status(500).json({ ok: false, error: "Internal error." });
});

// --- Lifecycle --------------------------------------------------------------

const server = app.listen(config.port, () => {
  log.info({ port: config.port, env: config.env }, "server listening");
});

// Warm up heavy singletons in the background so the first user request is fast.
Promise.all([warmup().catch((e) => log.warn({ err: e.message }, "embedder warmup failed")), resolveModelOrder().catch(() => {})])
  .then(() => log.info("warmup complete"))
  .catch(() => {});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "shutting down");
  server.close(async () => {
    try {
      await db.close();
    } catch (err) {
      log.warn({ err: err.message }, "db close failed");
    }
    process.exit(0);
  });
  // Hard exit if cleanup hangs.
  setTimeout(() => {
    log.warn("forced exit after 10s");
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (err) => {
  log.error({ err: err?.message || err }, "unhandled rejection");
});
