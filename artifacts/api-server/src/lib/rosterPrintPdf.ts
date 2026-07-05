// Printable class-roster PDF (staff-facing). Two purposes share one renderer:
//   • Teachers print/download their own roster for any period or the whole
//     day, optionally with write-in columns ("list" layout) or a grid of
//     empty boxes ("grid" layout) for tracking/tallies.
//   • Admins / Core Team print a chosen teacher's roster (by period or all
//     periods) for investigations / call-down records.
//
// Every roster is sorted A–Z by last name upstream. The visible identifier is
// ALWAYS the Local SIS id (never the FLEID-style student_id) — same boundary
// the ID badges enforce.
//
// pdfkit gotchas this file is careful about (see repo memory):
//   • Manual table drawing must repaint the column-header row on every new
//     page or overflow rows appear headerless.
//   • Absolute-positioned .text() with fixed width + lineBreak:false to keep
//     cells on one line and avoid phantom blank pages.

import PDFDocument from "pdfkit";

export interface RosterPrintStudent {
  lastName: string;
  firstName: string;
  localSisId: string | null;
  grade: number | null;
}

export interface RosterPrintGroup {
  // e.g. "Period 3" or "All Periods". Rendered as a section sub-header.
  periodLabel: string;
  students: RosterPrintStudent[];
}

export interface RosterPrintOptions {
  title: string;
  teacherName: string;
  schoolName?: string | null;
  // Optional one-line subtitle the user typed (e.g. class / subject).
  classLabel?: string | null;
  // Labeled blank fill-in lines under the header (e.g. "Week of", "Notes").
  headerFields: string[];
  layout: "list" | "grid";
  // "list" layout: extra write-in columns (each an empty labeled column).
  customColumns: string[];
  // "grid" layout: number of empty boxes per student row.
  boxCount: number;
  boxLabel?: string | null;
  // Pre-formatted printed date label.
  dateLabel: string;
}

interface Col {
  header: string;
  width: number;
  align: "left" | "center";
}

const MARGIN = 40;
const HEADER_ROW_H = 22;
const BODY_ROW_H = 24;
const BORDER = "#c7ccd6";
const HEADER_FILL = "#eef1f6";
const TEXT = "#1f2733";
const MUTED = "#5b6472";

