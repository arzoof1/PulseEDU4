// Batch-convert api-server launch documentation markdown → PDF for client delivery.
// Run: pnpm --filter @workspace/scripts run docs-pdf

import { copyFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { convertDocsDirectory } from "./markdownToPdf";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const DOCS_DIR = resolve(REPO, "artifacts/api-server/docs");
const OUT_DIR = resolve(DOCS_DIR, "pdf");

const written = convertDocsDirectory(DOCS_DIR, OUT_DIR);

const trackerXlsx = resolve(DOCS_DIR, "launch-readiness-tracker.xlsx");
const trackerOut = resolve(OUT_DIR, "PulseEDU - Launch Readiness Tracker.xlsx");
if (existsSync(trackerXlsx)) {
  copyFileSync(trackerXlsx, trackerOut);
  console.log(`Copied ${trackerOut}`);
}

const extraPdfs: [string, string][] = [
  [
    resolve(REPO, "Pulse_EDU_Launch_Clarification_Answers.pdf"),
    resolve(OUT_DIR, "PulseEDU - Launch Clarification Answers.pdf"),
  ],
  [
    resolve(REPO, "Pulse_EDU_ClassLink_Timeline.pdf"),
    resolve(OUT_DIR, "PulseEDU - ClassLink Integration Scope and Schedule.pdf"),
  ],
];

for (const [src, dest] of extraPdfs) {
  if (existsSync(src)) {
    copyFileSync(src, dest);
    console.log(`Copied ${dest}`);
  }
}

console.log(`\nDone: ${written.length} PDF(s) in ${OUT_DIR}`);
