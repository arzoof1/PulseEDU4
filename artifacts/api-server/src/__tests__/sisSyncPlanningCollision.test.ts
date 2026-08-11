// Regression: Nature Coast Technical High sync failed outright with
//   "Failed query: insert into class_sections ..."
// Cause: rebuildSchedules deletes only is_planning=false rows, but planning
// rows still occupy the school-scoped unique key
// (school_id, teacher_staff_id, period, course_name). When the feed produced a
// section matching a surviving planning row, the multi-row VALUES insert hit
// the unique index, the whole transaction rolled back, and the school got NO
// roster at all (status "failed", zero students/sections).
//
// Guards both halves of the fix:
//   1. a colliding planning row no longer fails the sync — the feed section
//      reuses it and its enrollments still land, and
//   2. section identities are written via a conflict-tolerant upsert, so a
//      duplicate degrades to a reuse instead of aborting the school.
// Requires DATABASE_URL; skipped otherwise.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";

const HAS_DB = !!process.env.DATABASE_URL;

const PARROTT_ORG = "org-parrott-0241";
const PARROTT_CODE = "0241";

describe.skipIf(!HAS_DB)("SIS sync — planning-row unique collision", () => {
  let db: typeof import("@workspace/db").db;
  let schoolsTable: typeof import("@workspace/db").schoolsTable;
  let districtsTable: typeof import("@workspace/db").districtsTable;
  let staffTable: typeof import("@workspace/db").staffTable;
  let classSectionsTable: typeof import("@workspace/db").classSectionsTable;
  let staffDefaultsTable: typeof import("@workspace/db").staffDefaultsTable;
  let districtIntegrationsTable: typeof import("@workspace/db").districtIntegrationsTable;
  let runSisSync: typeof import("../lib/sisRosterSync").runSisSync;
  let schoolId: number;
  let integrationRow: import("@workspace/db").DistrictIntegrationRow;

  // testSchemaSync creates tables but deliberately skips indexes, and other
  // DB-backed suites drop/recreate these tables mid-run — so re-assert every
  // unique key the sync's upserts target before each test, not just once.
  async function ensureSyncIndexes(): Promise<void> {
    for (const stmt of [
      sql`CREATE UNIQUE INDEX IF NOT EXISTS class_sections_school_teacher_period_course_unique ON class_sections (school_id, teacher_staff_id, period, course_name)`,
      sql`CREATE UNIQUE INDEX IF NOT EXISTS districts_slug_unique ON districts (slug)`,
      sql`CREATE UNIQUE INDEX IF NOT EXISTS schools_district_state_code_unique ON schools (district_id, state_school_code)`,
      sql`CREATE UNIQUE INDEX IF NOT EXISTS staff_email_unique ON staff (email)`,
      sql`CREATE UNIQUE INDEX IF NOT EXISTS students_student_id_unique ON students (student_id)`,
      sql`CREATE UNIQUE INDEX IF NOT EXISTS section_roster_section_student_unique ON section_roster (section_id, student_id)`,
      // PARTIAL index — must match the schema's predicate exactly or Postgres
      // will not use it as an ON CONFLICT (staff_id) arbiter.
      sql`DROP INDEX IF EXISTS staff_defaults_staff_id_unique`,
      sql`CREATE UNIQUE INDEX IF NOT EXISTS staff_defaults_staff_id_unique ON staff_defaults (staff_id) WHERE staff_id IS NOT NULL`,
      sql`CREATE UNIQUE INDEX IF NOT EXISTS staff_defaults_staff_name_unique ON staff_defaults (staff_name)`,
    ]) {
      await db.execute(stmt);
    }
  }

  beforeAll(async () => {
    const dbMod = await import("@workspace/db");
    db = dbMod.db;
    schoolsTable = dbMod.schoolsTable;
    districtsTable = dbMod.districtsTable;
    staffTable = dbMod.staffTable;
    classSectionsTable = dbMod.classSectionsTable;
    staffDefaultsTable = dbMod.staffDefaultsTable;
    districtIntegrationsTable = dbMod.districtIntegrationsTable;
    runSisSync = (await import("../lib/sisRosterSync")).runSisSync;

    await ensureSyncIndexes();
    // staff_defaults.staff_name is GLOBALLY unique, so rows orphaned by an
    // earlier aborted run (their school is long gone) would block this run's
    // room upserts. Clear any row whose school no longer exists.
    await db.execute(
      sql`DELETE FROM staff_defaults WHERE school_id NOT IN (SELECT id FROM schools)`,
    );

    const [district] = await db
      .insert(districtsTable)
      .values({
        name: "Planning Collision District",
        slug: "planning-collision-district",
        stateDistrictCode: "98",
      })
      .onConflictDoUpdate({
        target: districtsTable.slug,
        set: { name: "Planning Collision District" },
      })
      .returning({ id: districtsTable.id });

    const [school] = await db
      .insert(schoolsTable)
      .values({
        districtId: district!.id,
        name: "Planning Collision School",
        shortName: "Collision",
        stateSchoolCode: PARROTT_CODE,
      })
      .onConflictDoUpdate({
        target: [schoolsTable.districtId, schoolsTable.stateSchoolCode],
        set: { name: "Planning Collision School" },
      })
      .returning({ id: schoolsTable.id });
    schoolId = school!.id;

    const [integration] = await db
      .insert(districtIntegrationsTable)
      .values({
        schoolName: "Planning Collision School",
        sisProvider: "classlink",
        sisConfig: {
          useFixtures: true,
          schoolId,
          stateSchoolCode: PARROTT_CODE,
          schoolOrgSourcedId: PARROTT_ORG,
        },
      })
      .returning();
    integrationRow = integration!;
  });

  afterAll(async () => {
    if (!db) return;
    await db
      .delete(classSectionsTable)
      .where(eq(classSectionsTable.schoolId, schoolId));
    await db
      .delete(staffDefaultsTable)
      .where(eq(staffDefaultsTable.schoolId, schoolId));
    await db.delete(staffTable).where(eq(staffTable.schoolId, schoolId));
    await db
      .delete(districtIntegrationsTable)
      .where(eq(districtIntegrationsTable.id, integrationRow.id));
    await db.delete(schoolsTable).where(eq(schoolsTable.id, schoolId));
    await db
      .delete(districtsTable)
      .where(eq(districtsTable.slug, "planning-collision-district"));
  });

  beforeEach(async () => {
    await ensureSyncIndexes();
  });

  it("baseline: fixture sync succeeds and writes sections", async () => {
    const result = await runSisSync(integrationRow);
    expect(result.errors.join(" | ")).toBe("");
    expect(result.status).not.toBe("failed");
    expect(result.counts.sectionsWritten).toBeGreaterThan(0);
  });

  it("survives a planning row occupying a feed section's unique identity", async () => {
    // Take an identity the feed just produced and re-create it as a PLANNING
    // row — exactly the state that made Nature Coast's sync abort.
    const [existing] = await db
      .select()
      .from(classSectionsTable)
      .where(
        and(
          eq(classSectionsTable.schoolId, schoolId),
          eq(classSectionsTable.isPlanning, false),
        ),
      )
      .limit(1);
    expect(existing).toBeTruthy();

    await db
      .delete(classSectionsTable)
      .where(eq(classSectionsTable.id, existing!.id));
    await db.insert(classSectionsTable).values({
      schoolId,
      teacherStaffId: existing!.teacherStaffId,
      period: existing!.period,
      courseName: existing!.courseName,
      isPlanning: true,
    });

    const result = await runSisSync(integrationRow);

    // Before the fix this threw / returned "failed" with zero sections.
    expect(result.status).not.toBe("failed");
    expect(result.ok).toBe(true);

    // The planning row is preserved (sync does not own it) and was NOT
    // duplicated — the unique identity still resolves to exactly one row.
    const rows = await db
      .select()
      .from(classSectionsTable)
      .where(
        and(
          eq(classSectionsTable.schoolId, schoolId),
          eq(classSectionsTable.teacherStaffId, existing!.teacherStaffId),
          eq(classSectionsTable.period, existing!.period),
          eq(classSectionsTable.courseName, existing!.courseName),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.isPlanning).toBe(true);
  });

  it("migrates a LEGACY district-wide section index before syncing", async () => {
    // Production's actual state: RUN_BOOT_SEED is off there, so the boot
    // ensure never ran and class_sections still carried the pre-multi-school
    // key without school_id. Any teacher shared between two schools then
    // collided and failed that school's entire sync.
    await db.execute(
      sql`DROP INDEX IF EXISTS class_sections_school_teacher_period_course_unique`,
    );
    await db.execute(
      sql`CREATE UNIQUE INDEX class_sections_teacher_period_course_unique ON class_sections (teacher_staff_id, period, course_name)`,
    );

    // The repair is once-per-process; re-import with a fresh module registry so
    // this test exercises it rather than riding an earlier test's flag.
    vi.resetModules();
    const freshRunSisSync = (await import("../lib/sisRosterSync")).runSisSync;
    const result = await freshRunSisSync(integrationRow);
    expect(result.status).not.toBe("failed");

    const idx = await db.execute(
      sql`SELECT indexname FROM pg_indexes WHERE tablename = 'class_sections'`,
    );
    const names = (idx.rows as Array<{ indexname: string }>).map(
      (r) => r.indexname,
    );
    expect(names).toContain(
      "class_sections_school_teacher_period_course_unique",
    );
    expect(names).not.toContain("class_sections_teacher_period_course_unique");
  });

  it("remains idempotent across repeated syncs", async () => {
    const first = await runSisSync(integrationRow);
    const second = await runSisSync(integrationRow);
    expect(first.status).not.toBe("failed");
    expect(second.status).not.toBe("failed");
    expect(second.counts.sectionsWritten).toBe(first.counts.sectionsWritten);
  });
});
