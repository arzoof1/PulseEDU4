// Robust xlsx → grid reader.
//
// Primary path: exceljs. Fallback path: a dependency-free minimal
// XLSX reader (zip via node:zlib + namespace-agnostic XML scanning).
//
// Why the fallback exists: in Aug 2026 the Florida FAST portal began
// generating "minimal" xlsx files (namespace-prefixed `<x:workbook>`,
// non-standard relationship ids, no styles/sharedStrings parts, cells
// without r="A1" refs). exceljs 4.x fails to open these with
// "Cannot read properties of undefined (reading 'sheets')". The files
// are valid OOXML, so we parse them ourselves when exceljs gives up.

import * as zlib from "node:zlib";
import ExcelJS from "exceljs";

export type XlsxGridResult =
  | { ok: true; grid: unknown[][] }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Minimal ZIP reader (STORE + DEFLATE entries only — all xlsx writers
// use these). Reads the central directory from the end of the file.
// ---------------------------------------------------------------------------
// Safety budgets — an xlsx we care about has ~5-30 entries and a few
// MB of XML. Anything beyond these limits is rejected with a clean
// parse error instead of inflating attacker-controlled data unbounded.
const MAX_ZIP_ENTRIES = 200;
const MAX_ENTRY_BYTES = 100 * 1024 * 1024; // 100 MB per entry
const MAX_TOTAL_BYTES = 300 * 1024 * 1024; // 300 MB aggregate

function readZipEntries(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let totalOut = 0;
  // Locate End Of Central Directory record (signature 0x06054b50),
  // scanning backwards past any zip comment (max 64KB).
  const minEocd = 22;
  let eocd = -1;
  const scanStart = Math.max(0, buf.length - minEocd - 65536);
  for (let i = buf.length - minEocd; i >= scanStart; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file (no central directory)");
  const count = buf.readUInt16LE(eocd + 10);
  if (count > MAX_ZIP_ENTRIES) {
    throw new Error(`too many zip entries (${count})`);
  }
  let ptr = buf.readUInt32LE(eocd + 16); // central directory offset
  for (let n = 0; n < count; n++) {
    if (ptr < 0 || ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== 0x02014b50) {
      throw new Error("corrupt central directory");
    }
    const flags = buf.readUInt16LE(ptr + 8);
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const uncompSize = buf.readUInt32LE(ptr + 24);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    if (flags & 0x1) throw new Error("encrypted zip entries are not supported");
    // 0xFFFFFFFF sizes/offsets signal ZIP64 — out of scope, reject cleanly.
    if (
      compSize === 0xffffffff ||
      uncompSize === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      throw new Error("ZIP64 archives are not supported");
    }
    if (uncompSize > MAX_ENTRY_BYTES) {
      throw new Error("zip entry too large");
    }
    totalOut += uncompSize;
    if (totalOut > MAX_TOTAL_BYTES) {
      throw new Error("zip expands beyond the allowed size budget");
    }
    const name = buf.toString("utf8", ptr + 46, ptr + 46 + nameLen);
    // Local header: skip its (possibly different) name/extra lengths.
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error("corrupt local file header");
    }
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    if (dataStart + compSize > buf.length) {
      throw new Error("zip entry data out of range");
    }
    const raw = buf.subarray(dataStart, dataStart + compSize);
    if (method === 0) {
      if (raw.length > MAX_ENTRY_BYTES) throw new Error("zip entry too large");
      out.set(name, Buffer.from(raw));
    } else if (method === 8) {
      // maxOutputLength hard-caps decompression at the declared size —
      // a lying header (zip bomb) throws instead of allocating more.
      out.set(
        name,
        zlib.inflateRawSync(raw, {
          maxOutputLength: Math.min(uncompSize || MAX_ENTRY_BYTES, MAX_ENTRY_BYTES),
        }),
      );
    } else {
      throw new Error(`unsupported zip compression method ${method}`);
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Namespace-agnostic XML helpers (regex-based; the OOXML subset we
// read — sheetData rows/cells — is regular enough for this).
// ---------------------------------------------------------------------------
function decodeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function colRefToIndex(ref: string): number | null {
  const m = /^([A-Z]+)\d+$/i.exec(ref);
  if (!m) return null;
  let n = 0;
  for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1; // 0-based
}

function parseSharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  const out: string[] = [];
  // Each <si> may hold a single <t> or multiple rich-text runs.
  const siRe = /<(?:\w+:)?si[\s>][\s\S]*?<\/(?:\w+:)?si>/g;
  const tRe = /<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g;
  for (const si of xml.match(siRe) ?? []) {
    let text = "";
    let m: RegExpExecArray | null;
    tRe.lastIndex = 0;
    while ((m = tRe.exec(si)) !== null) text += decodeXml(m[1]);
    out.push(text);
  }
  return out;
}

function fallbackParseGrid(buf: Buffer): unknown[][] {
  const entries = readZipEntries(buf);
  // Resolve the first sheet target from workbook rels when possible,
  // else take the first xl/worksheets/*.xml entry.
  let sheetPath: string | null = null;
  const rels = entries.get("xl/_rels/workbook.xml.rels")?.toString("utf8");
  if (rels) {
    const m =
      /<Relationship[^>]*Type="[^"]*\/worksheet"[^>]*Target="([^"]+)"/.exec(rels) ||
      /<Relationship[^>]*Target="([^"]+)"[^>]*Type="[^"]*\/worksheet"/.exec(rels);
    if (m) {
      const t = m[1];
      sheetPath = t.startsWith("/") ? t.slice(1) : t.startsWith("xl/") ? t : `xl/${t}`;
    }
  }
  if (!sheetPath || !entries.has(sheetPath)) {
    sheetPath =
      [...entries.keys()]
        .filter((k) => /^xl\/worksheets\/[^/]+\.xml$/.test(k))
        .sort()[0] ?? null;
  }
  if (!sheetPath) throw new Error("no worksheet found in xlsx");
  const sheetXml = entries.get(sheetPath)!.toString("utf8");
  const shared = parseSharedStrings(
    entries.get("xl/sharedStrings.xml")?.toString("utf8") ?? null,
  );

  const grid: unknown[][] = [];
  const rowRe = /<(?:\w+:)?row(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?row>|<(?:\w+:)?row(?:\s[^>]*)?\/>/g;
  const cellRe =
    /<(?:\w+:)?c((?:\s[^>]*)?)>([\s\S]*?)<\/(?:\w+:)?c>|<(?:\w+:)?c((?:\s[^>]*)?)\/>/g;
  const vRe = /<(?:\w+:)?v(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?v>/;
  const isTRe = /<(?:\w+:)?is[\s>][\s\S]*?<\/(?:\w+:)?is>/;
  const tRe = /<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g;

  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(sheetXml)) !== null) {
    const inner = rowMatch[1] ?? "";
    const row: unknown[] = [];
    let seq = 0;
    let cellMatch: RegExpExecArray | null;
    cellRe.lastIndex = 0;
    while ((cellMatch = cellRe.exec(inner)) !== null) {
      const attrs = cellMatch[1] ?? cellMatch[3] ?? "";
      const body = cellMatch[2] ?? "";
      const refMatch = /\br="([A-Z]+\d+)"/i.exec(attrs);
      const idx = refMatch ? (colRefToIndex(refMatch[1]) ?? seq) : seq;
      const typeMatch = /\bt="([^"]+)"/.exec(attrs);
      const t = typeMatch ? typeMatch[1] : "";
      let value: unknown = "";
      if (t === "inlineStr") {
        const is = isTRe.exec(body)?.[0] ?? "";
        let text = "";
        let tm: RegExpExecArray | null;
        tRe.lastIndex = 0;
        while ((tm = tRe.exec(is)) !== null) text += decodeXml(tm[1]);
        value = text;
      } else {
        const v = vRe.exec(body)?.[1];
        if (v === undefined) {
          value = "";
        } else if (t === "s") {
          value = shared[Number(v)] ?? "";
        } else if (t === "str" || t === "e") {
          value = decodeXml(v);
        } else if (t === "b") {
          value = v === "1";
        } else {
          const n = Number(decodeXml(v));
          value = Number.isFinite(n) && v.trim() !== "" ? n : decodeXml(v);
        }
      }
      row[idx] = value;
      seq = idx + 1;
    }
    grid.push(row);
  }
  return grid;
}

// ---------------------------------------------------------------------------
// Public entry: exceljs first, minimal reader as fallback.
// ---------------------------------------------------------------------------
export async function xlsxToGrid(buffer: Buffer): Promise<XlsxGridResult> {
  let primaryError: string | null = null;
  try {
    const wb = new ExcelJS.Workbook();
    const ab = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    );
    await wb.xlsx.load(ab as ArrayBuffer);
    const ws = wb.worksheets[0];
    if (ws) {
      const grid: unknown[][] = [];
      for (let r = 1; r <= ws.rowCount; r++) {
        const rowVals: unknown[] = [];
        const row = ws.getRow(r);
        for (let c = 1; c <= ws.columnCount; c++) {
          rowVals.push(row.getCell(c).value);
        }
        grid.push(rowVals);
      }
      return { ok: true, grid };
    }
    primaryError = "no worksheet";
  } catch (e) {
    primaryError = (e as Error).message;
  }
  // Fallback: minimal OOXML reader (handles the 2026 Florida FAST
  // portal's stripped-down xlsx that exceljs cannot open).
  try {
    const grid = fallbackParseGrid(buffer);
    if (grid.length === 0) {
      return { ok: false, error: "xlsx contains no rows" };
    }
    return { ok: true, grid };
  } catch (e) {
    return {
      ok: false,
      error: `${primaryError ?? "unreadable"}; fallback reader: ${(e as Error).message}`,
    };
  }
}
