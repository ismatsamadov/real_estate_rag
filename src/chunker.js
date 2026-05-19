"use strict";

/**
 * Document-aware chunker.
 *
 *   - `chunkDocument(record, opts)` dispatches on doc_type:
 *       * listing  -> 1 atomic chunk per property + structured metadata
 *                     (price, currency, bedrooms, area_sqm, listing_type, …).
 *                     Property facts belong together at retrieval time so the
 *                     LLM never has to stitch a half-spec from two chunks.
 *       * article  -> heading/paragraph/sentence splitter with overlap.
 *       * static   -> same as article (about/contact/etc. — usually short).
 *
 *   - `chunkText(text, opts)` is exported for code that wants just the
 *     splitter (eval harness, tests).
 *
 *   - `extractListingMetadata(record)` is exported for testability.
 *
 * Returns from chunkDocument:
 *   {
 *     doc: { doc_id, url, title, doc_type, language, metadata, source_hash },
 *     chunks: [{ chunk_index, content, content_hash, metadata }]
 *   }
 */

const crypto = require("node:crypto");

// ---------------------------------------------------------------------------
// Generic text splitter (used by articles + static pages)
// ---------------------------------------------------------------------------

const HEADING_RE = /^(#{1,6})\s+.+$/gm;

function normalize(text) {
  return (
    String(text || "")
      .replace(/\r\n?/g, "\n")
      // Drop image references: ![alt](url) and bare CDN URLs that survived
      // markdown conversion. They eat ~30-60% of token budget on listing
      // pages and contribute zero retrieval signal.
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/https?:\/\/cdn\.\S+/g, "")
      // Strip remaining link wrappers but keep anchor text: [text](url) -> text
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[\t ]+/g, " ")
      .replace(/[ ]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

function splitByHeadings(text) {
  const matches = [...text.matchAll(HEADING_RE)];
  if (!matches.length) return [text];
  const sections = [];
  let cursor = 0;
  for (const m of matches) {
    if (m.index > cursor) {
      const slice = text.slice(cursor, m.index).trim();
      if (slice) sections.push(slice);
    }
    cursor = m.index;
  }
  const tail = text.slice(cursor).trim();
  if (tail) sections.push(tail);
  return sections;
}

function splitParagraphs(text) {
  return text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
}

function splitSentences(paragraph) {
  const out = paragraph
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(\[])/)
    .map((s) => s.trim())
    .filter(Boolean);
  return out.length ? out : [paragraph];
}

function takeOverlap(prev, overlap) {
  if (!prev || overlap <= 0) return "";
  if (prev.length <= overlap) return prev;
  const tail = prev.slice(prev.length - overlap);
  const sentenceMatch = tail.match(/[.!?]\s+(.+)$/s);
  if (sentenceMatch) return sentenceMatch[1].trim();
  const wordMatch = tail.match(/\s+(\S.*)$/s);
  return (wordMatch ? wordMatch[1] : tail).trim();
}

function chunkText(input, { maxChars = 1200, overlap = 180, minChars = 200 } = {}) {
  const text = normalize(input);
  if (!text) return [];

  const units = [];
  for (const section of splitByHeadings(text)) {
    for (const para of splitParagraphs(section)) {
      if (para.length <= maxChars) {
        units.push(para);
        continue;
      }
      const sentences = splitSentences(para);
      let buffer = "";
      for (const sentence of sentences) {
        if (sentence.length > maxChars) {
          if (buffer) {
            units.push(buffer);
            buffer = "";
          }
          for (let i = 0; i < sentence.length; i += maxChars) {
            units.push(sentence.slice(i, i + maxChars));
          }
          continue;
        }
        if (!buffer) buffer = sentence;
        else if (buffer.length + 1 + sentence.length <= maxChars) buffer = `${buffer} ${sentence}`;
        else {
          units.push(buffer);
          buffer = sentence;
        }
      }
      if (buffer) units.push(buffer);
    }
  }

  const chunks = [];
  let current = "";
  const flush = () => {
    const out = current.trim();
    if (out) chunks.push(out);
    current = "";
  };
  const startChunk = (unit) => {
    const lead = chunks.length ? takeOverlap(chunks[chunks.length - 1], overlap) : "";
    if (!lead) return unit;
    const withLead = `${lead}\n\n${unit}`;
    return withLead.length <= maxChars ? withLead : unit;
  };
  for (const unit of units) {
    if (!current) {
      current = startChunk(unit);
      continue;
    }
    const candidate = `${current}\n\n${unit}`;
    if (candidate.length <= maxChars) current = candidate;
    else {
      flush();
      current = startChunk(unit);
    }
  }
  flush();

  // Merge an undersized tail into its predecessor.
  if (chunks.length >= 2) {
    const last = chunks[chunks.length - 1];
    const prev = chunks[chunks.length - 2];
    if (last.length < minChars && prev.length + 2 + last.length <= maxChars) {
      chunks[chunks.length - 2] = `${prev}\n\n${last}`;
      chunks.pop();
    }
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Listing metadata extraction
// ---------------------------------------------------------------------------

// Order matters: USD before AZN so "$" wins over "₼" when both appear.
const CURRENCY_PATTERNS = [
  { re: /\$\s?([\d.,\s]{3,})/i, currency: "USD" },
  { re: /USD\s?([\d.,\s]{3,})/i, currency: "USD" },
  { re: /€\s?([\d.,\s]{3,})/i, currency: "EUR" },
  { re: /EUR\s?([\d.,\s]{3,})/i, currency: "EUR" },
  { re: /AZN\s?([\d.,\s]{3,})/i, currency: "AZN" },
  { re: /₼\s?([\d.,\s]{3,})/i, currency: "AZN" },
  { re: /([\d.,\s]{3,})\s?₼/i, currency: "AZN" },
  { re: /([\d.,\s]{3,})\s?(?:manat|man\.)/i, currency: "AZN" },
  { re: /₽\s?([\d.,\s]{3,})/i, currency: "RUB" },
  { re: /RUB\s?([\d.,\s]{3,})/i, currency: "RUB" },
];

// Bedrooms: matches "3 bedrooms", "3-bedroom", "3-room", "3 otaqlı", "3-комнатная".
const BEDROOM_PATTERNS = [
  /(\d+)\s*[-+]?\s*bedroom/i,
  /(\d+)\s*[-+]?\s*bed\b/i,
  /(\d+)\s*[-+]?\s*room\b/i,
  /(\d+)\s*[-+]?\s*otaq/i, // Azerbaijani
  /(\d+)\s*[-+]?\s*комнат/i, // Russian
];

const BATHROOM_PATTERNS = [
  /(\d+)\s*[-+]?\s*bathroom/i,
  /(\d+)\s*[-+]?\s*bath\b/i,
  /(\d+)\s*[-+]?\s*санузел/i,
  /(\d+)\s*[-+]?\s*hamam/i,
];

// Area: matches "120 sqm", "120 m²", "120 м²", "120 kv.m".
const AREA_PATTERNS = [
  /(\d{2,5}(?:[.,]\d{1,2})?)\s*(?:sq\.?\s*m|sqm|m²|m2|kvm|kv\.m)/i,
  /(\d{2,5}(?:[.,]\d{1,2})?)\s*м²/i,
  /(\d{2,5}(?:[.,]\d{1,2})?)\s*кв\.?\s*м/i,
];

const LISTING_TYPE_PATTERNS = [
  { type: "rent", re: /\b(for\s+rent|rental|kira|аренда|sdaetsya)\b/i },
  { type: "sale", re: /\b(for\s+sale|sale\s+price|satlir|satilir|prodazh)\b/i },
];

const PROPERTY_TYPE_PATTERNS = [
  { type: "apartment", re: /\b(apartment|flat|condo|menzil|квартир|kvartir)\b/i },
  { type: "villa", re: /\b(villa|townhouse|house|villa)\b/i },
  { type: "office", re: /\b(office|ofis|офис|kommersant|commercial)\b/i },
  { type: "retail", re: /\b(retail|shop|store|magazin)\b/i },
];

function parseNumber(raw) {
  if (!raw) return null;
  // "1,250,000" / "1.250.000" / "1 250 000" → 1250000
  const cleaned = String(raw)
    .replace(/\s/g, "")
    .replace(/,(?=\d{3}(\D|$))/g, "")
    .replace(/\.(?=\d{3}(\D|$))/g, "");
  // After de-grouping: comma is decimal in many EU locales, but for prices
  // we treat any remaining comma/period followed by 2 digits as decimal.
  const n = parseFloat(cleaned.replace(/,/g, "."));
  return Number.isFinite(n) ? n : null;
}

function firstMatch(text, patterns) {
  for (const p of patterns) {
    const re = p.re || p;
    const m = re.exec(text);
    if (m) return { match: m, meta: p };
  }
  return null;
}

function extractListingMetadata(record) {
  const text = `${record.title || ""}\n${record.markdown || ""}`;
  const out = {};

  // Price
  for (const p of CURRENCY_PATTERNS) {
    const m = p.re.exec(text);
    if (m) {
      const amount = parseNumber(m[1]);
      if (amount && amount > 100) {
        out.price = amount;
        out.currency = p.currency;
        break;
      }
    }
  }

  // Bedrooms / bathrooms / area
  const bed = firstMatch(text, BEDROOM_PATTERNS);
  if (bed) out.bedrooms = parseInt(bed.match[1], 10);

  const bath = firstMatch(text, BATHROOM_PATTERNS);
  if (bath) out.bathrooms = parseInt(bath.match[1], 10);

  const area = firstMatch(text, AREA_PATTERNS);
  if (area) out.area_sqm = parseNumber(area.match[1]);

  // Listing type (sale vs rent)
  const lt = firstMatch(text, LISTING_TYPE_PATTERNS);
  if (lt) out.listing_type = lt.meta.type;

  // Property type
  const pt = firstMatch(text, PROPERTY_TYPE_PATTERNS);
  if (pt) out.property_type = pt.meta.type;

  // Location: best-effort heuristic — last comma-separated segment of title,
  // falling back to first H1 in body.
  const title = record.title || "";
  const commaParts = title.split(",").map((s) => s.trim()).filter(Boolean);
  if (commaParts.length >= 2) {
    out.location = commaParts[commaParts.length - 1];
  }

  return out;
}

// ---------------------------------------------------------------------------
// Document chunking
// ---------------------------------------------------------------------------

function hashContent(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function chunkDocument(record, opts = {}) {
  const { maxChars = 1200, overlap = 180, minChars = 200 } = opts;
  const content = normalize(record.markdown || record.content || "");
  const docType = record.doc_type || "article";

  // Doc-level metadata is whatever the scraper carried + any extracted facts.
  const docMetadata = {
    ...(record.source_metadata?.description
      ? { description: String(record.source_metadata.description).slice(0, 500) }
      : {}),
  };

  let chunks;
  let extracted = {};

  if (docType === "listing") {
    // Atomic: one chunk per property. Voyage's 32k context window easily
    // handles even verbose listings, so splitting just dilutes retrieval.
    extracted = extractListingMetadata(record);
    Object.assign(docMetadata, extracted);
    const body = content || record.title || "";
    chunks = body ? [body] : [];
  } else {
    chunks = chunkText(content, { maxChars, overlap, minChars });
  }

  return {
    doc: {
      doc_id: record.doc_id,
      url: record.url,
      title: record.title || null,
      doc_type: docType,
      language: record.language || "en",
      metadata: docMetadata,
      source_hash: hashContent(content),
    },
    chunks: chunks.map((text, i) => ({
      chunk_index: i,
      content: text,
      content_hash: hashContent(text),
      // Chunk inherits doc-level extracted facts so retrieval can filter
      // on them without joining the documents table on every query.
      metadata: {
        doc_type: docType,
        language: record.language || "en",
        ...extracted,
      },
    })),
  };
}

module.exports = {
  chunkText,
  chunkDocument,
  extractListingMetadata,
  normalize,
};
