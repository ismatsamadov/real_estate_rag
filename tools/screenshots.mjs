// Regenerate every screenshot used in README.md.
//
//   1. Start the app:  npm run start  (or  npm run dev)
//   2. Run this script: node tools/screenshots.mjs
//
// Captures full-page PNGs into screenshots/. Designed for the demo data
// already in Neon, not for a hermetic test corpus.
//
// Headless by default; pass --headed to watch it run.
//
// One-off maintenance tool, NOT a CLI script the app depends on — kept
// out of package.json's "scripts" intentionally.

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(REPO_ROOT, ".env") });

const BASE_URL = process.env.SCREENSHOT_BASE_URL || "http://localhost:3000";
const USER = process.env.DEMO_USERNAME;
const PASS = process.env.DEMO_PASSWORD;
const OUT_DIR = path.join(REPO_ROOT, "screenshots");
const HEADED = process.argv.includes("--headed");

if (!USER || !PASS) {
  console.error("DEMO_USERNAME and DEMO_PASSWORD must be set in .env");
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const DESKTOP = { width: 1440, height: 900, deviceScaleFactor: 2 };

async function login(page) {
  await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded" });
  // The LoginForm component uses <label> elements rather than name attrs.
  await page.getByLabel(/username/i).fill(USER);
  await page.getByLabel(/password/i).fill(PASS);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15_000 }),
    page.getByRole("button", { name: /sign in/i }).click(),
  ]);
}

async function snap(page, name) {
  const file = path.join(OUT_DIR, name);
  await page.screenshot({ path: file, fullPage: true });
  console.log("  ✓", path.relative(REPO_ROOT, file));
}

async function settle(page, ms = 600) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(ms);
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED });
  const ctx = await browser.newContext({
    viewport: DESKTOP,
    deviceScaleFactor: DESKTOP.deviceScaleFactor,
  });
  const page = await ctx.newPage();

  console.log("→ /login");
  await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded" });
  await settle(page);
  await snap(page, "login page.png");

  console.log("→ login flow");
  await login(page);
  await settle(page, 1200);
  await snap(page, "new chat page.png");

  console.log("→ typing question");
  const composer = page.locator('textarea, input[type="text"]').first();
  await composer.click();
  await composer.fill(
    "What apartments are available at The Residences at the St. Regis Baku?",
  );
  await settle(page, 300);
  await snap(page, "asking new question page.png");

  console.log("→ submitting question (Cmd+Enter is enabled by the composer)");
  await composer.press("Enter");
  // Wait for streaming to finish — heuristic: when the visible "Stop"
  // button (if any) becomes "New chat" or when no more delta arrives.
  // Simpler: wait for the assistant message to grow and stabilize.
  let lastLen = 0;
  let stable = 0;
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(1000);
    const len = await page.evaluate(() => document.body.innerText.length);
    if (len === lastLen) {
      stable++;
      if (stable >= 3) break;
    } else {
      stable = 0;
      lastLen = len;
    }
  }
  await snap(page, "answered question page.png");

  console.log("→ revealing sources");
  // The Sources panel reveal button. Try a few label patterns.
  const revealBtn = page
    .getByRole("button", { name: /sources?|show citations|reveal/i })
    .first();
  if (await revealBtn.count()) {
    await revealBtn.click().catch(() => {});
    await settle(page, 400);
    await snap(page, "sources revealed page.png");
  } else {
    console.log("  (no reveal button found; skipping sources screenshot)");
  }

  console.log("→ opening Saved modal");
  const savedBtn = page.getByRole("button", { name: /saved/i }).first();
  if (await savedBtn.count()) {
    await savedBtn.click().catch(() => {});
    await settle(page, 500);
    await snap(page, "saving listings page.png");
    // close modal
    await page.keyboard.press("Escape").catch(() => {});
    await settle(page, 200);
  }

  console.log("→ /uploads (cross-session library)");
  await page.goto(`${BASE_URL}/uploads`, { waitUntil: "domcontentloaded" });
  await settle(page, 800);
  await snap(page, "uploads library page.png");

  console.log("→ back to chat — sidebar profile panel open");
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
  await settle(page, 1000);
  // Expand the "What the LLM knows" panel.
  const profilePanel = page
    .getByRole("button", { name: /what the llm knows|toggle user profile/i })
    .first();
  if (await profilePanel.count()) {
    await profilePanel.click().catch(() => {});
    await settle(page, 400);
    await snap(page, "sidebar profile panel.png");
  }

  // Open an existing session (the first one in the sidebar) so the screenshot
  // shows a populated thread, not the empty landing.
  console.log("→ opening an existing session");
  const firstSession = page.locator('[role="button"][aria-pressed]').first();
  if (await firstSession.count()) {
    await firstSession.click().catch(() => {});
    await settle(page, 800);
    await snap(page, "old chat session page.png");
  }

  await browser.close();
  console.log("\nAll screenshots written to", path.relative(REPO_ROOT, OUT_DIR));
}

main().catch((err) => {
  console.error("screenshots failed:", err);
  process.exit(1);
});