function sanitize(s: string): string {
  // Strip control chars; collapse whitespace. Guards odd query input.
  return s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

function buildColumns(
  options: RosterPrintOptions,
  usableWidth: number,
): Col[] {
  const idxW = 26;
  const sisW = 74;
  const cols: Col[] = [];
  cols.push({ header: "#", width: idxW, align: "center" });

  const extra: Col[] =
    options.layout === "grid"
      ? Array.from({ length: options.boxCount }, () => ({
          header: "",
          width: 0,
          align: "center" as const,
        }))
      : options.customColumns.map((c) => ({
          header: c,
          width: 0,
          align: "left" as const,
        }));

  if (extra.length > 0) {
    // Fixed name columns, remainder shared by the extra columns.
    const lastW = 120;
    const firstW = 110;
    cols.push({ header: "Last Name", width: lastW, align: "left" });
    cols.push({ header: "First Name", width: firstW, align: "left" });
    cols.push({ header: "SIS ID", width: sisW, align: "left" });
    const used = idxW + lastW + firstW + sisW;
    const remainder = Math.max(60, usableWidth - used);
    const each = remainder / extra.length;
    for (const e of extra) cols.push({ ...e, width: each });
  } else {
    // No extra columns: stretch names across the page.
    cols.push({ header: "SIS ID", width: sisW, align: "left" });
    const nameArea = usableWidth - idxW - sisW;
    cols.splice(1, 0, {
      header: "Last Name",
      width: nameArea * 0.55,
      align: "left",
    });
    cols.splice(2, 0, {
      header: "First Name",
      width: nameArea * 0.45,
      align: "left",
    });
  }
  return cols;
}

export function renderRosterPrintPdf(
  groupsIn: RosterPrintGroup[],
  optionsIn: RosterPrintOptions,
): Promise<Buffer> {
  const options: RosterPrintOptions = {
    ...optionsIn,
    title: sanitize(optionsIn.title) || "Class Roster",
    teacherName: sanitize(optionsIn.teacherName),
    classLabel: optionsIn.classLabel ? sanitize(optionsIn.classLabel) : null,
    schoolName: optionsIn.schoolName ? sanitize(optionsIn.schoolName) : null,
    boxLabel: optionsIn.boxLabel ? sanitize(optionsIn.boxLabel) : null,
    headerFields: optionsIn.headerFields
      .map(sanitize)
      .filter((s) => s.length > 0),
    customColumns: optionsIn.customColumns
      .map(sanitize)
      .filter((s) => s.length > 0),
  };

  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
  });

  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const usableWidth = right - left;
  const bottom = doc.page.height - doc.page.margins.bottom;

  const cols = buildColumns(options, usableWidth);
  const tableWidth = cols.reduce((s, c) => s + c.width, 0);

  const drawColumnHeader = (y: number): number => {
    doc.save();
    doc.rect(left, y, tableWidth, HEADER_ROW_H).fill(HEADER_FILL);
    doc.restore();
    let x = left;
    doc.fillColor(TEXT).font("Helvetica-Bold").fontSize(9);
    for (const c of cols) {
      // Vertical borders.
      doc
        .save()
        .lineWidth(0.6)
        .strokeColor(BORDER)
        .rect(x, y, c.width, HEADER_ROW_H)
        .stroke()
        .restore();
      const label = c.header;
      if (label) {
        doc.text(label, x + 4, y + 6, {
          width: c.width - 8,
          align: c.align,
          lineBreak: false,
          ellipsis: true,
        });
      }
      x += c.width;
    }
    // Grid box group label (spanned) — drawn over the empty box headers.
    if (options.layout === "grid" && options.boxCount > 0 && options.boxLabel) {
      const boxStart = left + tableWidth - cols
        .slice(-options.boxCount)
        .reduce((s, c) => s + c.width, 0);
      const boxSpan = left + tableWidth - boxStart;
      doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(8).text(
        options.boxLabel,
        boxStart + 2,
        y + 7,
        { width: boxSpan - 4, align: "center", lineBreak: false, ellipsis: true },
      );
    }
    return y + HEADER_ROW_H;
  };

  const drawBodyRow = (
    y: number,
    idx: number,
    stu: RosterPrintStudent,
  ): number => {
    let x = left;
    doc.font("Helvetica").fontSize(10).fillColor(TEXT);
    const values: string[] = [
      String(idx),
      stu.lastName ?? "",
      stu.firstName ?? "",
      stu.localSisId ?? "",
    ];
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      doc
        .save()
        .lineWidth(0.6)
        .strokeColor(BORDER)
        .rect(x, y, c.width, BODY_ROW_H)
        .stroke()
        .restore();
      const v = i < values.length ? values[i] : "";
      if (v) {
        doc.text(v, x + 4, y + 7, {
          width: c.width - 8,
          align: c.align,
          lineBreak: false,
          ellipsis: true,
        });
      }
      x += c.width;
    }
    return y + BODY_ROW_H;
  };

  // ---- Page header (first page only) --------------------------------------
  let y = doc.page.margins.top;
  doc.fillColor(TEXT).font("Helvetica-Bold").fontSize(18);
  doc.text(options.title, left, y, { width: usableWidth, lineBreak: false });
  y += 24;

  doc.font("Helvetica").fontSize(10).fillColor(MUTED);
  const metaBits: string[] = [];
  if (options.teacherName) metaBits.push(options.teacherName);
  if (options.schoolName) metaBits.push(options.schoolName);
  metaBits.push(options.dateLabel);
  doc.text(metaBits.join("   •   "), left, y, {
    width: usableWidth,
    lineBreak: false,
  });
  y += 16;

  if (options.classLabel) {
    doc.fillColor(TEXT).fontSize(10).text(options.classLabel, left, y, {
      width: usableWidth,
      lineBreak: false,
    });
    y += 16;
  }

  // Labeled blank fill-in lines.
  for (const field of options.headerFields) {
    doc.fillColor(TEXT).font("Helvetica-Bold").fontSize(10);
    const labelText = `${field}: `;
    doc.text(labelText, left, y, { continued: false, lineBreak: false });
    const labelW = doc.widthOfString(labelText);
    doc
      .save()
      .lineWidth(0.6)
      .strokeColor(MUTED)
      .moveTo(left + labelW + 2, y + 12)
      .lineTo(right, y + 12)
      .stroke()
      .restore();
    y += 20;
  }

  y += 8;

  // ---- Groups -------------------------------------------------------------
  const groups = groupsIn.filter((g) => g.students.length > 0);
  const showGroupHeaders = groups.length > 1;

  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];

    // Ensure room for a group header + column header + one row.
    const needed =
      (showGroupHeaders ? 20 : 0) + HEADER_ROW_H + BODY_ROW_H;
    if (y + needed > bottom) {
      doc.addPage();
      y = doc.page.margins.top;
    }

    if (showGroupHeaders) {
      doc.fillColor(TEXT).font("Helvetica-Bold").fontSize(13);
      doc.text(
        `${g.periodLabel}  (${g.students.length})`,
        left,
        y,
        { width: usableWidth, lineBreak: false },
      );
      y += 20;
    }

    y = drawColumnHeader(y);

    for (let i = 0; i < g.students.length; i++) {
      if (y + BODY_ROW_H > bottom) {
        doc.addPage();
        y = doc.page.margins.top;
        y = drawColumnHeader(y);
      }
      y = drawBodyRow(y, i + 1, g.students[i]);
    }

    y += 18;
  }

  if (groups.length === 0) {
    doc.fillColor(MUTED).font("Helvetica").fontSize(11);
    doc.text("No students found for this selection.", left, y, {
      width: usableWidth,
    });
  }

  doc.end();
  return done;
}
