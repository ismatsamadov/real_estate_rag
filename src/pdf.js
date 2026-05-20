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

// pdfjs-dist v5 tries to read DOMMatrix from `canvas`, warns if absent, then
// crashes the first time it constructs one (e.g. while parsing certain text
// operators). Vercel's serverless runtime has no `canvas` and no native
// DOMMatrix. A minimal pure-JS DOMMatrix is enough for text extraction —
// pdfjs only uses multiply / translate / scale / invert here.
if (typeof globalThis.DOMMatrix === "undefined") {
  class DOMMatrixPolyfill {
    constructor(init) {
      let a = 1, b = 0, c = 0, d = 1, e = 0, f = 0;
      if (typeof init === "string") {
        init = init.match(/-?\d+(?:\.\d+)?/g)?.map(Number) || [];
      }
      if (Array.isArray(init) && init.length === 6) {
        [a, b, c, d, e, f] = init;
      } else if (Array.isArray(init) && init.length === 16) {
        a = init[0]; b = init[1]; c = init[4]; d = init[5]; e = init[12]; f = init[13];
      }
      this.a = this.m11 = a;
      this.b = this.m12 = b;
      this.c = this.m21 = c;
      this.d = this.m22 = d;
      this.e = this.m41 = e;
      this.f = this.m42 = f;
      this.is2D = true;
    }
    get isIdentity() {
      return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0;
    }
    multiply(m) {
      const r = new DOMMatrixPolyfill();
      r.a = this.a * m.a + this.c * m.b;
      r.b = this.b * m.a + this.d * m.b;
      r.c = this.a * m.c + this.c * m.d;
      r.d = this.b * m.c + this.d * m.d;
      r.e = this.a * m.e + this.c * m.f + this.e;
      r.f = this.b * m.e + this.d * m.f + this.f;
      r.m11 = r.a; r.m12 = r.b; r.m21 = r.c; r.m22 = r.d; r.m41 = r.e; r.m42 = r.f;
      return r;
    }
    invertSelf() {
      const det = this.a * this.d - this.b * this.c;
      if (det === 0) {
        this.a = this.b = this.c = this.d = this.e = this.f = NaN;
      } else {
        const a = this.d / det, b = -this.b / det, c = -this.c / det, d = this.a / det;
        const e = (this.c * this.f - this.d * this.e) / det;
        const f = (this.b * this.e - this.a * this.f) / det;
        this.a = a; this.b = b; this.c = c; this.d = d; this.e = e; this.f = f;
      }
      this.m11 = this.a; this.m12 = this.b; this.m21 = this.c; this.m22 = this.d; this.m41 = this.e; this.m42 = this.f;
      return this;
    }
    translateSelf(x = 0, y = 0) {
      this.e += this.a * x + this.c * y;
      this.f += this.b * x + this.d * y;
      this.m41 = this.e; this.m42 = this.f;
      return this;
    }
    scaleSelf(sx = 1, sy = sx) {
      this.a *= sx; this.b *= sx; this.c *= sy; this.d *= sy;
      this.m11 = this.a; this.m12 = this.b; this.m21 = this.c; this.m22 = this.d;
      return this;
    }
    translate(x, y) {
      return new DOMMatrixPolyfill([this.a, this.b, this.c, this.d, this.e, this.f]).translateSelf(x, y);
    }
    scale(sx, sy) {
      return new DOMMatrixPolyfill([this.a, this.b, this.c, this.d, this.e, this.f]).scaleSelf(sx, sy);
    }
  }
  globalThis.DOMMatrix = DOMMatrixPolyfill;
}

// Lazy-load pdfjs-dist so the cold start of routes that don't touch PDFs
// stays unaffected. The legacy build is the Node-friendly bundle.
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
