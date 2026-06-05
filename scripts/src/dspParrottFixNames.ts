/* eslint-disable no-console */
// One-shot: walk every FAST xlsx, find the best non-blank name per FLEID,
// and UPDATE students at school_id=1 whose name is still the FLEID fallback.
import { db, pool, studentsTable } from "@workspace/db";
import { and, eq, like } from "drizzle-orm";
import ExcelJS from "exceljs";
import { promises as fs } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const INV = path.join(REPO, ".local", "dsp-reseed", "file-inventory.json");
const ASSETS = path.join(REPO, "attached_assets");

function cellStr(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  if (v instanceof Date) return "";
  const o = v as { text?: unknown; result?: unknown };
  if (o && typeof o.text === "string") return o.text.trim();
  if (o && typeof o.result === "string") return o.result.trim();
  return String(v).trim();
}

async function main() {
  const inv = JSON.parse(await fs.readFile(INV, "utf8")) as Array<{ f: string }>;
  const best = new Map<string, { first: string; last: string }>();

  for (const it of inv) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path.join(ASSETS, it.f));
    const ws = wb.worksheets[0];
    if (!ws) continue;
    const hdr = ws.getRow(1);
    const headers: string[] = [];
    for (let c = 1; c <= ws.columnCount; c++) {
      headers.push(cellStr(hdr.getCell(c).value));
    }
    const idxSid = headers.findIndex((h) => /^student id$/i.test(h));
    const idxFirst = headers.findIndex((h) => /^first name$|^student first/i.test(h));
    const idxLast = headers.findIndex((h) => /^last name$|^student last/i.test(h));
    const idxFull = headers.findIndex(
      (h) => /^student name$|^full name$|^name$/i.test(h),
    );
    if (idxSid < 0) continue;
    console.log(`${it.f}: first=${idxFirst} last=${idxLast} full=${idxFull}`);
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const sid = cellStr(row.getCell(idxSid + 1).value);
      if (!sid || best.has(sid)) continue;
      let first = "";
      let last = "";
      if (idxFirst >= 0 && idxLast >= 0) {
        first = cellStr(row.getCell(idxFirst + 1).value);
        last = cellStr(row.getCell(idxLast + 1).value);
      } else if (idxFull >= 0) {
        const full = cellStr(row.getCell(idxFull + 1).value);
        if (full.includes(",")) {
          const [l, f] = full.split(",", 2);
          last = (l ?? "").trim();
          first = (f ?? "").trim();
        } else if (full) {
          last = full;
        }
      }
      // Reject the FLEID-only fallback shape
      if ((first && first !== "Student") || (last && !/^FL\d+$/.test(last))) {
        best.set(sid, { first: first || "Student", last: last || sid });
      }
    }
  }
  console.log(`distinct FLEIDs with real names: ${best.size}`);

  // Find students at school 1 still using FLEID fallback
  const needFix = await db
    .select({ id: studentsTable.id, studentId: studentsTable.studentId })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.schoolId, 1),
        eq(studentsTable.firstName, "Student"),
        like(studentsTable.lastName, "FL%"),
      ),
    );
  console.log(`students with fallback names at school 1: ${needFix.length}`);

  let fixed = 0;
  let stillMissing = 0;
  for (const s of needFix) {
    const nm = best.get(s.studentId);
    if (!nm) {
      stillMissing++;
      continue;
    }
    await db
      .update(studentsTable)
      .set({ firstName: nm.first, lastName: nm.last })
      .where(eq(studentsTable.id, s.id));
    fixed++;
  }
  console.log(`fixed: ${fixed}, still missing: ${stillMissing}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
