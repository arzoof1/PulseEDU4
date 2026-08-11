// Bulk temp-password generation (POST /api/sis-sync/temp-passwords) plus the
// forced-password-change wall it depends on.
//
// This is the flow that gets a whole school online while district email is off:
// one click issues a DISTINCT one-time password per staff member, flags each
// account must_set_password, and the passwordSetupGate then blocks those
// accounts everywhere except /auth/change-password. The tests below cover both
// halves end-to-end over real HTTP, plus the safety rails that stop an admin
// locking themselves out or resetting someone above their authority.
//
// Requires DATABASE_URL; skipped otherwise.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("bulk temp passwords + forced change", () => {
  let app: import("express").Express;
  let db: typeof import("@workspace/db").db;
  let staffTable: typeof import("@workspace/db").staffTable;
  let districtIntegrationsTable: typeof import("@workspace/db").districtIntegrationsTable;
  let fx: typeof import("./support/authFixtures");

  let tenant: { districtId: number; schoolId: number };
  let other: { districtId: number; schoolId: number };
  let superUser: { id: number; email: string };
  let integrationId: number;
  const TAG = "tmppw";

  beforeAll(async () => {
    const dbMod = await import("@workspace/db");
    db = dbMod.db;
    staffTable = dbMod.staffTable;
    districtIntegrationsTable = dbMod.districtIntegrationsTable;
    app = (await import("../app")).default;
    fx = await import("./support/authFixtures");

    // testSchemaSync creates tables but skips indexes; login + staff creation
    // rely on the global unique email, and the generator's scope filter uses
    // the must_set_password partial index.
    await db.execute(
      sql`CREATE UNIQUE INDEX IF NOT EXISTS staff_email_unique ON staff (email)`,
    );

    tenant = await fx.createTenant(`${TAG}-a`);
    other = await fx.createTenant(`${TAG}-b`);
    superUser = await fx.createStaff(tenant.schoolId, "superuser", TAG);
    // Three ordinary teachers to receive passwords.
    await fx.createStaff(tenant.schoolId, "teacher", `${TAG}1`);
    await fx.createStaff(tenant.schoolId, "teacher", `${TAG}2`);
    await fx.createStaff(tenant.schoolId, "teacher", `${TAG}3`);

    const [integration] = await db
      .insert(districtIntegrationsTable)
      .values({
        schoolName: `Auth School ${TAG}-a`,
        sisProvider: "classlink",
        sisConfig: { useFixtures: true, schoolId: tenant.schoolId },
      })
      .returning();
    integrationId = integration!.id;
  });

  afterAll(async () => {
    if (!db) return;
    await db
      .delete(districtIntegrationsTable)
      .where(eq(districtIntegrationsTable.id, integrationId));
    await fx.cleanupTenants(
      [tenant.schoolId, other.schoolId],
      [tenant.districtId, other.districtId],
    );
  });

  async function post(
    agent: Awaited<ReturnType<typeof fx.loginAndCsrf>>,
    body: Record<string, unknown>,
  ) {
    return agent.agent
      .post("/api/sis-sync/temp-passwords")
      .set("x-csrf-token", agent.csrfToken)
      .send(body);
  }

  it("generates a distinct password per staff member and flags each account", async () => {
    const session = await fx.loginAndCsrf(app, superUser.email);
    const res = await post(session, { schoolId: tenant.schoolId, scope: "all" });

    expect(res.status).toBe(200);
    // Three teachers; the acting SuperUser must be excluded from their own run.
    expect(res.body.generated).toBe(3);
    const rows = res.body.results as Array<{
      staffId: number;
      tempPassword: string;
    }>;
    expect(new Set(rows.map((r) => r.tempPassword)).size).toBe(3);
    expect(rows.every((r) => r.tempPassword.length >= 12)).toBe(true);

    for (const r of rows) {
      const [row] = await db
        .select({ mustSetPassword: staffTable.mustSetPassword })
        .from(staffTable)
        .where(eq(staffTable.id, r.staffId));
      expect(row!.mustSetPassword).toBe(true);
    }
  });

  it("never includes the acting admin's own account", async () => {
    const session = await fx.loginAndCsrf(app, superUser.email);
    const res = await post(session, { schoolId: tenant.schoolId, scope: "all" });

    const ids = (res.body.results as Array<{ staffId: number }>).map(
      (r) => r.staffId,
    );
    expect(ids).not.toContain(superUser.id);
    expect(
      (res.body.skipped as Array<{ reason: string }>).some((s) =>
        s.reason.includes("your own account"),
      ),
    ).toBe(true);

    // And the actor can still sign in with their original password.
    const [me] = await db
      .select({ mustSetPassword: staffTable.mustSetPassword })
      .from(staffTable)
      .where(eq(staffTable.id, superUser.id));
    expect(me!.mustSetPassword).toBe(false);
  });

  it("issued password works, and the account is then walled to change-password", async () => {
    const session = await fx.loginAndCsrf(app, superUser.email);
    const gen = await post(session, {
      schoolId: tenant.schoolId,
      scope: "all",
    });
    const target = (
      gen.body.results as Array<{ email: string; tempPassword: string }>
    )[0]!;

    const request = (await import("supertest")).default;
    const agent = request.agent(app);
    const login = await agent
      .post("/api/auth/login")
      .send({ email: target.email, password: target.tempPassword });
    expect(login.status).toBe(200);
    // The client reads this to raise the forced screen.
    expect(login.body.mustSetPassword).toBe(true);

    // Everything else is walled...
    const blocked = await agent.get("/api/admin/staff");
    expect(blocked.status).toBe(403);
    expect(blocked.body).toEqual({ error: "password_setup_required" });

    // ...except changing the password, which clears the flag.
    const changed = await agent
      .post("/api/auth/change-password")
      .set("x-csrf-token", login.body.csrfToken as string)
      .send({
        currentPassword: target.tempPassword,
        newPassword: "BrandNew123!",
      });
    expect(changed.status).toBe(200);

    const after = request.agent(app);
    const relogin = await after
      .post("/api/auth/login")
      .send({ email: target.email, password: "BrandNew123!" });
    expect(relogin.status).toBe(200);
    expect(relogin.body.mustSetPassword).toBe(false);
    // No longer walled.
    expect((await after.get("/api/auth/me")).status).toBe(200);
  });

  it("scope=needsPassword only touches accounts still owing a password", async () => {
    const session = await fx.loginAndCsrf(app, superUser.email);
    // Everyone at this school was flagged by the earlier runs; clear one.
    const targets = await db
      .select({ id: staffTable.id })
      .from(staffTable)
      .where(eq(staffTable.schoolId, tenant.schoolId));
    await db
      .update(staffTable)
      .set({ mustSetPassword: false })
      .where(eq(staffTable.id, targets[0]!.id));
    await db
      .update(staffTable)
      .set({ mustSetPassword: true })
      .where(eq(staffTable.id, targets[1]!.id));

    const res = await post(session, {
      schoolId: tenant.schoolId,
      scope: "needsPassword",
    });
    const ids = (res.body.results as Array<{ staffId: number }>).map(
      (r) => r.staffId,
    );
    expect(ids).not.toContain(targets[0]!.id);
  });

  it("refuses a school outside the actor's district", async () => {
    const session = await fx.loginAndCsrf(app, superUser.email);
    const res = await post(session, {
      schoolId: other.schoolId,
      scope: "all",
    });
    expect(res.status).toBe(403);
  });

  it("rejects a non-privileged caller", async () => {
    const teacher = await fx.createStaff(tenant.schoolId, "teacher", `${TAG}gate`);
    // A teacher flagged by an earlier run would be walled by passwordSetupGate
    // before reaching the route; clear it so this asserts the ROLE gate.
    await db
      .update(staffTable)
      .set({ mustSetPassword: false })
      .where(eq(staffTable.id, teacher.id));
    const session = await fx.loginAndCsrf(app, teacher.email);
    const res = await post(session, {
      schoolId: tenant.schoolId,
      scope: "all",
    });
    expect(res.status).toBe(403);
  });

  it("reports remaining work instead of silently truncating", async () => {
    const session = await fx.loginAndCsrf(app, superUser.email);
    const res = await post(session, { schoolId: tenant.schoolId, scope: "all" });
    // Small fixture school: one page covers it, so nothing is left pending —
    // the contract the UI's paging loop terminates on.
    expect(res.body.remaining).toBe(0);
    expect(res.body.nextOffset).toBeNull();
    expect(res.body.generated).toBe(res.body.eligible);
  });
});
