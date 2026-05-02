"use strict";

const $ = (id) => document.getElementById(id);

const questionEl = $("question");
const topKEl = $("topK");
const topKValueEl = $("topKValue");
const modeEl = $("mode");
const askBtn = $("askBtn");
const copyBtn = $("copyBtn");
const statusEl = $("status");
const answerEl = $("answer");
const sourcesEl = $("sources");
const metaEl = $("meta");

let currentAnswer = "";
let currentSources = [];
let activeController = null;

// --- helpers ---------------------------------------------------------------

function setStatus(text, type = "") {
  statusEl.textContent = text;
  statusEl.className = `status ${type}`.trim();
}

function setMeta(text) {
  metaEl.textContent = text;
}

function escapeHtml(input) {
  return String(input)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function normalizeUrl(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  try {
    return new URL(value).toString();
  } catch {
    return value;
  }
}

function sourceDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function compactDocId(docId, max = 28) {
  const clean = String(docId || "").trim();
  if (!clean) return "n/a";
  if (clean.length <= max) return clean;
  const tail = Math.max(6, Math.floor((max - 3) / 2));
  const head = Math.max(6, max - 3 - tail);
  return `${clean.slice(0, head)}...${clean.slice(-tail)}`;
}

function prettyTag(value, fallback = "unknown") {
  const clean = String(value || "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return fallback;
  return clean.length <= 22 ? clean : `${clean.slice(0, 22)}...`;
}

function snippetClean(text) {
  return String(text || "")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

// --- markdown-lite renderer for streamed answers ---------------------------

function formatInline(line) {
  return escapeHtml(line)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, "<code>$1</code>")
    .replace(
      /\[(S\d+)\]/g,
      '<button class="citation" type="button" data-sid="$1" aria-label="Jump to source $1">[$1]</button>'
    );
}

function renderAnswer(text) {
  const lines = String(text || "")
    .replace(/\r\n/g, "\n")
    .split("\n");
  let html = "";
  let listType = null;
  const closeList = () => {
    if (listType) {
      html += listType === "ol" ? "</ol>" : "</ul>";
      listType = null;
    }
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      closeList();
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      closeList();
      html += `<h3 class="answer-heading">${formatInline(heading[2])}</h3>`;
      continue;
    }
    const ordered = line.match(/^(\d+)\.\s+(.+)$/);
    if (ordered) {
      if (listType !== "ol") {
        closeList();
        html += '<ol class="answer-list">';
        listType = "ol";
      }
      html += `<li>${formatInline(ordered[2])}</li>`;
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      if (listType !== "ul") {
        closeList();
        html += '<ul class="answer-list">';
        listType = "ul";
      }
      html += `<li>${formatInline(bullet[1])}</li>`;
      continue;
    }
    closeList();
    html += `<p>${formatInline(line)}</p>`;
  }
  closeList();
  answerEl.innerHTML = html || '<p class="placeholder">Ready.</p>';
}

// --- sources rendering -----------------------------------------------------

function renderSources(sources) {
  if (!Array.isArray(sources) || !sources.length) {
    sourcesEl.innerHTML = '<p class="source-meta">No sources returned.</p>';
    return;
  }
  sourcesEl.innerHTML = sources
    .map((s) => {
      const url = normalizeUrl(s.url);
      const docId = String(s.doc_id || "").trim();
      const compactedDoc = compactDocId(docId);
      const meta = s.metadata && typeof s.metadata === "object" ? s.metadata : {};
      const title = String(meta.title || "").trim() || "Untitled source";
      const pageKind = prettyTag(meta.pageKind, "unknown");
      const language = prettyTag(meta.language, "n/a");
      const domain = sourceDomain(url);
      const sid = String(s.sid || "S?");
      const snippet = snippetClean(s.snippet || s.content || "").slice(0, 320);
      const rrf = (Number(s.score) || 0).toFixed(4);
      const vec = (Number(s.vector_score) || 0).toFixed(4);
      const lex = (Number(s.lexical_score) || 0).toFixed(4);
      const pct = Math.max(
        0,
        Math.min(100, (Number(s.vector_score) || Number(s.score) || 0) * 100)
      ).toFixed(1);

      return `
        <article class="source-card" id="src-${escapeHtml(sid)}">
          <header class="source-head">
            <span class="sid">${escapeHtml(sid)}</span>
            <span class="badge score-badge" title="Reciprocal Rank Fusion score">rrf ${rrf}</span>
          </header>
          <h3 class="source-title">${escapeHtml(title)}</h3>
          <div class="source-meta-row">
            <span class="badge badge-muted">type ${escapeHtml(pageKind)}</span>
            <span class="badge badge-muted">lang ${escapeHtml(language)}</span>
            ${domain ? `<span class="badge badge-muted">${escapeHtml(domain)}</span>` : ""}
            <span class="badge badge-muted">vec ${vec}</span>
            <span class="badge badge-muted">lex ${lex}</span>
          </div>
          <div class="source-meta-row">
            <span class="badge badge-muted doc-badge" title="${escapeHtml(docId)}">doc ${escapeHtml(compactedDoc)}</span>
            <span class="badge badge-muted">chunk ${escapeHtml(String(s.chunk_index ?? "n/a"))}</span>
          </div>
          <div class="score-track" aria-hidden="true">
            <span class="score-bar" style="width:${pct}%"></span>
          </div>
          ${
            url
              ? `<a class="source-url" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(url)}</a>`
              : '<span class="source-url-fallback">No source URL</span>'
          }
          <p class="source-snippet">${escapeHtml(snippet)}</p>
        </article>`;
    })
    .join("");
}

