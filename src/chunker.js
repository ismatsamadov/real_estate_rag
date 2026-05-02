"use strict";

/**
 * Structure-aware text chunker.
 *
 * Strategy (in priority order):
 *   1. Normalize whitespace; collapse triple-newlines to paragraph breaks.
 *   2. Split on Markdown-ish headings to keep section semantics intact.
 *   3. Inside each section, pack paragraphs greedily into <= maxChars windows.
 *   4. If a single paragraph exceeds maxChars, split it on sentence boundaries.
 *   5. Carry an `overlap` of trailing characters from the previous window into
 *      the next, snapped to a sentence/paragraph boundary, so cross-chunk
 *      questions (e.g., facts spanning two paragraphs) can still be answered.
 *   6. Merge any final chunk smaller than minChars back into its predecessor.
 *
 * Returns: array of strings.
 */

const HEADING_RE = /^(#{1,6})\s+.+$/gm;

function normalize(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t ]+/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitByHeadings(text) {
  const sections = [];
  const matches = [...text.matchAll(HEADING_RE)];
  if (!matches.length) return [text];
  let cursor = 0;
  for (const match of matches) {
    const start = match.index;
    if (start > cursor) {
      const slice = text.slice(cursor, start).trim();
      if (slice) sections.push(slice);
    }
    cursor = start;
  }
  const tail = text.slice(cursor).trim();
  if (tail) sections.push(tail);
  return sections;
}

function splitParagraphs(text) {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function splitSentences(paragraph) {
  const sentences = paragraph
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(\[])/)
    .map((s) => s.trim())
    .filter(Boolean);
  return sentences.length ? sentences : [paragraph];
}

function takeOverlap(prev, overlap) {
  if (!prev || overlap <= 0) return "";
  if (prev.length <= overlap) return prev;
  const tail = prev.slice(prev.length - overlap);
  // Snap forward to the next sentence/word boundary so we don't
  // start mid-token.
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
      } else {
        // Long paragraph: fall back to sentences. If a single sentence is
        // still too long, hard-split on character boundaries.
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
          if (!buffer) {
            buffer = sentence;
          } else if (buffer.length + 1 + sentence.length <= maxChars) {
            buffer = `${buffer} ${sentence}`;
          } else {
            units.push(buffer);
            buffer = sentence;
          }
        }
        if (buffer) units.push(buffer);
      }
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
    // Drop the overlap if it would push us over the hard limit. We never
    // emit a chunk larger than maxChars.
    return withLead.length <= maxChars ? withLead : unit;
  };

  for (const unit of units) {
    if (!current) {
      current = startChunk(unit);
      continue;
    }
    const candidate = `${current}\n\n${unit}`;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      flush();
      current = startChunk(unit);
    }
  }
  flush();

  // Merge an undersized tail into its predecessor when it fits.
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

module.exports = { chunkText, normalize };
