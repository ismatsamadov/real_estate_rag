"use strict";

/**
 * PDF text extraction, page-by-page.
 *
 * Uses pdfjs-dist (Mozilla's PDF.js) in the Node legacy build. We extract
 * each page as a clean text string and return [{ page, text }] so the
 * downstream chunker can carry the page number into metadata — every
 * citation that comes back from retrieval can then be a clickable
 * "Source: contract.pdf, page 4" link.
 *
 * Why pdfjs-dist over pdf-parse / pdf-lib:
 *  - pdfjs-dist gives us per-page granularity natively
 *  - It works in Node serverless runtimes (Vercel) without native bindings
 *  - It handles complex layouts (multi-column, tables, scanned-with-OCR PDFs
 *    that have a text layer) better than the simpler libraries
 */

// Lazy-load pdfjs-dist so the cold start of routes that don't touch PDFs
// stays unaffected. The legacy build avoids Node's lack of DOMMatrix.
let pdfjsPromise = null;
async function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs");
  }
  return pdfjsPromise;
}

/**
 * Extract a PDF's text content page by page.
 *
 * @param {Buffer|Uint8Array} buffer - The raw PDF bytes.
 * @returns {Promise<{ totalPages: number, pages: Array<{ page: number, text: string }> }>}
 */
async function extractPdfPages(buffer) {
  const pdfjs = await getPdfjs();
  // pdfjs's typed-array check rejects Node `Buffer` even though it's a
  // Uint8Array subclass. Force a plain Uint8Array view over the same
  // underlying ArrayBuffer (zero-copy).
  const data =
    buffer instanceof Uint8Array && Object.getPrototypeOf(buffer) === Uint8Array.prototype
      ? buffer
      : new Uint8Array(
          buffer.buffer || buffer,
          buffer.byteOffset || 0,
          buffer.byteLength || buffer.length,
        );

  // disableWorker keeps everything in-process; Vercel functions don't have
  // a worker context. useSystemFonts is off because serverless containers
  // don't have a font registry.
  const loadingTask = pdfjs.getDocument({
    data,
    disableWorker: true,
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
    verbosity: 0,
  });

  const pdf = await loadingTask.promise;
  const totalPages = pdf.numPages;
  const pages = [];

  for (let p = 1; p <= totalPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    // Each text "item" in PDF.js is a positioned text fragment. Joining
    // with a single space rebuilds reading order well enough for chunking
    // and embedding. A more elaborate layout algorithm (preserving columns
    // and paragraph breaks) is the next-level improvement, not needed
    // for v1.
    const text = content.items
      .map((it) => ("str" in it ? it.str : ""))
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    pages.push({ page: p, text });
    // Free memory between pages — important for large PDFs in serverless.
    page.cleanup();
  }

  await pdf.destroy();
  return { totalPages, pages };
}

module.exports = { extractPdfPages };