function focusSource(sid) {
  const target = document.getElementById(`src-${sid}`);
  if (!target) return;
  document.querySelectorAll(".source-card.flash").forEach((el) => el.classList.remove("flash"));
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  // Restart animation by toggling class.
  requestAnimationFrame(() => target.classList.add("flash"));
}

answerEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".citation");
  if (!btn) return;
  const sid = btn.getAttribute("data-sid");
  if (sid) focusSource(sid);
});

// --- streaming ask ---------------------------------------------------------

async function ask() {
  const question = questionEl.value.trim();
  if (!question) {
    setStatus("Please enter a question.", "err");
    return;
  }
  if (activeController) activeController.abort();
  const controller = new AbortController();
  activeController = controller;

  askBtn.disabled = true;
  setStatus("Retrieving and generating...", "");
  setMeta("");
  currentAnswer = "";
  currentSources = [];
  answerEl.innerHTML = '<p class="placeholder">Streaming...</p>';
  sourcesEl.innerHTML = "";

  let model = null;
  let modeUsed = null;
  let usage = null;
  let topKUsed = null;

  try {
    const res = await fetch("/api/ask/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({
        question,
        topK: Number(topKEl.value),
        mode: modeEl.value,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    if (!res.body) throw new Error("No streaming body.");

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";
      for (const block of events) {
        if (!block.startsWith("data:")) continue;
        const json = block.slice(5).trim();
        if (!json) continue;
        let event;
        try {
          event = JSON.parse(json);
        } catch {
          continue;
        }
        if (event.type === "sources") {
          currentSources = event.sources || [];
          modeUsed = event.mode;
          topKUsed = event.topK;
          renderSources(currentSources);
          setStatus(`Retrieved ${currentSources.length} chunks (${modeUsed}). Generating...`, "");
        } else if (event.type === "model") {
          model = event.model;
        } else if (event.type === "delta") {
          currentAnswer += event.text;
          renderAnswer(currentAnswer);
        } else if (event.type === "usage") {
          usage = event.usage;
        } else if (event.type === "done" || event.type === "end") {
          // handled below
        } else if (event.type === "error") {
          throw new Error(event.error || "Stream error.");
        }
      }
    }

    const usageStr = usage
      ? ` · in=${usage.input_tokens} out=${usage.output_tokens}` +
        (usage.cache_read_input_tokens ? ` cache_read=${usage.cache_read_input_tokens}` : "")
      : "";
    setMeta(`${model || ""} · ${modeUsed || ""} · top-${topKUsed ?? topKEl.value}${usageStr}`);
    setStatus("Done.", "ok");
  } catch (err) {
    if (err.name === "AbortError") {
      setStatus("Cancelled.", "");
    } else {
      setStatus(err.message || "Something went wrong.", "err");
    }
  } finally {
    askBtn.disabled = false;
    activeController = null;
  }
}

askBtn.addEventListener("click", ask);
questionEl.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") ask();
});

topKEl.addEventListener("input", () => {
  topKValueEl.textContent = topKEl.value;
});

copyBtn.addEventListener("click", async () => {
  if (!currentAnswer) {
    setStatus("Nothing to copy yet.", "");
    return;
  }
  try {
    await navigator.clipboard.writeText(currentAnswer);
    setStatus("Answer copied.", "ok");
  } catch {
    setStatus("Copy failed.", "err");
  }
});
