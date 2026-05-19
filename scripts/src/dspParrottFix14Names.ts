import { db, pool, studentsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import ExcelJS from "exceljs";
import { promises as fs } from "node:fs";
import path from "node:path";

const REPO = "/home/runner/workspace";
const INV = path.join(REPO, ".local", "dsp-reseed", "file-inventory.json");
const ASSETS = path.join(REPO, "attached_assets");

function cellStr(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  if (v instanceof Date) return "";
  if (typeof v === "object" && v !== null) {
    const o = v as { richText?: unknown; text?: unknown; result?: unknown };
    if (Array.isArray(o.richText)) {
      return o.richText.map((r) => {
        const rt = r as { text?: unknown };
        return typeof rt?.text === "string" ? rt.text : "";
      }).join("").trim();
    }
    if (typeof o.text === "string") return o.text.trim();
    if (typeof o.result === "string") return o.result.trim();
  }
  return "";
}

const targets = new Set(['FL000002628180','FL000006518874','FL000007164731','FL000012425586','FL000006351835','FL000007398400','FL000012423775','FL000009546133','FL000008076121','FL000007132696','FL000007013411','FL000005054360','FL000012414029','FL000012391057']);

async function main() {
  const inv = JSON.parse(await fs.readFile(INV, "utf8")) as Array<{ f: string }>;
  const found = new Map<string, { first: string; last: string }>();
  for (const it of inv) {
    if (found.size === targets.size) break;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path.join(ASSETS, it.f));
    const ws = wb.worksheets[0];
    if (!ws) continue;
    const hdr = ws.getRow(1);
    const headers: string[] = [];
    for (let c = 1; c <= ws.columnCount; c++) headers.push(cellStr(hdr.getCell(c).value));
    const idxSid = headers.findIndex((h) => /^student id$/i.test(h));
    const idxFirst = headers.findIndex((h) => /^first name$|^student first/i.test(h));
    const idxLast = headers.findIndex((h) => /^last name$|^student last/i.test(h));
    const idxFull = headers.findIndex((h) => /^student name$|^full name$|^name$/i.test(h));
    if (idxSid < 0) continue;
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const sid = cellStr(row.getCell(idxSid + 1).value);
      if (!targets.has(sid) || found.has(sid)) continue;
      let first = "", last = "";
      if (idxFirst >= 0 && idxLast >= 0) {
        first = cellStr(row.getCell(idxFirst + 1).value);
        last = cellStr(row.getCell(idxLast + 1).value);
      } else if (idxFull >= 0) {
        const full = cellStr(row.getCell(idxFull + 1).value);
        if (full.includes(",")) { const [l, f] = full.split(",", 2); last = (l ?? "").trim(); first = (f ?? "").trim(); }
        else if (full) last = full;
      }
      if (first || last) found.set(sid, { first: first || "Student", last: last || sid });
    }
  }
  console.log(`found ${found.size}/${targets.size}`);
  for (const [sid, n] of found) {
    console.log(`  ${sid} -> ${n.last}, ${n.first}`);
    await db.update(studentsTable).set({ firstName: n.first, lastName: n.last })
      .where(and(eq(studentsTable.schoolId, 1), eq(studentsTable.studentId, sid)));
  }
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
