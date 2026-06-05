/**
 * Convert PulseEDU markdown documentation to client-ready PDFs (pdfkit).
 */
import PDFDocument from "pdfkit";
import { createWriteStream, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const MARGIN = 54;
const CONTENT_W = 504;
const PAGE_BOTTOM = 738;
const BODY_SIZE = 9.5;
const CODE_SIZE = 8;

const C = {
  ink: "#0f172a",
  sub: "#475569",
  muted: "#94a3b8",
  rule: "#e2e8f0",
  brand: "#1d4ed8",
  accent: "#0e7490",
  panel: "#f8fafc",
  quote: "#f1f5f9",
};

export type PdfTheme = typeof C;

/** Client-facing PDF filenames (override auto title-case). */
const PDF_BASENAMES: Record<string, string> = {
  "aws-hosting-and-infrastructure-overview":
    "PulseEDU - AWS Hosting and Infrastructure Overview",
  "backup-and-disaster-recovery": "PulseEDU - Backup and Disaster Recovery",
  "classlink-oneroster-integration-overview":
    "PulseEDU - ClassLink OneRoster Integration Overview",
  "coppa-alignment": "PulseEDU - COPPA Alignment Summary",
  "database-architecture-overview": "PulseEDU - Database Architecture Overview",
  "faq-schools-and-districts": "PulseEDU - FAQ for Schools and Districts",
  "ferpa-alignment": "PulseEDU - FERPA Alignment Summary",
  "ferpa-coppa-client-summary": "PulseEDU - FERPA and COPPA Client Summary",
  "incident-response-and-rotation-runbook":
    "PulseEDU - Incident Response and Credential Rotation Runbook",
  "launch-readiness-tracker": "PulseEDU - Launch Readiness Tracker",
  "security-privacy-evidence-pack":
    "PulseEDU - Security and Privacy Evidence Pack",
  "security-verification-checklist": "PulseEDU - Security Verification Checklist",
  "student-data-security-overview": "PulseEDU - Student Data Security Overview",
  "system-administration-guide": "PulseEDU - System Administration Guide",
  "text-messaging-aws-sns-architecture":
    "PulseEDU - Text Messaging AWS SNS Architecture",
  "troubleshooting-guide": "PulseEDU - Troubleshooting Guide",
};

export function kebabToPdfBasename(kebab: string): string {
  if (PDF_BASENAMES[kebab]) return PDF_BASENAMES[kebab];
  const title = kebab
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return `PulseEDU - ${title}`;
}

export function markdownFileToPdf(
  inputPath: string,
  outputPath: string,
  options?: { docTitle?: string },
): void {
  const md = readFileSync(inputPath, "utf8");
  mkdirSync(dirname(outputPath), { recursive: true });

  const firstH1 = md.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const title = options?.docTitle ?? firstH1 ?? kebabToPdfBasename(basename(inputPath, ".md"));

  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    bufferPages: true,
    info: {
      Title: title,
      Author: "PulseEDU",
      Subject: "PulseEDU launch documentation",
    },
  });

  doc.pipe(createWriteStream(outputPath));

  let pageNumbers = true;

  function ensureSpace(need: number) {
    if (doc.y + need > PAGE_BOTTOM) doc.addPage();
  }

  function moveDown(gap = 0.28) {
    doc.moveDown(gap);
  }

  function stripInline(md: string): string {
    return md
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  }

  function writeRichParagraph(text: string, opts?: { size?: number; color?: string; indent?: number }) {
    const size = opts?.size ?? BODY_SIZE;
    const color = opts?.color ?? C.ink;
    const width = CONTENT_W - (opts?.indent ?? 0);
    const parts = text.split(/(\*\*[^*]+\*\*)/g).filter((p) => p.length > 0);
    if (parts.length === 1) {
      doc.fillColor(color).font("Helvetica").fontSize(size);
      doc.text(stripInline(parts[0]!), { width, indent: opts?.indent, lineGap: 1.35 });
      moveDown();
      return;
    }
    let first = true;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const bold = part.startsWith("**") && part.endsWith("**");
      const chunk = bold ? part.slice(2, -2) : stripInline(part);
      doc.fillColor(color).font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size);
      doc.text(chunk, {
        width,
        indent: opts?.indent,
        lineGap: 1.35,
        continued: i < parts.length - 1,
      });
      first = false;
    }
    if (!first) doc.text("", { continued: false });
    moveDown();
  }

  function H1(t: string) {
    doc.fillColor(C.brand).font("Helvetica-Bold").fontSize(18).text(t, { width: CONTENT_W });
    moveDown(0.35);
  }

  function H2(t: string) {
    ensureSpace(48);
    doc.fillColor(C.ink).font("Helvetica-Bold").fontSize(13).text(t, { width: CONTENT_W });
    moveDown(0.12);
    const y = doc.y;
    doc.strokeColor(C.accent).lineWidth(0.75).moveTo(MARGIN, y).lineTo(MARGIN + CONTENT_W, y).stroke();
    moveDown(0.32);
  }

  function H3(t: string) {
    ensureSpace(32);
    doc.fillColor(C.accent).font("Helvetica-Bold").fontSize(10.5).text(t, { width: CONTENT_W });
    moveDown(0.15);
  }

  function bullet(text: string, indent = 8) {
    writeRichParagraph(`•  ${text}`, { indent });
  }

  function numbered(n: number, text: string) {
    writeRichParagraph(`${n}.  ${text}`, { indent: 4 });
  }

  function blockquote(text: string) {
    ensureSpace(40);
    const x = MARGIN;
    const pad = 10;
    const plain = stripInline(text);
    doc.font("Helvetica").fontSize(BODY_SIZE);
    const h = doc.heightOfString(plain, { width: CONTENT_W - pad * 2, lineGap: 1.3 });
    const boxH = h + pad * 2;
    const y0 = doc.y;
    doc.roundedRect(x, y0, CONTENT_W, boxH, 4).fillColor(C.quote).fill();
    doc.fillColor(C.ink).font("Helvetica").fontSize(BODY_SIZE);
    doc.text(plain, x + pad, y0 + pad, { width: CONTENT_W - pad * 2, lineGap: 1.3 });
    doc.y = y0 + boxH;
    moveDown(0.35);
  }

  function codeBlock(lines: string[], label?: string) {
    ensureSpace(50);
    if (label) {
      doc.fillColor(C.sub).font("Helvetica-Bold").fontSize(8).text(label, { width: CONTENT_W });
      moveDown(0.1);
    }
    const body = lines.join("\n");
    doc.font("Courier").fontSize(CODE_SIZE);
    const h = doc.heightOfString(body, { width: CONTENT_W - 16, lineGap: 1.1 });
    const boxH = h + 14;
    const y0 = doc.y;
    doc.roundedRect(MARGIN, y0, CONTENT_W, boxH, 3).fillColor(C.panel).fill();
    doc.fillColor(C.ink).font("Courier").fontSize(CODE_SIZE);
    doc.text(body, MARGIN + 8, y0 + 7, { width: CONTENT_W - 16, lineGap: 1.1 });
    doc.y = y0 + boxH;
    moveDown(0.35);
  }

  function diagramPlaceholder() {
    ensureSpace(36);
    blockquote(
      "This section includes a technical architecture diagram. The surrounding text and tables describe the same components and data flows.",
    );
  }

  function parseTableRow(line: string): string[] {
    return line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => stripInline(c.trim()));
  }

  function isTableSeparator(line: string): boolean {
    return /^\|[\s:|-]+\|$/.test(line.trim());
  }

  function drawTable(header: string[], rows: string[][]) {
    if (header.length === 0) return;
    const cols = header.length;
    const colWidths: number[] = [];
    const minW = 48;
    const maxW = CONTENT_W / Math.min(cols, 3);
    for (let c = 0; c < cols; c++) {
      let w = minW;
      for (const row of [header, ...rows]) {
        const cell = row[c] ?? "";
        doc.font("Helvetica-Bold").fontSize(8);
        w = Math.max(w, Math.min(doc.widthOfString(cell) + 12, maxW));
      }
      colWidths.push(w);
    }
    const total = colWidths.reduce((a, b) => a + b, 0);
    if (total > CONTENT_W) {
      const scale = CONTENT_W / total;
      for (let i = 0; i < colWidths.length; i++) colWidths[i]! *= scale;
    }

    const rowH = 16;
    const drawRow = (cells: string[], bold: boolean) => {
      ensureSpace(rowH + 4);
      const y0 = doc.y;
      let x = MARGIN;
      for (let c = 0; c < cols; c++) {
        const w = colWidths[c]!;
        doc
          .rect(x, y0, w, rowH)
          .fillColor(bold ? C.panel : "#ffffff")
          .fill()
          .strokeColor(C.rule)
          .lineWidth(0.5)
          .rect(x, y0, w, rowH)
          .stroke();
        doc
          .fillColor(C.ink)
          .font(bold ? "Helvetica-Bold" : "Helvetica")
          .fontSize(7.5)
          .text(cells[c] ?? "", x + 4, y0 + 4, { width: w - 8, height: rowH - 6, ellipsis: true });
        x += w;
      }
      doc.y = y0 + rowH;
    };

    drawRow(header, true);
    for (const row of rows) drawRow(row, false);
    moveDown(0.4);
  }

  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  let h1Done = false;

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (trimmed === "" || trimmed === "---") {
      i++;
      continue;
    }

    if (trimmed.startsWith("```")) {
      const lang = trimmed.slice(3).trim().toLowerCase();
      i++;
      const codeLines: string[] = [];
      while (i < lines.length && !lines[i]!.trim().startsWith("```")) {
        codeLines.push(lines[i]!);
        i++;
      }
      if (lang === "mermaid") {
        diagramPlaceholder();
      } else if (codeLines.length > 0) {
        codeBlock(codeLines, lang ? undefined : undefined);
      }
      i++;
      continue;
    }

    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith("|")) {
        tableLines.push(lines[i]!.trim());
        i++;
      }
      const dataRows = tableLines.filter((l) => !isTableSeparator(l));
      if (dataRows.length > 0) {
        const header = parseTableRow(dataRows[0]!);
        const body = dataRows.slice(1).map(parseTableRow);
        drawTable(header, body);
      }
      continue;
    }

    if (trimmed.startsWith("# ")) {
      const t = stripInline(trimmed.slice(2));
      if (!h1Done) {
        H1(t);
        h1Done = true;
      } else {
        H2(t);
      }
      i++;
      continue;
    }

    if (trimmed.startsWith("## ")) {
      H2(stripInline(trimmed.slice(3)));
      i++;
      continue;
    }

    if (trimmed.startsWith("### ")) {
      H3(stripInline(trimmed.slice(4)));
      i++;
      continue;
    }

    if (trimmed.startsWith("> ")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith("> ")) {
        quoteLines.push(lines[i]!.trim().replace(/^>\s?/, ""));
        i++;
      }
      blockquote(quoteLines.join(" "));
      continue;
    }

    const bulletMatch = trimmed.match(/^[-*]\s+(.+)$/);
    if (bulletMatch) {
      bullet(bulletMatch[1]!);
      i++;
      continue;
    }

    const numMatch = trimmed.match(/^\d+\.\s+(.+)$/);
    if (numMatch) {
      const n = parseInt(trimmed, 10) || 1;
      numbered(n, numMatch[1]!);
      i++;
      continue;
    }

    const paraLines: string[] = [line];
    i++;
    while (i < lines.length) {
      const next = lines[i]!.trim();
      if (
        next === "" ||
        next === "---" ||
        next.startsWith("#") ||
        next.startsWith("|") ||
        next.startsWith("```") ||
        next.startsWith("> ") ||
        /^[-*]\s+/.test(next) ||
        /^\d+\.\s+/.test(next)
      ) {
        break;
      }
      paraLines.push(lines[i]!);
      i++;
    }
    writeRichParagraph(paraLines.join(" "));
  }

  if (pageNumbers) {
    const range = doc.bufferedPageRange();
    for (let p = 0; p < range.count; p++) {
      doc.switchToPage(p);
      doc
        .fillColor(C.muted)
        .font("Helvetica")
        .fontSize(8)
        .text(`Page ${p + 1} of ${range.count}`, MARGIN, 738, {
          align: "center",
          width: CONTENT_W,
        });
    }
  }

  doc.end();
}

export function convertDocsDirectory(
  docsDir: string,
  outDir: string,
  filter?: (name: string) => boolean,
): string[] {
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  const files = readdirSync(docsDir)
    .filter((f) => f.endsWith(".md"))
    .filter((f) => (filter ? filter(f) : true))
    .sort();

  for (const file of files) {
    const input = join(docsDir, file);
    const base = kebabToPdfBasename(file.replace(/\.md$/, ""));
    const output = join(outDir, `${base}.pdf`);
    markdownFileToPdf(input, output);
    written.push(output);
    console.log(`Wrote ${output}`);
  }
  return written;
}
