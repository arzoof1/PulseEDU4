import { db, locationsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

// A restroom area is a named group (e.g. "B-Wing") shared by the boys + girls
// variant location rows that sit in the same part of the building. Assigning
// the area to a teacher grants every variant in it at once.
export type RestroomArea = {
  area: string;
  // Location ids of every variant (boys/girls/other) carrying this area name.
  locationIds: number[];
  // Display names of those variants, for the admin grid + CSV preview.
  memberNames: string[];
  genders: string[];
};

type LocLite = {
  id: number;
  name: string;
  restroomArea: string | null;
  gender: string | null;
};

async function loadAreaLocations(schoolId: number): Promise<LocLite[]> {
  return db
    .select({
      id: locationsTable.id,
      name: locationsTable.name,
      restroomArea: locationsTable.restroomArea,
      gender: locationsTable.gender,
    })
    .from(locationsTable)
    .where(
      and(
        eq(locationsTable.schoolId, schoolId),
        eq(locationsTable.active, true),
      ),
    );
}

// Group this school's active restroom-area locations into one entry per area.
// Areas are sorted alpha-numerically; members sorted by name.
export async function loadRestroomAreas(
  schoolId: number,
): Promise<RestroomArea[]> {
  const locs = await loadAreaLocations(schoolId);
  const byArea = new Map<string, LocLite[]>();
  for (const l of locs) {
    const area = (l.restroomArea ?? "").trim();
    if (!area) continue;
    const list = byArea.get(area) ?? [];
    list.push(l);
    byArea.set(area, list);
  }
  const collator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
  });
  const out: RestroomArea[] = [];
  for (const [area, members] of byArea) {
    const sorted = [...members].sort((a, b) => collator.compare(a.name, b.name));
    out.push({
      area,
      locationIds: sorted.map((m) => m.id),
      memberNames: sorted.map((m) => m.name),
      genders: sorted
        .map((m) => (m.gender ?? "").trim())
        .filter((g) => g.length > 0),
    });
  }
  out.sort((a, b) => collator.compare(a.area, b.area));
  return out;
}

// Resolve a mix of destination NAMES + restroom-AREA names to concrete location
// ids. An area name (case-insensitive) expands to every variant id in it; a
// plain name resolves to that single location. Anything that matches neither is
// returned in `unmatched` so the caller can flag it loudly. Result ids are
// de-duplicated. Pass an optional `restroomOnly` flag to reject non-restroom
// matches (used by the self-serve guard is handled separately).
export async function resolveDestinationsToLocationIds(
  schoolId: number,
  names: string[],
): Promise<{ locationIds: number[]; unmatched: string[] }> {
  const locs = await loadAreaLocations(schoolId);
  const byName = new Map<string, number>();
  for (const l of locs) byName.set(l.name.trim().toLowerCase(), l.id);
  const areas = await loadRestroomAreas(schoolId);
  const byArea = new Map<string, number[]>();
  for (const a of areas) byArea.set(a.area.trim().toLowerCase(), a.locationIds);

  const ids = new Set<number>();
  const unmatched: string[] = [];
  for (const raw of names) {
    const key = raw.trim().toLowerCase();
    if (!key) continue;
    const areaIds = byArea.get(key);
    if (areaIds && areaIds.length > 0) {
      for (const id of areaIds) ids.add(id);
      continue;
    }
    const single = byName.get(key);
    if (single !== undefined) {
      ids.add(single);
      continue;
    }
    unmatched.push(raw.trim());
  }
  return { locationIds: Array.from(ids), unmatched };
}

// School-wide facility defaults (office/clinic/nurse) — granted to EVERY
// teacher automatically. Returns active destination-flagged ids/names so the
// kiosk can union them on top of the per-teacher list, and the client can mark
// them as always-available.
export async function loadSchoolWideDefaults(
  schoolId: number,
): Promise<{ id: number; name: string }[]> {
  return db
    .select({ id: locationsTable.id, name: locationsTable.name })
    .from(locationsTable)
    .where(
      and(
        eq(locationsTable.schoolId, schoolId),
        eq(locationsTable.schoolWideDefault, true),
        eq(locationsTable.active, true),
        eq(locationsTable.isDestination, true),
      ),
    );
}
