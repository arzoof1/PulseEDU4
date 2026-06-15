// Full benchmark description lookup.
//
// Joins caller-supplied benchmark codes against the GLOBAL
// `benchmark_descriptions` reference table (official FLDOE B.E.S.T. text).
// That table is deliberately not school-scoped — the wording for a given
// code is identical for every tenant — so the lookup is by code only.
//
// Codes that don't resolve (junk tokens like "N/A", multi-standard math
// composites, banded codes, or subjects whose text isn't loaded yet — e.g.
// Math before it ships) are simply omitted from the returned map; callers
// fall back to showing code/category.
import { db, benchmarkDescriptionsTable } from "@workspace/db";
import { inArray } from "drizzle-orm";

// Reduce a raw FAST/catalog code to the bare Florida benchmark code that
// matches `benchmark_descriptions.code`:
//   - strips the optional "STRAND|" prefix the FAST item file prepends
//     (e.g. "MA.7.NSO.1|MA.7.NSO.1.1" → "MA.7.NSO.1.1");
//   - rejects junk tokens ("N/A") and multi-standard composites joined by
//     " and " (no single description applies).
// Returns null when no single description could apply.
export function normalizeBenchmarkCode(raw: string): string | null {
  const code = (raw ?? "").trim();
  if (!code || code.toUpperCase() === "N/A") return null;
  if (/\s+and\s+/i.test(code)) return null;
  const i = code.lastIndexOf("|");
  const bare = (i >= 0 ? code.slice(i + 1) : code).trim();
  if (!bare || bare.toUpperCase() === "N/A") return null;
  return bare;
}

// Map of ORIGINAL code (exactly as it appears in the caller's rows) → full
// benchmark description text. Unresolved codes are omitted.
export async function loadBenchmarkDescriptions(
  codes: Iterable<string>,
): Promise<Map<string, string>> {
  // bare lookup code → original code(s) that normalized to it.
  const originalsByBare = new Map<string, string[]>();
  for (const original of codes) {
    const bare = normalizeBenchmarkCode(original);
    if (!bare) continue;
    const arr = originalsByBare.get(bare);
    if (arr) arr.push(original);
    else originalsByBare.set(bare, [original]);
  }
  const out = new Map<string, string>();
  const bareCodes = Array.from(originalsByBare.keys());
  if (bareCodes.length === 0) return out;

  const rows = await db
    .select({
      code: benchmarkDescriptionsTable.code,
      description: benchmarkDescriptionsTable.description,
    })
    .from(benchmarkDescriptionsTable)
    .where(inArray(benchmarkDescriptionsTable.code, bareCodes));

  for (const r of rows) {
    const originals = originalsByBare.get(r.code);
    if (!originals) continue;
    for (const original of originals) out.set(original, r.description);
  }
  return out;
}
