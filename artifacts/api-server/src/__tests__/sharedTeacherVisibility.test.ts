// Shared / itinerant teachers must be visible at the schools they actually
// teach at.
//
// staff.school_id holds ONE home school, and roster sync deliberately reuses an
// existing account when a teacher already exists under another school (email is
// globally unique). Their class_sections land at the new school, but any roster
// or count keyed on staff.school_id rendered them absent — Nature Coast showed
// students, sections and enrollments with ZERO teachers.
//
// The fix derives membership as "home school OR teaches a section here"
// (lib/schoolStaff.ts). These tests pin BOTH halves of that contract:
//   * the visiting teacher is listed and counted at the school they teach at,
//   * and doing so does NOT widen write authorization — a school's admin still
//     cannot reset the password or edit the roles of a teacher whose home
//     school is elsewhere. That separation is the whole reason membership is
//     derived for display only.
// Requires DATABASE_URL; skipped otherwise.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("shared teacher visibility", () => {
  let app: import("express").Express;
  let db: typeof import("@workspace/db").db;
  let staffTable: typeof import("@workspace/db").staffTable;
  let classSectionsTable: typeof import("@workspace/db").classSectionsTable;
  let fx: typeof import("./support/authFixtures");
  let counts: typeof import("../lib/sisRosterSync");

  // One district, two schools. `home` is the teacher's home campus; `tech`
  // stands in for Nature Coast — they teach there but do not live there.
  let home: { districtId: number; schoolId: number };
  let tech: { districtId: number; schoolId: number };
  let visitingTeacher: { id: number; email: string };
  let techAdmin: { id: number; email: string };
  const TAG = "shared";

  beforeAll(async () => {
    const dbMod = await import("@workspace/db");
    db = dbMod.db;
    staffTable = dbMod.staffTable;
    classSectionsTable = dbMod.classSectionsTable;
    app = (await import("../app")).default;
    fx = await import("./support/authFixtures");
    counts = await import("../lib/sisRosterSync");

    await db.execute(
      sql`CREATE UNIQUE INDEX IF NOT EXISTS staff_email_unique ON staff (email)`,
    );

    home = await fx.createTenant(`${TAG}-home`);
    // Put the second school in the SAME district so this isolates the
    // shared-teacher case rather than cross-district behaviour.
    const [techSchool] = await db
      .insert(dbMod.schoolsTable)
      .values({ districtId: home.districtId, name: `Tech School ${TAG}` })
      .returning();
    tech = { districtId: home.districtId, schoolId: techSchool!.id };

    visitingTeacher = await fx.createStaff(home.schoolId, "teacher", `${TAG}v`);
    techAdmin = await fx.createStaff(tech.schoolId, "admin", `${TAG}a`);

    // The teacher's home school stays `home`, but they teach a section at
    // `tech` — exactly the state roster sync produces for itinerant staff.
    await db.insert(classSectionsTable).values({
      schoolId: tech.schoolId,
      teacherStaffId: visitingTeacher.id,
      period: 3,
      courseName: "Welding I",
      isPlanning: false,
    });
  });

  afterAll(async () => {
    if (!db) return;
    await db
      .delete(classSectionsTable)
      .where(eq(classSectionsTable.schoolId, tech.schoolId));
    await fx.cleanupTenants([home.schoolId, tech.schoolId], [home.districtId]);
  });

  it("counts the visiting teacher at the school they teach at", async () => {
    // loadSchoolLiveCounts is module-private, so assert the same membership
    // rule through the exported predicate the panel's counts now use.
    const { staffAtSchoolWhere } = await import("../lib/schoolStaff");
    const rows = await db
      .select({ id: staffTable.id })
      .from(staffTable)
      .where(await staffAtSchoolWhere(tech.schoolId));
    const ids = rows.map((r) => r.id);
    // Before the fix this school matched only its own home-school staff.
    expect(ids).toContain(visitingTeacher.id);
    expect(ids).toContain(techAdmin.id);
  });

  it("lists the visiting teacher on that school's Staff & Roles roster", async () => {
    const session = await fx.loginAndCsrf(app, techAdmin.email);
    const res = await session.agent.get("/api/admin/staff").expect(200);
    const ids = (res.body as Array<{ id: number }>).map((r) => r.id);
    expect(ids).toContain(visitingTeacher.id);
  });

  it("still lists them at their own home school", async () => {
    const homeAdmin = await fx.createStaff(home.schoolId, "admin", `${TAG}h`);
    const session = await fx.loginAndCsrf(app, homeAdmin.email);
    const res = await session.agent.get("/api/admin/staff").expect(200);
    const ids = (res.body as Array<{ id: number }>).map((r) => r.id);
    expect(ids).toContain(visitingTeacher.id);
  });

  it("does NOT let the visited school's admin reset their password", async () => {
    // The security boundary: visibility widened, authority did not. Write gates
    // still key on staff.school_id, so this must remain a 404 (not found in
    // your school) rather than becoming a successful reset.
    const session = await fx.loginAndCsrf(app, techAdmin.email);
    const res = await session.agent
      .post(`/api/admin/staff/${visitingTeacher.id}/reset-temp-password`)
      .set("x-csrf-token", session.csrfToken)
      .send({});
    expect(res.status).toBe(404);
  });

  it("does NOT let the visited school's admin edit their roles", async () => {
    const session = await fx.loginAndCsrf(app, techAdmin.email);
    const res = await session.agent
      .patch(`/api/admin/staff/${visitingTeacher.id}`)
      .set("x-csrf-token", session.csrfToken)
      .send({ isAdmin: true });
    // Denied — 403 (privilege) or 404 (not in your school) are both acceptable;
    // what must never happen is a 2xx that actually applies the change.
    expect(res.status).toBeGreaterThanOrEqual(400);

    const [row] = await db
      .select({ isAdmin: staffTable.isAdmin })
      .from(staffTable)
      .where(eq(staffTable.id, visitingTeacher.id));
    expect(row!.isAdmin).toBe(false);
  });
});
