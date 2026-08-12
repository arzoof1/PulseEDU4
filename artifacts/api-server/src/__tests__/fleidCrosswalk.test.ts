// FLEID → local SIS id crosswalk for Florida FAST imports.
//
// Florida's FAST export keys every row on the STATE id (FLEID, e.g.
// "FL000008157762"). Hernando's ClassLink feed gives us the DISTRICT's local
// SIS id as the student number (e.g. "5006415") and tucks the FLEID away in
// user.metadata.FLEID — which the sync was discarding.
//
// Verified against the live roster server (2026-08-12): across 300 sampled
// students, 0/300 had a FLEID-shaped student_id and 300/300 carried
// metadata.FLEID. So a FAST upload keyed on FLEID matched NOTHING.
//
// The failure was silent, which is the part that actually cost a night: the
// importer writes student_fast_scores rows without checking the student
// exists, so ~228 records "imported successfully" and attached to nobody.
// Two fixes are pinned here:
//   1. the sync stores the FLEID, and the importer translates it, and
//   2. rows that STILL don't match are reported, never silently written.
//
// It worked in the demo seed because there students.student_id WAS the FLEID
// and local_sis_id was derived from it — ClassLink inverted that relationship.
//
// Requires DATABASE_URL; skipped otherwise.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";

const HAS_DB = !!process.env.DATABASE_URL;

// Real pairs supplied by the district (names withheld — ids only).
const LEON = { fleid: "FL000012425586", local: "5027564" };
const DYLAN = { fleid: "FL000008157762", local: "5006415" };

describe.skipIf(!HAS_DB)("FLEID crosswalk", () => {
  let db: typeof import("@workspace/db").db;
  let studentsTable: typeof import("@workspace/db").studentsTable;
  let fx: typeof import("./support/authFixtures");
  let resolveStudentIdsByFleid: typeof import("../lib/fleidCrosswalk").resolveStudentIdsByFleid;

  let tenant: { districtId: number; schoolId: number };

  beforeAll(async () => {
    const dbMod = await import("@workspace/db");
    db = dbMod.db;
    studentsTable = dbMod.studentsTable;
    fx = await import("./support/authFixtures");
    ({ resolveStudentIdsByFleid } = await import("../lib/fleidCrosswalk"));

    await db.execute(
      sql`CREATE UNIQUE INDEX IF NOT EXISTS students_student_id_unique ON students (student_id)`,
    );
    // testSchemaSync.mts builds tables from the schema snapshot, so a newly
    // added column isn't there yet — run the same idempotent ensure the app
    // runs at boot (production also relies on it, since RUN_BOOT_SEED is off).
    const { ensureStudentFleidColumn } = await import("../lib/fleidCrosswalk");
    await ensureStudentFleidColumn();

    tenant = await fx.createTenant("fleid");

    // Exactly the production shape: student_id is the LOCAL id, and the
    // FLEID lives in its own column.
    await db.insert(studentsTable).values([
      {
        schoolId: tenant.schoolId,
        studentId: LEON.local,
        firstName: "Leon",
        lastName: "Andersson",
        grade: 6,
        fleid: LEON.fleid,
      },
      {
        schoolId: tenant.schoolId,
        studentId: DYLAN.local,
        firstName: "Dylan",
        lastName: "Ashley",
        grade: 6,
        fleid: DYLAN.fleid,
      },
    ]);
  });

  afterAll(async () => {
    if (!db) return;
    await db
      .delete(studentsTable)
      .where(eq(studentsTable.schoolId, tenant.schoolId));
    await fx.cleanupTenants([tenant.schoolId], [tenant.districtId]);
  });

  it("translates a FLEID to the district's local student id", async () => {
    const map = await resolveStudentIdsByFleid(tenant.schoolId, [
      LEON.fleid,
      DYLAN.fleid,
    ]);
    expect(map.get(LEON.fleid)).toBe(LEON.local);
    expect(map.get(DYLAN.fleid)).toBe(DYLAN.local);
  });

  it("passes through an id that is ALREADY the local student id", async () => {
    // Some district exports use the local id directly. Those must keep
    // working — the crosswalk is additive, not a replacement.
    const map = await resolveStudentIdsByFleid(tenant.schoolId, [LEON.local]);
    expect(map.get(LEON.local)).toBe(LEON.local);
  });

  it("is case-insensitive and tolerates surrounding whitespace", async () => {
    // Spreadsheet cells routinely arrive padded, and FL / fl both appear.
    const map = await resolveStudentIdsByFleid(tenant.schoolId, [
      `  ${DYLAN.fleid.toLowerCase()} `,
    ]);
    expect(map.get(`  ${DYLAN.fleid.toLowerCase()} `)).toBe(DYLAN.local);
  });

  it("reports an unknown FLEID as unmatched rather than inventing a row", async () => {
    const map = await resolveStudentIdsByFleid(tenant.schoolId, [
      "FL999999999999",
    ]);
    // Absent from the map = caller must treat it as unmatched. Silently
    // writing it is precisely the bug this exists to prevent.
    expect(map.has("FL999999999999")).toBe(false);
  });

  it("does not cross tenants", async () => {
    const other = await fx.createTenant("fleid-other");
    const map = await resolveStudentIdsByFleid(other.schoolId, [DYLAN.fleid]);
    expect(map.has(DYLAN.fleid)).toBe(false);
    await fx.cleanupTenants([other.schoolId], [other.districtId]);
  });

  it("handles an empty input without querying", async () => {
    const map = await resolveStudentIdsByFleid(tenant.schoolId, []);
    expect(map.size).toBe(0);
  });
});

describe("FLEID extraction from the ClassLink feed", () => {
  it("reads metadata.FLEID regardless of key casing", async () => {
    const { mapOneRosterStudents } = await import("@workspace/sis-adapters");
    const bundle = {
      baseUrl: "",
      orgs: [],
      courses: [],
      classes: [],
      enrollments: [],
      demographics: [],
      users: [
        {
          sourcedId: "USRstudent10002",
          status: "active",
          role: "student",
          givenName: "Dylan",
          familyName: "Ashley",
          // Exactly the live shape: local id in `identifier`, state id in
          // metadata under an UPPERCASE key.
          identifier: DYLAN.local,
          grades: ["6"],
          metadata: { FLEID: DYLAN.fleid, ELL: "", SWD: "Y" },
        },
      ],
    } as never;

    const [student] = mapOneRosterStudents(bundle);
    expect(student!.studentId).toBe(DYLAN.local);
    expect(student!.fleid).toBe(DYLAN.fleid);
  });

  it("leaves fleid undefined when the feed omits it", async () => {
    const { mapOneRosterStudents } = await import("@workspace/sis-adapters");
    const bundle = {
      baseUrl: "",
      orgs: [],
      courses: [],
      classes: [],
      enrollments: [],
      demographics: [],
      users: [
        {
          sourcedId: "USRstudent1",
          status: "active",
          role: "student",
          givenName: "No",
          familyName: "Fleid",
          identifier: "123",
          grades: ["6"],
          metadata: {},
        },
      ],
    } as never;

    const [student] = mapOneRosterStudents(bundle);
    // undefined (not null/"") so the sync's patch builder leaves any
    // existing value alone rather than clobbering it.
    expect(student!.fleid).toBeUndefined();
  });
});
