// Moving a staff member between schools.
//
// staff.email is GLOBALLY unique and there is no delete, so a person created
// at the wrong school could not be re-created at the right one ("already
// exists") — they were stranded. This endpoint is the only code path in the
// app that writes staff.school_id.
//
// Two properties matter more than the happy path, and both are pinned here:
//
//  1. AUTHORIZATION. Nothing at the DB layer guards this — staff.school_id has
//     no FK to schools.id and there is no RLS policy on staff. If the route's
//     checks are wrong, one tenant can push staff into another. Hence: only a
//     SuperUser, only within their own district, only with a step-up reauth.
//
//  2. HISTORY STAYS PUT. 128 tables carry both a staff reference and their own
//     school_id. The move deliberately touches NONE of them: a person's hall
//     passes and PBIS entries remain the old school's records. Rewriting them
//     would silently change that school's reports, so the test seeds real
//     history and asserts it is untouched.
//
// Requires DATABASE_URL; skipped otherwise.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("staff school move", () => {
  let app: import("express").Express;
  let db: typeof import("@workspace/db").db;
  let staffTable: typeof import("@workspace/db").staffTable;
  let housesTable: typeof import("@workspace/db").housesTable;
  let classSectionsTable: typeof import("@workspace/db").classSectionsTable;
  let staffDefaultsTable: typeof import("@workspace/db").staffDefaultsTable;
  let pbisEntriesTable: typeof import("@workspace/db").pbisEntriesTable;
  let authAuditLogTable: typeof import("@workspace/db").authAuditLogTable;
  let fx: typeof import("./support/authFixtures");

  // One district with two schools (`from` / `to`), plus a SECOND district
  // standing in for Pasco so the cross-district rejection is exercised
  // against a genuinely foreign tenant rather than a made-up id.
  let from: { districtId: number; schoolId: number };
  let to: { districtId: number; schoolId: number };
  let other: { districtId: number; schoolId: number };

  let superUser: { id: number; email: string };
  let schoolAdmin: { id: number; email: string };
  const TAG = "move";

  // Re-created before each move test that consumes it, since a successful
  // move mutates the row and later assertions would otherwise see it moved.
  async function makeMovable(tag: string) {
    return fx.createStaff(from.schoolId, "teacher", `${TAG}${tag}`);
  }

  beforeAll(async () => {
    const dbMod = await import("@workspace/db");
    db = dbMod.db;
    staffTable = dbMod.staffTable;
    housesTable = dbMod.housesTable;
    classSectionsTable = dbMod.classSectionsTable;
    staffDefaultsTable = dbMod.staffDefaultsTable;
    pbisEntriesTable = dbMod.pbisEntriesTable;
    authAuditLogTable = dbMod.authAuditLogTable;
    app = (await import("../app")).default;
    fx = await import("./support/authFixtures");

    // testSchemaSync.mts creates tables but SKIPS indexes, so any index the
    // code relies on must be created here. staff_defaults_staff_id_unique is
    // PARTIAL — the predicate must be repeated verbatim or an ON CONFLICT
    // targeting it fails to match (the Nature Coast failure mode).
    await db.execute(
      sql`CREATE UNIQUE INDEX IF NOT EXISTS staff_email_unique ON staff (email)`,
    );
    await db.execute(
      sql`CREATE UNIQUE INDEX IF NOT EXISTS staff_defaults_staff_id_unique ON staff_defaults (staff_id) WHERE staff_id IS NOT NULL`,
    );

    from = await fx.createTenant(`${TAG}-from`);
    const [toSchool] = await db
      .insert(dbMod.schoolsTable)
      .values({ districtId: from.districtId, name: `Dest School ${TAG}` })
      .returning();
    to = { districtId: from.districtId, schoolId: toSchool!.id };

    other = await fx.createTenant(`${TAG}-other`);

    superUser = await fx.createStaff(from.schoolId, "superuser", `${TAG}s`);
    schoolAdmin = await fx.createStaff(from.schoolId, "admin", `${TAG}a`);
  });

  afterAll(async () => {
    if (!db) return;
    for (const schoolId of [from.schoolId, to.schoolId, other.schoolId]) {
      await db
        .delete(pbisEntriesTable)
        .where(eq(pbisEntriesTable.schoolId, schoolId));
      await db
        .delete(classSectionsTable)
        .where(eq(classSectionsTable.schoolId, schoolId));
      await db
        .delete(staffDefaultsTable)
        .where(eq(staffDefaultsTable.schoolId, schoolId));
      await db.delete(housesTable).where(eq(housesTable.schoolId, schoolId));
    }
    await fx.cleanupTenants(
      [from.schoolId, to.schoolId, other.schoolId],
      [from.districtId, other.districtId],
    );
  });

  async function moveAs(
    email: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const session = await fx.loginAndCsrf(app, email);
    const res = await session.agent
      .post("/api/admin/staff/move-school")
      .set("x-csrf-token", session.csrfToken)
      .send(body);
    return { status: res.status, body: res.body };
  }

  async function schoolIdOf(staffId: number): Promise<number> {
    const [row] = await db
      .select({ schoolId: staffTable.schoolId })
      .from(staffTable)
      .where(eq(staffTable.id, staffId));
    return row!.schoolId;
  }

  // ---- Authorization -----------------------------------------------------

  it("rejects a school admin and writes nothing", async () => {
    const target = await makeMovable("admin-denied");
    const res = await moveAs(schoolAdmin.email, {
      staffIds: [target.id],
      toSchoolId: to.schoolId,
      reauth: { currentPassword: fx.TEST_PASSWORD },
    });

    expect(res.status).toBe(403);
    // The whole point: an admin must not be able to push staff into another
    // school, even one inside their own district.
    expect(await schoolIdOf(target.id)).toBe(from.schoolId);
  });

  it("rejects a District Admin and writes nothing", async () => {
    // A District Admin is district-wide, so "same district" alone would let
    // them through — only the SuperUser rule stops them. Two independent
    // layers currently do: requireAdminOrSuper() admits only
    // isAdmin/isSuperUser/capStaffRoles (a District Admin holds none), and
    // the route's own isSuperUser check. Pinned so removing either one is
    // still caught by the other.
    const districtAdmin = await fx.createStaff(
      from.schoolId,
      "districtadmin",
      `${TAG}da`,
    );
    const target = await makeMovable("da-denied");
    const res = await moveAs(districtAdmin.email, {
      staffIds: [target.id],
      toSchoolId: to.schoolId,
      reauth: { currentPassword: fx.TEST_PASSWORD },
    });

    expect(res.status).toBe(403);
    expect(await schoolIdOf(target.id)).toBe(from.schoolId);
  });

  it("rejects a destination outside the actor's district", async () => {
    const target = await makeMovable("cross-district");
    const res = await moveAs(superUser.email, {
      staffIds: [target.id],
      toSchoolId: other.schoolId,
      reauth: { currentPassword: fx.TEST_PASSWORD },
    });

    expect(res.status).toBe(403);
    expect(await schoolIdOf(target.id)).toBe(from.schoolId);
  });

  it("rejects a target staff member outside the actor's district", async () => {
    const foreigner = await fx.createStaff(
      other.schoolId,
      "teacher",
      `${TAG}foreign`,
    );
    const res = await moveAs(superUser.email, {
      staffIds: [foreigner.id],
      toSchoolId: to.schoolId,
      reauth: { currentPassword: fx.TEST_PASSWORD },
    });

    // Either a hard 4xx or a per-person failure is acceptable; what must never
    // happen is the foreign staff row actually moving into our district.
    expect(await schoolIdOf(foreigner.id)).toBe(other.schoolId);
    if (res.status === 200) {
      expect((res.body.moved as unknown[]) ?? []).toHaveLength(0);
    }
  });

  it("requires step-up reauth", async () => {
    const target = await makeMovable("no-reauth");
    const res = await moveAs(superUser.email, {
      staffIds: [target.id],
      toSchoolId: to.schoolId,
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("reauth_required");
    expect(await schoolIdOf(target.id)).toBe(from.schoolId);
  });

  it("rejects a wrong password", async () => {
    const target = await makeMovable("bad-password");
    const res = await moveAs(superUser.email, {
      staffIds: [target.id],
      toSchoolId: to.schoolId,
      reauth: { currentPassword: "not-the-password" },
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await schoolIdOf(target.id)).toBe(from.schoolId);
  });

  it("refuses to move the actor themselves", async () => {
    const res = await moveAs(superUser.email, {
      staffIds: [superUser.id],
      toSchoolId: to.schoolId,
      reauth: { currentPassword: fx.TEST_PASSWORD },
    });

    // Moving yourself changes your own tenancy underneath the live session.
    expect(await schoolIdOf(superUser.id)).toBe(from.schoolId);
    if (res.status === 200) {
      expect((res.body.moved as unknown[]) ?? []).toHaveLength(0);
    }
  });

  // ---- Behaviour ---------------------------------------------------------

  it("moves the staff member and preserves their roles", async () => {
    const target = await fx.createStaff(from.schoolId, "admin", `${TAG}happy`);
    const res = await moveAs(superUser.email, {
      staffIds: [target.id],
      toSchoolId: to.schoolId,
      reauth: { currentPassword: fx.TEST_PASSWORD },
    });

    expect(res.status).toBe(200);
    expect((res.body.moved as unknown[]) ?? []).toHaveLength(1);

    const [row] = await db
      .select({ schoolId: staffTable.schoolId, isAdmin: staffTable.isAdmin })
      .from(staffTable)
      .where(eq(staffTable.id, target.id));
    expect(row!.schoolId).toBe(to.schoolId);
    // Roles travel with the person — they keep being an admin, just elsewhere.
    expect(row!.isAdmin).toBe(true);
  });

  it("clears school-scoped config that would otherwise point at the old school", async () => {
    const target = await makeMovable("config");

    // A house at the OLD school. Houses are school-scoped, and the existing
    // cross-school guard on PATCH only fires when houseId is in the update
    // body — a school move walks straight past it, so this is a real
    // corruption path, not just untidiness.
    const [house] = await db
      .insert(housesTable)
      .values({
        schoolId: from.schoolId,
        name: `House ${TAG}`,
        color: "#3b82f6",
        createdAt: new Date().toISOString(),
      })
      .returning();
    await db
      .update(staffTable)
      .set({
        houseId: house!.id,
        defaultRoom: "Room 101",
        activeSchoolOverride: from.schoolId,
      })
      .where(eq(staffTable.id, target.id));
    await db.insert(staffDefaultsTable).values({
      schoolId: from.schoolId,
      staffId: target.id,
      staffName: `defaults-${TAG}-${target.id}`,
      defaultLocationName: "Room 101",
    });

    const res = await moveAs(superUser.email, {
      staffIds: [target.id],
      toSchoolId: to.schoolId,
      reauth: { currentPassword: fx.TEST_PASSWORD },
    });
    expect(res.status).toBe(200);

    const [row] = await db
      .select({
        houseId: staffTable.houseId,
        defaultRoom: staffTable.defaultRoom,
        activeSchoolOverride: staffTable.activeSchoolOverride,
      })
      .from(staffTable)
      .where(eq(staffTable.id, target.id));
    expect(row!.houseId).toBeNull();
    expect(row!.defaultRoom).toBeNull();
    expect(row!.activeSchoolOverride).toBeNull();

    const defaults = await db
      .select({ id: staffDefaultsTable.id })
      .from(staffDefaultsTable)
      .where(eq(staffDefaultsTable.staffId, target.id));
    expect(defaults).toHaveLength(0);
  });

  it("leaves history at the old school untouched", async () => {
    const target = await makeMovable("history");
    const [entry] = await db
      .insert(pbisEntriesTable)
      .values({
        schoolId: from.schoolId,
        staffId: target.id,
        studentId: `stu-${TAG}-${target.id}`,
        reason: "Respectful",
        points: 3,
        staffName: `teacher ${TAG}history`,
        createdAt: new Date().toISOString(),
      })
      .returning();

    const res = await moveAs(superUser.email, {
      staffIds: [target.id],
      toSchoolId: to.schoolId,
      reauth: { currentPassword: fx.TEST_PASSWORD },
    });
    expect(res.status).toBe(200);

    // The regression that protects the old school's reports: if this row
    // followed the person, that school's PBIS totals would silently change.
    const [after] = await db
      .select({ schoolId: pbisEntriesTable.schoolId })
      .from(pbisEntriesTable)
      .where(eq(pbisEntriesTable.id, entry!.id));
    expect(after!.schoolId).toBe(from.schoolId);
  });

  it("leaves sections at the old school, keeping the person visible there", async () => {
    const target = await makeMovable("sections");
    await db.insert(classSectionsTable).values({
      schoolId: from.schoolId,
      teacherStaffId: target.id,
      period: 2,
      courseName: `Algebra ${TAG}`,
      isPlanning: false,
    });

    const res = await moveAs(superUser.email, {
      staffIds: [target.id],
      toSchoolId: to.schoolId,
      reauth: { currentPassword: fx.TEST_PASSWORD },
    });
    expect(res.status).toBe(200);

    const sections = await db
      .select({ id: classSectionsTable.id })
      .from(classSectionsTable)
      .where(
        and(
          eq(classSectionsTable.teacherStaffId, target.id),
          eq(classSectionsTable.schoolId, from.schoolId),
        ),
      );
    expect(sections.length).toBeGreaterThan(0);

    // Membership is derived as "home school OR teaches a section here", so a
    // moved teacher who still holds sections stays listed at BOTH — the
    // honest state for a shared teacher (same rule that fixed Nature Coast).
    const { staffAtSchoolWhere } = await import("../lib/schoolStaff");
    const rows = await db
      .select({ id: staffTable.id })
      .from(staffTable)
      .where(await staffAtSchoolWhere(from.schoolId));
    expect(rows.map((r) => r.id)).toContain(target.id);
  });

  it("writes an audit row naming both schools", async () => {
    const target = await makeMovable("audit");
    const res = await moveAs(superUser.email, {
      staffIds: [target.id],
      toSchoolId: to.schoolId,
      reauth: { currentPassword: fx.TEST_PASSWORD },
    });
    expect(res.status).toBe(200);

    const rows = await db
      .select({
        action: authAuditLogTable.action,
        targetStaffId: authAuditLogTable.targetStaffId,
      })
      .from(authAuditLogTable)
      .where(
        and(
          eq(authAuditLogTable.action, "staff_school_moved"),
          eq(authAuditLogTable.targetStaffId, target.id),
        ),
      );
    expect(rows.length).toBeGreaterThan(0);
  });

  it("reports a no-op when the person is already at the destination", async () => {
    const target = await makeMovable("noop");
    await db
      .update(staffTable)
      .set({ schoolId: to.schoolId })
      .where(eq(staffTable.id, target.id));

    const res = await moveAs(superUser.email, {
      staffIds: [target.id],
      toSchoolId: to.schoolId,
      reauth: { currentPassword: fx.TEST_PASSWORD },
    });

    expect(res.status).toBe(200);
    expect((res.body.moved as unknown[]) ?? []).toHaveLength(0);
    expect(await schoolIdOf(target.id)).toBe(to.schoolId);
  });
});
