/* Minimal markdown -> PDF renderer for the teleprompter dev guide.
   Handles: h1/h2/h3, paragraphs, bullet lists, blockquotes, fenced code
   blocks, and simple pipe tables. Built-in fonts are WinAnsi-only, so we
   replace glyphs they can't render (→ • ✓ —). */
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

const [, , inPath, outPath] = process.argv;
const src = fs.readFileSync(inPath, "utf8");

function sanitize(s) {
  return s
    .replace(/\u2192/g, "->")
    .replace(/\u2022/g, "-")
    .replace(/\u2713/g, "[x]")
    .replace(/\u2014/g, "-")
    .replace(/\u2013/g, "-")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

const doc = new PDFDocument({ size: "LETTER", margin: 54 });
doc.pipe(fs.createWriteStream(outPath));

const PAGE_W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
const X = doc.page.margins.left;

function space(h) {
  if (doc.y + h > doc.page.height - doc.page.margins.bottom) doc.addPage();
}

function heading(text, size, gapTop) {
  doc.moveDown(gapTop ? 0.6 : 0);
  space(size + 10);
  doc.font("Helvetica-Bold").fontSize(size).fillColor("#0f172a");
  doc.text(sanitize(text), X, doc.y, { width: PAGE_W });
  doc.moveDown(0.35);
}

function paragraph(text) {
  space(20);
  doc.font("Helvetica").fontSize(10.5).fillColor("#1f2937");
  doc.text(sanitize(text), X, doc.y, { width: PAGE_W, align: "left" });
  doc.moveDown(0.4);
}

function bullet(text, indent) {
  space(18);
  const ix = X + 12 + (indent ? 16 : 0);
  doc.font("Helvetica").fontSize(10.5).fillColor("#1f2937");
  const y = doc.y;
  doc.text("-", X + (indent ? 16 : 0), y);
  doc.text(sanitize(text), ix, y, { width: PAGE_W - 12 - (indent ? 16 : 0) });
  doc.moveDown(0.2);
}

function blockquote(text) {
  space(20);
  const top = doc.y;
  doc.font("Helvetica-Oblique").fontSize(10).fillColor("#475569");
  doc.text(sanitize(text), X + 14, top, { width: PAGE_W - 14 });
  const bottom = doc.y;
  doc.save().rect(X, top - 2, 3, bottom - top + 4).fill("#94a3b8").restore();
  doc.fillColor("#1f2937");
  doc.moveDown(0.4);
}

function codeBlock(lines) {
  doc.font("Courier").fontSize(8.5);
  const lh = 11;
  const padding = 8;
  // paginate the block by chunks that fit the page
  let i = 0;
  while (i < lines.length) {
    const avail = doc.page.height - doc.page.margins.bottom - doc.y - padding * 2;
    let canFit = Math.max(1, Math.floor(avail / lh));
    if (avail < lh * 2) {
      doc.addPage();
      continue;
    }
    const chunk = lines.slice(i, i + canFit);
    const blockH = chunk.length * lh + padding * 2;
    doc.save().rect(X, doc.y, PAGE_W, blockH).fill("#f1f5f9").restore();
    let ty = doc.y + padding;
    doc.fillColor("#0f172a");
    for (const ln of chunk) {
      doc.text(sanitize(ln) || " ", X + padding, ty, {
        width: PAGE_W - padding * 2,
        lineBreak: false,
      });
      ty += lh;
    }
    doc.y = doc.y + blockH;
    i += chunk.length;
  }
  doc.moveDown(0.5);
  doc.fillColor("#1f2937");
}

function table(rows) {
  // rows: array of arrays of cell strings (first row = header)
  const cols = rows[0].length;
  const colW = PAGE_W / cols;
  const padding = 5;
  doc.fontSize(9);
  rows.forEach((cells, r) => {
    const isHeader = r === 0;
    doc.font(isHeader ? "Helvetica-Bold" : "Helvetica");
    // measure row height
    let rowH = 0;
    const heights = cells.map((c) => {
      const h = doc.heightOfString(sanitize(c), { width: colW - padding * 2 });
      return h;
    });
    rowH = Math.max(...heights) + padding * 2;
    space(rowH);
    const top = doc.y;
    if (isHeader) doc.save().rect(X, top, PAGE_W, rowH).fill("#e2e8f0").restore();
    doc.fillColor("#0f172a");
    cells.forEach((c, ci) => {
      doc.text(sanitize(c), X + ci * colW + padding, top + padding, {
        width: colW - padding * 2,
      });
    });
    // borders
    doc.save().lineWidth(0.5).strokeColor("#cbd5e1");
    doc.rect(X, top, PAGE_W, rowH).stroke();
    for (let ci = 1; ci < cols; ci++) {
      doc.moveTo(X + ci * colW, top).lineTo(X + ci * colW, top + rowH).stroke();
    }
    doc.restore();
    doc.y = top + rowH;
  });
  doc.moveDown(0.5);
  doc.fillColor("#1f2937");
}

const lines = src.split("\n");
let i = 0;
let pendingTable = null;

function flushTable() {
  if (!pendingTable) return;
  // drop the separator row (---) if present at index 1
  const rows = pendingTable.filter(
    (r) => !r.every((c) => /^:?-+:?$/.test(c.trim())),
  );
  if (rows.length) table(rows);
  pendingTable = null;
}

while (i < lines.length) {
  const line = lines[i];

  // fenced code block
  if (line.trim().startsWith("```")) {
    flushTable();
    const buf = [];
    i++;
    while (i < lines.length && !lines[i].trim().startsWith("```")) {
      buf.push(lines[i]);
      i++;
    }
    i++; // closing fence
    codeBlock(buf);
    continue;
  }

  // table rows
  if (/^\s*\|.*\|\s*$/.test(line)) {
    const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    pendingTable = pendingTable || [];
    pendingTable.push(cells);
    i++;
    continue;
  } else {
    flushTable();
  }

  if (/^#\s+/.test(line)) heading(line.replace(/^#\s+/, ""), 18, false);
  else if (/^##\s+/.test(line)) heading(line.replace(/^##\s+/, ""), 13.5, true);
  else if (/^###\s+/.test(line)) heading(line.replace(/^###\s+/, ""), 11.5, true);
  else if (/^\s*[-*]\s+/.test(line)) {
    const indent = /^\s{2,}/.test(line);
    bullet(line.replace(/^\s*[-*]\s+/, ""), indent);
  } else if (/^>\s?/.test(line)) blockquote(line.replace(/^>\s?/, ""));
  else if (/^---+\s*$/.test(line)) {
    space(12);
    doc.save().lineWidth(0.5).strokeColor("#cbd5e1")
      .moveTo(X, doc.y + 4).lineTo(X + PAGE_W, doc.y + 4).stroke().restore();
    doc.moveDown(0.6);
  } else if (line.trim() === "") {
    doc.moveDown(0.25);
  } else {
    paragraph(line);
  }
  i++;
}
flushTable();

doc.end();
console.log("Wrote", path.resolve(outPath));
