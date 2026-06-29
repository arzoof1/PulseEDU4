// Renders exports/migration-handoff.html to a shareable PDF using headless
// Chromium (puppeteer). Self-contained HTML (inline CSS), so file:// is enough.
// Page size driven by the document's @page { size: Letter } via preferCSSPageSize.

import puppeteer from "puppeteer";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML = resolve(HERE, "..", "..", "exports", "migration-handoff.html");
const OUT = resolve(
  HERE,
  "..",
  "..",
  "exports",
  "PulseEDU-Migration-Handoff-2026-06-29.pdf",
);

async function main() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(HTML).href, { waitUntil: "networkidle0" });
    await page.pdf({ path: OUT, printBackground: true, preferCSSPageSize: true });
    console.log("Wrote", OUT);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
