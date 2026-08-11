// Button-driven ClassLink school onboarding (Administration → ClassLink Sync
// → Check for new schools). Exercises the discover → onboard → re-discover
// cycle against the OneRoster fixture bundle (one school org: D. S. Parrott,
// identifier 0241):
//   1. a feed org with no Pulse school/integration is reported as NEW,
//   2. onboarding it creates the school + classlink integration rows,
//   3. a second discovery sees it as existing (nothing new),
//   4. re-onboarding is rejected (no duplicate school row), and
//   5. a Pulse school whose state code matches under prefix-tolerant lookup
//      (ENT0241) is treated as existing even with no integration row —
//      the Wilton duplicate-org lesson.
// Requires DATABASE_URL; skipped otherwise. This suite deletes ALL classlink
// integrations to control the discovery diff, and sisSyncPlanningCollision
// drives a sync off one — vitest runs files in parallel, so the two would race
// over the same fixture school (code 0241). Both declare the same sequence
// group to force them to run one after the other.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, and, sql } from "drizzle-orm";

const HAS_DB = !!process.env.DATABASE_URL;

const PARROTT_ORG = "org-parrott-0241";
const PARROTT_CODE = "0241";
const SEED_INTEGRATION = "ZZ Onboarding Discovery Seed";

describe.skipIf(!HAS_DB)("ClassLink school onboarding (button flow)", () => {
  let db: typeof import("@workspace/db").db;
  let schoolsTable: typeof import("@workspace/db").schoolsTable;
  let districtsTable: typeof import("@workspace/db").districtsTable;
  let districtIntegrationsTable: typeof import("@workspace/db").districtIntegrationsTable;
  let lib: typeof import("../lib/sisSchoolOnboarding");
  let districtId: number;

  async function cleanClasslinkRows(): Promise<void> {
    await db
      .delete(districtIntegrationsTable)
      .where(eq(districtIntegrationsTable.sisProvider, "classlink"));
    await db
      .delete(schoolsTable)
      .where(eq(schoolsTable.stateSchoolCode, PARROTT_CODE));
    await db
      .delete(schoolsTable)
      .where(eq(schoolsTable.stateSchoolCode, `ENT${PARROTT_CODE}`));
  }

  beforeAll(async () => {
    const dbMod = await import("@workspace/db");
    db = dbMod.db;
    schoolsTable = dbMod.schoolsTable;
    districtsTable = dbMod.districtsTable;
    districtIntegrationsTable = dbMod.districtIntegrationsTable;
    lib = await import("../lib/sisSchoolOnboarding");

    // testSchemaSync.mts creates tables but intentionally skips indexes; the
    // onboarding upsert targets these two unique constraints, which exist in
    // prod via drizzle push. Recreate them here so the real code path runs.
    await db.execute(
      sql`CREATE UNIQUE INDEX IF NOT EXISTS districts_slug_unique ON districts (slug)`,
    );
    await db.execute(
      sql`CREATE UNIQUE INDEX IF NOT EXISTS schools_district_state_code_unique ON schools (district_id, state_school_code)`,
    );

    const [district] = await db
      .insert(districtsTable)
      .values({
        name: "Onboarding Test District",
        slug: "onboarding-test-district",
        stateDistrictCode: "99",
      })
      .onConflictDoUpdate({
        target: districtsTable.slug,
        set: { name: "Onboarding Test District" },
      })
      .returning({ id: districtsTable.id });
    districtId = district!.id;

    await cleanClasslinkRows();
    // Discovery reads its adapter config off an existing classlink row;
    // useFixtures pins the test to the bundled OneRoster fixtures regardless
    // of CLASSLINK_MOCK / live-credential env.
    await db.insert(districtIntegrationsTable).values({
      schoolName: SEED_INTEGRATION,
      sisProvider: "classlink",
      sisConfig: { useFixtures: true },
    });
  });

  afterAll(async () => {
    if (!db) return;
    await cleanClasslinkRows();
    await db
      .delete(districtsTable)
      .where(eq(districtsTable.slug, "onboarding-test-district"));
  });

  it("reports a feed org with no Pulse school as new", async () => {
    const d = await lib.discoverNewClasslinkSchools();
    expect(d.usingFixtures).toBe(true);
    expect(d.totalFeedSchools).toBe(1);
    expect(d.newSchools.map((o) => o.sourcedId)).toEqual([PARROTT_ORG]);
    expect(d.newSchools[0]!.stateCode).toBe(PARROTT_CODE);
    expect(d.existingCount).toBe(0);
  });

  it("onboards the selected org: school + integration rows created", async () => {
    const r = await lib.onboardClasslinkSchools({
      sourcedIds: [PARROTT_ORG],
      districtId,
    });
    expect(r.ok).toBe(true);
    expect(r.rejected).toEqual([]);
    expect(r.onboarded).toHaveLength(1);
    expect(r.onboarded[0]).toMatchObject({
      stateCode: PARROTT_CODE,
      sourcedId: PARROTT_ORG,
    });

    const schools = await db
      .select()
      .from(schoolsTable)
      .where(
        and(
          eq(schoolsTable.districtId, districtId),
          eq(schoolsTable.stateSchoolCode, PARROTT_CODE),
        ),
      );
    expect(schools).toHaveLength(1);
    expect(schools[0]!.name).toBe("D. S. Parrott Middle School");

    const integrations = await db
      .select()
      .from(districtIntegrationsTable)
      .where(
        and(
          eq(districtIntegrationsTable.schoolName, "D. S. Parrott Middle School"),
          eq(districtIntegrationsTable.sisProvider, "classlink"),
        ),
      );
    expect(integrations).toHaveLength(1);
    const cfg = integrations[0]!.sisConfig as Record<string, unknown>;
    expect(cfg.schoolOrgSourcedId).toBe(PARROTT_ORG);
    expect(cfg.stateSchoolCode).toBe(PARROTT_CODE);
  });

  it("second discovery sees the onboarded school as existing", async () => {
    const d = await lib.discoverNewClasslinkSchools();
    expect(d.newSchools).toEqual([]);
    expect(d.existingCount).toBe(1);
  });

  it("re-onboarding the same org is rejected without creating duplicates", async () => {
    const r = await lib.onboardClasslinkSchools({
      sourcedIds: [PARROTT_ORG],
      districtId,
    });
    expect(r.ok).toBe(false);
    expect(r.onboarded).toEqual([]);
    expect(r.rejected).toHaveLength(1);

    const schools = await db
      .select()
      .from(schoolsTable)
      .where(
        and(
          eq(schoolsTable.districtId, districtId),
          eq(schoolsTable.stateSchoolCode, PARROTT_CODE),
        ),
      );
    expect(schools).toHaveLength(1);
  });

  it("matches existing schools by prefix-tolerant state code (ENT0241 ≡ 0241)", async () => {
    // Reset to: no integration, and the Pulse school stored with an ENT-prefixed
    // code — discovery must still treat the feed org as existing, not new.
    await cleanClasslinkRows();
    await db.insert(districtIntegrationsTable).values({
      schoolName: SEED_INTEGRATION,
      sisProvider: "classlink",
      sisConfig: { useFixtures: true },
    });
    await db.insert(schoolsTable).values({
      districtId,
      name: "Parrott (prefixed code variant)",
      shortName: "Parrott",
      stateSchoolCode: `ENT${PARROTT_CODE}`,
    });

    const d = await lib.discoverNewClasslinkSchools();
    expect(d.newSchools).toEqual([]);
    expect(d.existingCount).toBe(1);
  });
});
