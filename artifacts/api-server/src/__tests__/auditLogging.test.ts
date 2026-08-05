// DV-11 — audit logging captures required record-VIEW and EXPORT events.
//
// Proves the three gaps closed in this change actually write audit rows:
//   1. GET /api/watchlist/cases/:id     -> auth_audit_log 'watchlist_case_viewed'
//   2. GET /api/data-imports/export     -> data_export_audit_log + auth_audit_log 'data_export'
//   3. GET /api/safety-plans/student/:id -> auth_audit_log 'safety_plan_viewed'
// Requires DATABASE_URL; skipped otherwise.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import request from "supertest";

const HAS_DB = !!process.env.DATABASE_URL;
const tag = `dv11-${Date.now()}-${process.pid}`;

describe.skipIf(!HAS_DB)("audit logging for views & exports (DV-11)", () => {
  let db: typeof import("@workspace/db").db;
  let T: typeof import("@workspace/db");
  let fx: typeof import("./support/authFixtures");
  let app: import("express").Express;

  let schoolId = 0;
  const districtIds: number[] = [];
  let caseId = 0;
  let studentId = "";
  let agent: ReturnType<typeof request.agent>;
  let csrfToken = "";

  async function lastAudit(action: string) {
    const [row] = await db
      .select()
      .from(T.authAuditLogTable)
      .where(
        and(
          eq(T.authAuditLogTable.schoolId, schoolId),
          eq(T.authAuditLogTable.action, action),
        ),
      )
      .orderBy(desc(T.authAuditLogTable.id))
      .limit(1);
    return row;
  }

  beforeAll(async () => {
    T = await import("@workspace/db");
    db = T.db;
    fx = await import("./support/authFixtures");
    app = (await import("../app")).default;

    const tenant = await fx.createTenant(tag);
    schoolId = tenant.schoolId;
    districtIds.push(tenant.districtId);
    // Admin can reach the importer export + the sensitive reads.
    const admin = await fx.createStaff(schoolId, "admin", tag);

    studentId = `stu-${tag}`;
    await db.insert(T.studentsTable).values({
      schoolId,
      studentId,
      firstName: "Test",
      lastName: "Student",
      grade: 5,
    });

    const [c] = await db
      .insert(T.interactionCasesTable)
      .values({
        schoolId,
        caseNumber: 1,
        schoolYearLabel: "2025-2026",
        title: "DV-11 audit test case",
      })
      .returning();
    caseId = c.id;

    // The safety-plans route is feature-gated. `enabled` is read from
    // school_settings.super_feature_* (default true), so a settings row is all
    // that's needed to license safetyPlans for this school.
    await db.insert(T.schoolSettingsTable).values({
      schoolId,
      schoolName: `DV11 ${tag}`,
    });

    const login = await fx.loginAndCsrf(app, admin.email);
    agent = login.agent;
    csrfToken = login.csrfToken;
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(T.authAuditLogTable).where(eq(T.authAuditLogTable.schoolId, schoolId));
    await db
      .delete(T.dataExportAuditLogTable)
      .where(eq(T.dataExportAuditLogTable.schoolId, schoolId));
    await db
      .delete(T.schoolSettingsTable)
      .where(eq(T.schoolSettingsTable.schoolId, schoolId));
    await db.delete(T.interactionCasesTable).where(eq(T.interactionCasesTable.schoolId, schoolId));
    await db.delete(T.studentsTable).where(eq(T.studentsTable.schoolId, schoolId));
    await db.delete(T.staffTable).where(eq(T.staffTable.schoolId, schoolId));
    await db.delete(T.schoolsTable).where(eq(T.schoolsTable.id, schoolId));
    for (const id of districtIds) {
      await db.delete(T.districtsTable).where(eq(T.districtsTable.id, id));
    }
  });

  it("logs a watchlist case VIEW (no reauth needed)", async () => {
    await agent.get(`/api/watchlist/cases/${caseId}`).expect(200);
    const row = await lastAudit("watchlist_case_viewed");
    expect(row).toBeTruthy();
    expect((row!.payload as { caseId: number }).caseId).toBe(caseId);
    expect(row!.actorStaffId).toBeTruthy();
  });

  it("logs a data-imports EXPORT (detailed row + security mirror)", async () => {
    await fx.reauth(agent, csrfToken);
    await agent.get("/api/data-imports/export?kind=rosters").expect(200);

    const [detail] = await db
      .select()
      .from(T.dataExportAuditLogTable)
      .where(
        and(
          eq(T.dataExportAuditLogTable.schoolId, schoolId),
          eq(T.dataExportAuditLogTable.datasetKey, "import:rosters"),
        ),
      )
      .orderBy(desc(T.dataExportAuditLogTable.id))
      .limit(1);
    expect(detail).toBeTruthy();
    expect(detail!.format).toBe("csv");

    const mirror = await lastAudit("data_export");
    expect(mirror).toBeTruthy();
    expect((mirror!.payload as { via: string }).via).toBe("data_imports");
  });

  it("logs a Safety Plan VIEW", async () => {
    // Sanity: the student exists in this school (localizes a 404 to route vs data).
    const [s] = await db
      .select({ id: T.studentsTable.id, schoolId: T.studentsTable.schoolId })
      .from(T.studentsTable)
      .where(
        and(
          eq(T.studentsTable.schoolId, schoolId),
          eq(T.studentsTable.studentId, studentId),
        ),
      );
    expect(s, "seeded student should exist in the school").toBeTruthy();

    await fx.reauth(agent, csrfToken);
    await agent.get(`/api/safety-plans/student/${studentId}`).expect(200);
    const row = await lastAudit("safety_plan_viewed");
    expect(row).toBeTruthy();
    expect((row!.payload as { studentId: string }).studentId).toBe(studentId);
  });
});
