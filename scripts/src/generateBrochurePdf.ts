// Renders docs/brochure/brochure.html to docs/brochure/PulseEDU-Brochure.pdf
// using headless Chromium (puppeteer). The brochure is fully self-contained
// (inline SVG, no external fonts/images), so a file:// load is sufficient.
// Page size is driven by the brochure's own @page { size: Letter } via
// preferCSSPageSize.

import puppeteer from "puppeteer";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML = resolve(HERE, "..", "..", "docs", "brochure", "brochure.html");
const OUT = resolve(HERE, "..", "..", "docs", "brochure", "PulseEDU-Brochure.pdf");

async function main() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(HTML).href, { waitUntil: "networkidle0" });
    await page.pdf({
      path: OUT,
      printBackground: true,
      preferCSSPageSize: true,
    });
    console.log("Wrote", OUT);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
