const questionEl = document.getElementById("question");
const topKEl = document.getElementById("topK");
const topKValueEl = document.getElementById("topKValue");
const askBtn = document.getElementById("askBtn");
const copyBtn = document.getElementById("copyBtn");
const statusEl = document.getElementById("status");
const answerEl = document.getElementById("answer");
const sourcesEl = document.getElementById("sources");

let lastAnswer = "";

function setStatus(text, type = "") {
  statusEl.textContent = text;
  statusEl.className = `status ${type}`.trim();
}

function escapeHtml(text) {
  return String(text)
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

function normalizeSnippet(text) {
  const clean = String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/\s*\.\.\.\s*$/, "")
    .trim();
  return clean.length <= 280 ? clean : `${clean.slice(0, 280)}...`;
}

function sourceDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function sourcePath(url) {
  try {
    const pathname = new URL(url).pathname || "/";
    return pathname.length > 42 ? `${pathname.slice(0, 42)}...` : pathname;
  } catch {
    return "";
  }
}

function compactDocId(docId) {
  const clean = String(docId || "").trim();
  if (!clean) return "n/a";
  if (clean.length <= 46) return clean;
  return `${clean.slice(0, 20)}...${clean.slice(-16)}`;
}

function truncateMiddle(text, max = 72) {
  const value = String(text || "").trim();
  if (!value || value.length <= max) return value;
  const head = Math.ceil((max - 3) / 2);
  const tail = Math.floor((max - 3) / 2);
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
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

function formatInline(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/\[(S\d+)\]/g, '<span class="citation">[$1]</span>');
}

function renderAnswer(text) {
  const lines = String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .split("\n");
  let html = "";
  let listType = null;

  const closeList = () => {
    if (listType) {
      html += listType === "ol" ? "</ol>" : "</ul>";
      listType = null;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      closeList();
      continue;
    }

    const headingHashMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingHashMatch) {
      closeList();
      html += `<h3 class="answer-heading">${formatInline(headingHashMatch[2])}</h3>`;
      continue;
    }

    const orderedMatch = line.match(/^(\d+)\.\s+(.+)$/);
    if (orderedMatch) {
      if (listType !== "ol") {
        closeList();
        html += '<ol class="answer-list">';
        listType = "ol";
      }
      html += `<li>${formatInline(orderedMatch[2])}</li>`;
      continue;
    }

    const bulletMatch = line.match(/^[-*]\s+(.+)$/);
    if (bulletMatch) {
      if (listType !== "ul") {
        closeList();
        html += '<ul class="answer-list">';
        listType = "ul";
      }
      html += `<li>${formatInline(bulletMatch[1])}</li>`;
      continue;
    }

    closeList();

    const headingMatch = line.match(/^\*\*(.+?)\*\*:?$/);
    if (headingMatch) {
      html += `<h3 class="answer-heading">${formatInline(headingMatch[1])}</h3>`;
      continue;
    }

    html += `<p>${formatInline(line)}</p>`;
  }

  closeList();
  answerEl.innerHTML = html || "<p>No answer returned.</p>";
}

function renderSources(sources) {
  if (!Array.isArray(sources) || !sources.length) {
    sourcesEl.innerHTML = '<p class="source-meta">No sources returned.</p>';
    return;
  }

  sourcesEl.innerHTML = sources
    .map((s) => {
      const sourceUrl = normalizeUrl(s.url);
      const snippet = normalizeSnippet(s.snippet || s.content || "");
      const docId = String(s.doc_id || "").trim();
      const metadata = s.metadata && typeof s.metadata === "object" ? s.metadata : {};
      const chunkIndex = Number.isInteger(Number(s.chunk_index))
        ? String(Number(s.chunk_index))
        : String(s.chunk_index ?? "n/a");
      const title = String(metadata.title || "").trim() || "Untitled source";
      const pageKind = prettyTag(metadata.pageKind, "unknown");
      const language = prettyTag(metadata.language, "n/a");
      const domain = sourceDomain(sourceUrl);
      const pagePath = sourcePath(sourceUrl);
      const scoreValue = (Number(s.score) || 0).toFixed(4);
      const sid = String(s.sid || "S?");
      const urlLabel = truncateMiddle(sourceUrl, 74);

      return `
      <article class="source-card">
        <div class="source-head">
          <span class="sid">${escapeHtml(sid)}</span>
          <span class="badge">score ${scoreValue}</span>
        </div>
        <h3 class="source-title">${escapeHtml(title)}</h3>
        <div class="source-meta-row">
          <span class="badge badge-muted">type ${escapeHtml(pageKind)}</span>
          <span class="badge badge-muted">lang ${escapeHtml(language)}</span>
          ${domain ? `<span class="badge badge-muted">${escapeHtml(domain)}</span>` : ""}
        </div>
        <div class="source-meta-row">
          <span class="badge badge-muted" title="${escapeHtml(docId)}">doc ${escapeHtml(compactDocId(docId))}</span>
          <span class="badge badge-muted">chunk ${escapeHtml(chunkIndex)}</span>
        </div>
        <div class="score-track" role="presentation">
          <span class="score-bar" style="width:${Math.max(0, Math.min(100, Number(s.score) * 100)).toFixed(1)}%"></span>
        </div>
        ${
          sourceUrl
            ? `<a class="source-url" href="${escapeHtml(sourceUrl)}" title="${escapeHtml(sourceUrl)}" target="_blank" rel="noreferrer">${escapeHtml(urlLabel)}</a>`
            : '<span class="source-url-fallback">No source URL</span>'
        }
        ${pagePath ? `<p class="source-meta">${escapeHtml(pagePath)}</p>` : ""}
        <p class="source-snippet">${escapeHtml(snippet)}</p>
      </article>
    `;
    })
    .join("");
}

async function ask() {
  const question = questionEl.value.trim();
  if (!question) {
    setStatus("Please enter a question.", "err");
    return;
  }

  askBtn.disabled = true;
  setStatus("Thinking with grounded retrieval...", "");
  answerEl.textContent = "";
  sourcesEl.textContent = "";

  try {
    const res = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question,
        topK: Number(topKEl.value),
      }),
    });

    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || "Request failed.");
    }

    lastAnswer = data.answer || "";
    renderAnswer(lastAnswer);
    renderSources(data.sources || []);
    setStatus(`Done • ${data.model} • top-${data.topK} chunks`, "ok");
  } catch (err) {
    setStatus(err.message || "Something went wrong.", "err");
  } finally {
    askBtn.disabled = false;
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
  if (!lastAnswer) return;
  try {
    await navigator.clipboard.writeText(lastAnswer);
    setStatus("Answer copied.", "ok");
  } catch {
    setStatus("Copy failed.", "err");
  }
});
