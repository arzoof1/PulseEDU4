// DV-03 (per-role effective-permission matrix) + DV-04 (cross-district
// isolation), as running integration evidence.
//
// Requires a live DATABASE_URL. When unset the whole suite is SKIPPED (not
// failed) so `vitest run` stays green in a DB-less environment — the db/app
// modules are imported dynamically inside beforeAll for the same reason.
// Run with, e.g.:  node --env-file=.env.pentest ... / DATABASE_URL=... pnpm test

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import type request from "supertest";

const HAS_DB = !!process.env.DATABASE_URL;
const tagA = `authA-${Date.now()}-${process.pid}`;
const tagB = `authB-${Date.now()}-${process.pid}`;

describe.skipIf(!HAS_DB)("authorization matrix (DV-03 / DV-04)", () => {
  let fx: typeof import("./support/authFixtures");
  let app: Express;

  let schoolA = 0;
  let schoolB = 0;
  const districtIds: number[] = [];

  // supertest agents keyed by a label.
  const agents: Record<string, ReturnType<typeof request.agent>> = {};
  let adminAEmail = "";
  let adminBEmail = "";
  let teacherBEmail = "";

  beforeAll(async () => {
    fx = await import("./support/authFixtures");
    app = (await import("../app")).default;

    // District A with the full role spread.
    const a = await fx.createTenant(tagA);
    schoolA = a.schoolId;
    districtIds.push(a.districtId);
    const superuserA = await fx.createStaff(schoolA, "superuser", tagA);
    const adminA = await fx.createStaff(schoolA, "admin", tagA);
    const coreteamA = await fx.createStaff(schoolA, "coreteam", tagA);
    const teacherA = await fx.createStaff(schoolA, "teacher", tagA);
    adminAEmail = adminA.email;

    // District B — a separate tenant used to prove isolation.
    const b = await fx.createTenant(tagB);
    schoolB = b.schoolId;
    districtIds.push(b.districtId);
    const adminB = await fx.createStaff(schoolB, "admin", tagB);
    const teacherB = await fx.createStaff(schoolB, "teacher", tagB);
    adminBEmail = adminB.email;
    teacherBEmail = teacherB.email;

    agents.superuserA = await fx.loginAs(app, superuserA.email);
    agents.adminA = await fx.loginAs(app, adminA.email);
    agents.coreteamA = await fx.loginAs(app, coreteamA.email);
    agents.teacherA = await fx.loginAs(app, teacherA.email);
    agents.adminB = await fx.loginAs(app, adminB.email);
  });

  afterAll(async () => {
    if (fx) await fx.cleanupTenants([schoolA, schoolB], districtIds);
  });

  // ---- DV-03: per-role effective permissions -----------------------------

  describe("GET /api/superuser/overview — SuperUser only", () => {
    it("allows a SuperUser", async () => {
      await agents.superuserA.get("/api/superuser/overview").expect(200);
    });
    it("forbids a school Admin (403)", async () => {
      await agents.adminA.get("/api/superuser/overview").expect(403);
    });
    it("forbids a Teacher (403)", async () => {
      await agents.teacherA.get("/api/superuser/overview").expect(403);
    });
  });

  describe("GET /api/admin/staff — role-manager or Core Team", () => {
    it("allows an Admin", async () => {
      await agents.adminA.get("/api/admin/staff").expect(200);
    });
    it("allows a Core Team member", async () => {
      await agents.coreteamA.get("/api/admin/staff").expect(200);
    });
    it("forbids a Teacher (403)", async () => {
      await agents.teacherA.get("/api/admin/staff").expect(403);
    });
  });

  describe("GET /api/auth/me — any signed-in staff", () => {
    it("allows a Teacher (authenticated, unprivileged)", async () => {
      await agents.teacherA.get("/api/auth/me").expect(200);
    });
  });

  // ---- DV-04: cross-district isolation -----------------------------------

  it("Admin in district A sees only district A staff on /api/admin/staff", async () => {
    const res = await agents.adminA.get("/api/admin/staff").expect(200);
    const emails: string[] = res.body.map((r: { email: string }) => r.email);
    // Own tenant is visible…
    expect(emails).toContain(adminAEmail);
    // …the other district's staff never leak in.
    expect(emails).not.toContain(adminBEmail);
    expect(emails).not.toContain(teacherBEmail);
  });

  it("Admin in district B likewise cannot see district A staff", async () => {
    const res = await agents.adminB.get("/api/admin/staff").expect(200);
    const emails: string[] = res.body.map((r: { email: string }) => r.email);
    expect(emails).toContain(adminBEmail);
    expect(emails).not.toContain(adminAEmail);
  });
});
