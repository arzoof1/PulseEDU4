// Assigning a program accommodation also flags the student.
//
// Two screens looked like they agreed and did not. The Accommodations tab
// assigns rows in `student_accommodations`; the Teacher Roster's Programs
// pills read `students.ese / is504 / ell`. Nothing connected them, so an ESE
// coordinator could spend an afternoon adding students under the "ESE / IEP"
// heading and every one of them still rendered an em-dash on the roster.
//
// Now an assignment in a PROGRAM category sets the matching flag:
//   IEP -> ese,  504 -> is504,  ELL -> ell,  Strategy -> nothing.
//
// Deliberately one-way. Removing the last accommodation does NOT clear the
// flag: a student can be ESE with no accommodations recorded, and auto-
// clearing could silently strip a flag the district set via ClassLink.
// Un-flagging stays an explicit action on the Student Profile.
//
// Requires DATABASE_URL; skipped otherwise.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("accommodation assignment sets program flags", () => {
  let app: import("express").Express;
  let db: typeof import("@workspace/db").db;
  let studentsTable: typeof import("@workspace/db").studentsTable;
  let schoolAccommodationsTable: typeof import("@workspace/db").schoolAccommodationsTable;
  let studentAccommodationsTable: typeof import("@workspace/db").studentAccommodationsTable;
  let staffTable: typeof import("@workspace/db").staffTable;
  let fx: typeof import("./support/authFixtures");

  let tenant: { districtId: number; schoolId: number };
  let admin: { id: number; email: string };
  let eseCoordinator: { id: number; email: string };
  let teacher: { id: number; email: string };

  // One accommodation per category, so each mapping can be exercised.
  const accIds: Record<string, number> = {};
  const TAG = "accflag";
  let seq = 0;

  async function makeStudent(): Promise<string> {
    const studentId = `${TAG}-stu-${++seq}`;
    await db.insert(studentsTable).values({
      schoolId: tenant.schoolId,
      studentId,
      firstName: "Test",
      lastName: `Student${seq}`,
      grade: 6,
    });
    return studentId;
  }

  async function flagsOf(studentId: string) {
    const [row] = await db
      .select({
        ese: studentsTable.ese,
        is504: studentsTable.is504,
        ell: studentsTable.ell,
      })
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.studentId, studentId),
          eq(studentsTable.schoolId, tenant.schoolId),
        ),
      );
    return row!;
  }

  async function assign(
    email: string,
    studentId: string,
    accommodationIds: number[],
  ) {
    const session = await fx.loginAndCsrf(app, email);
    return session.agent
      .post(`/api/students/${studentId}/accommodations`)
      .set("x-csrf-token", session.csrfToken)
      .send({ accommodationIds });
  }

  beforeAll(async () => {
    const dbMod = await import("@workspace/db");
    db = dbMod.db;
    studentsTable = dbMod.studentsTable;
    schoolAccommodationsTable = dbMod.schoolAccommodationsTable;
    studentAccommodationsTable = dbMod.studentAccommodationsTable;
    staffTable = dbMod.staffTable;
    app = (await import("../app")).default;
    fx = await import("./support/authFixtures");

    await db.execute(
      sql`CREATE UNIQUE INDEX IF NOT EXISTS students_student_id_unique ON students (student_id)`,
    );

    tenant = await fx.createTenant(`${TAG}`);
    admin = await fx.createStaff(tenant.schoolId, "admin", `${TAG}a`);
    teacher = await fx.createStaff(tenant.schoolId, "teacher", `${TAG}t`);

    // ESE Coordinator isn't one of the fixture roles — promote a teacher.
    eseCoordinator = await fx.createStaff(tenant.schoolId, "teacher", `${TAG}e`);
    await db
      .update(staffTable)
      .set({ isEseCoordinator: true })
      .where(eq(staffTable.id, eseCoordinator.id));

    for (const category of ["IEP", "504", "ELL", "Strategy"]) {
      const [row] = await db
        .insert(schoolAccommodationsTable)
        .values({
          schoolId: tenant.schoolId,
          name: `${category} accommodation ${TAG}`,
          category,
        })
        .returning();
      accIds[category] = row!.id;
    }
  });

  afterAll(async () => {
    if (!db) return;
    await db
      .delete(studentAccommodationsTable)
      .where(eq(studentAccommodationsTable.schoolId, tenant.schoolId));
    await db
      .delete(schoolAccommodationsTable)
      .where(eq(schoolAccommodationsTable.schoolId, tenant.schoolId));
    await db
      .delete(studentsTable)
      .where(eq(studentsTable.schoolId, tenant.schoolId));
    await fx.cleanupTenants([tenant.schoolId], [tenant.districtId]);
  });

  it("sets ese when an IEP accommodation is assigned", async () => {
    const studentId = await makeStudent();
    expect((await flagsOf(studentId)).ese).toBe(false);

    const res = await assign(admin.email, studentId, [accIds.IEP!]);
    expect(res.status).toBe(201);

    expect((await flagsOf(studentId)).ese).toBe(true);
  });

  it("sets is504 for a 504 accommodation and ell for an ELL one", async () => {
    const studentId = await makeStudent();
    const res = await assign(admin.email, studentId, [
      accIds["504"]!,
      accIds.ELL!,
    ]);
    expect(res.status).toBe(201);

    const flags = await flagsOf(studentId);
    expect(flags.is504).toBe(true);
    expect(flags.ell).toBe(true);
    // Only the categories actually assigned.
    expect(flags.ese).toBe(false);
  });

  it("does NOT set any flag for a Strategy accommodation", async () => {
    const studentId = await makeStudent();
    const res = await assign(admin.email, studentId, [accIds.Strategy!]);
    expect(res.status).toBe(201);

    const flags = await flagsOf(studentId);
    expect(flags.ese).toBe(false);
    expect(flags.is504).toBe(false);
    expect(flags.ell).toBe(false);
  });

  it("lets an ESE Coordinator set the flag, not just Core Team", async () => {
    // The gates diverged: an ESE Coordinator could always assign
    // accommodations but could not edit student flags. Without widening it,
    // their assignment would save while the flag silently did not.
    const studentId = await makeStudent();
    const res = await assign(eseCoordinator.email, studentId, [accIds.IEP!]);
    expect(res.status).toBe(201);

    expect((await flagsOf(studentId)).ese).toBe(true);
  });

  it("still refuses a plain teacher", async () => {
    const studentId = await makeStudent();
    const res = await assign(teacher.email, studentId, [accIds.IEP!]);
    expect(res.status).toBe(403);

    expect((await flagsOf(studentId)).ese).toBe(false);
  });

  it("keeps the flag when the accommodation is removed", async () => {
    const studentId = await makeStudent();
    await assign(admin.email, studentId, [accIds.IEP!]);
    expect((await flagsOf(studentId)).ese).toBe(true);

    const [assignment] = await db
      .select({ id: studentAccommodationsTable.id })
      .from(studentAccommodationsTable)
      .where(
        and(
          eq(studentAccommodationsTable.studentId, studentId),
          eq(studentAccommodationsTable.schoolId, tenant.schoolId),
        ),
      );

    const session = await fx.loginAndCsrf(app, admin.email);
    await session.agent
      .delete(`/api/students/${studentId}/accommodations/${assignment!.id}`)
      .set("x-csrf-token", session.csrfToken)
      .expect(200);

    // One-way by design — a student can be ESE with nothing recorded, and
    // auto-clearing could silently undo a district-set flag.
    expect((await flagsOf(studentId)).ese).toBe(true);
  });

  it("is idempotent — re-assigning an existing accommodation is harmless", async () => {
    const studentId = await makeStudent();
    await assign(admin.email, studentId, [accIds.IEP!]);
    const res = await assign(admin.email, studentId, [accIds.IEP!]);
    expect(res.status).toBe(201);
    expect((await flagsOf(studentId)).ese).toBe(true);
  });

  it("does not touch a student in another school", async () => {
    const other = await fx.createTenant(`${TAG}-other`);
    const foreignId = `${TAG}-foreign`;
    await db.insert(studentsTable).values({
      schoolId: other.schoolId,
      studentId: foreignId,
      firstName: "Foreign",
      lastName: "Student",
      grade: 6,
    });

    const res = await assign(admin.email, foreignId, [accIds.IEP!]);
    expect(res.status).toBe(404);

    const [row] = await db
      .select({ ese: studentsTable.ese })
      .from(studentsTable)
      .where(eq(studentsTable.studentId, foreignId));
    expect(row!.ese).toBe(false);

    await db
      .delete(studentsTable)
      .where(eq(studentsTable.schoolId, other.schoolId));
    await fx.cleanupTenants([other.schoolId], [other.districtId]);
  });
});
