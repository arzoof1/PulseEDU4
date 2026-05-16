// Integration tests for the feature-licensing matrix.
//
// Exercises the full propagation path:
//   plan apply  → schoolSettings.super_feature_* flags
//   override   → effective map (and re-applied flags)
//   /api/me/features shape
//   requireFeature() middleware (404 for off features) on /api/ast/* and
//                                                       /api/admin/parent-invites
//   parentAuth backstop on POST /parent-auth/accept-invite (410 when off,
//                                                          200 when on)
//
// These run against the live dev DATABASE_URL. Fixtures are namespaced
// with a per-run random tag and torn down in afterAll.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  districtsTable,
  parentInvitesTable,
  parentStudentsTable,
  parentsTable,
  plansTable,
  schoolFeatureOverridesTable,
  schoolSettingsTable,
  schoolsTable,
  staffTable,
  studentsTable,
} from "@workspace/db";
import app from "../app";
import { issueAuthToken } from "../lib/authToken";
import { FEATURE_KEYS } from "../lib/featureLicensing";
import {
  ensureAstSchema,
  ensureFeaturePlansColumns,
  ensureFeaturePlansSchema,
} from "../seed";

const tag = `lic-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let districtId: number;
let schoolId: number;
let superUserId: number;
let adminStaffId: number;
let studentDbId: number;
let allOnPlanId: number;
let parentPortalOffPlanId: number;
let astOffPlanId: number;
let inviteToken: string;
let inviteId: number;

let superToken: string;
let adminToken: string;

const featuresAllOn: Record<string, true> = Object.fromEntries(
  FEATURE_KEYS.map((f) => [f.key, true]),
) as Record<string, true>;

beforeAll(async () => {
  // Make sure the licensing tables + plan columns exist. The dev DB has
  // already run these via the api-server boot path, but re-running is a
  // cheap no-op and lets the test suite stand on its own.
  await ensureFeaturePlansColumns();
  await ensureFeaturePlansSchema();
  await ensureAstSchema();

  const [district] = await db
    .insert(districtsTable)
    .values({ name: `Licensing Test ${tag}`, slug: tag })
    .returning();
  districtId = district.id;

  const [school] = await db
    .insert(schoolsTable)
    .values({ districtId, name: `Licensing School ${tag}` })
    .returning();
  schoolId = school.id;

  await db.insert(schoolSettingsTable).values({
    schoolId,
    schoolName: `Licensing ${tag}`,
  });

  const [su] = await db
    .insert(staffTable)
    .values({
      schoolId,
      email: `su-${tag}@licensing.test.invalid`,
      passwordHash: "x",
      displayName: "Licensing SU",
      isSuperUser: true,
      isAdmin: true,
    })
    .returning();
  superUserId = su.id;
  superToken = issueAuthToken(superUserId);

  const [adm] = await db
    .insert(staffTable)
    .values({
      schoolId,
      email: `adm-${tag}@licensing.test.invalid`,
      passwordHash: "x",
      displayName: "Licensing Admin",
      isAdmin: true,
    })
    .returning();
  adminStaffId = adm.id;
  adminToken = issueAuthToken(adminStaffId);

  const [plan1] = await db
    .insert(plansTable)
    .values({
      key: `all-on-${tag}`,
      label: "All On",
      features: featuresAllOn,
      quotas: {},
    })
    .returning();
  allOnPlanId = plan1.id;

  const parentPortalOffFeatures = { ...featuresAllOn };
  delete (parentPortalOffFeatures as Record<string, true>).parentPortal;
  const [plan2] = await db
    .insert(plansTable)
    .values({
      key: `pp-off-${tag}`,
      label: "Parent Portal Off",
      features: parentPortalOffFeatures,
      quotas: {},
    })
    .returning();
  parentPortalOffPlanId = plan2.id;

  const astOffFeatures = { ...featuresAllOn };
  delete (astOffFeatures as Record<string, true>).ast;
  const [plan3] = await db
    .insert(plansTable)
    .values({
      key: `ast-off-${tag}`,
      label: "AST Off",
      features: astOffFeatures,
      quotas: {},
    })
    .returning();
  astOffPlanId = plan3.id;

  const [student] = await db
    .insert(studentsTable)
    .values({
      schoolId,
      studentId: `S-${tag}`,
      firstName: "Test",
      lastName: "Student",
      grade: 5,
      parentEmail: `parent-${tag}@licensing.test.invalid`,
      parentName: "Test Parent",
    })
    .returning();
  studentDbId = student.id;

  // Real pending invite so the accept-invite backstop test isn't on a
  // synthetic token.
  inviteToken = `tok-${tag}-${Math.random().toString(36).slice(2)}`.padEnd(
    32,
    "x",
  );
  const [invite] = await db
    .insert(parentInvitesTable)
    .values({
      schoolId,
      studentId: studentDbId,
      email: `parent-${tag}@licensing.test.invalid`,
      token: inviteToken,
      status: "pending",
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7),
      sentByStaffId: adminStaffId,
    })
    .returning();
  inviteId = invite.id;

  // Land on the all-on plan as the baseline.
  await request(app)
    .patch(`/api/feature-licensing/schools/${schoolId}/plan`)
    .set("Authorization", `Bearer ${superToken}`)
    .send({ planId: allOnPlanId })
    .expect(200);
});

afterAll(async () => {
  // Best-effort cleanup. Order matters because some tables FK into others
  // (parent_students → parents + students, parents → schools, etc).
  try {
    const parents = await db
      .select({ id: parentsTable.id })
      .from(parentsTable)
      .where(eq(parentsTable.schoolId, schoolId));
    const parentIds = parents.map((p) => p.id);
    if (parentIds.length > 0) {
      await db
        .delete(parentStudentsTable)
        .where(inArray(parentStudentsTable.parentId, parentIds));
      await db
        .delete(parentsTable)
        .where(inArray(parentsTable.id, parentIds));
    }
    await db
      .delete(parentInvitesTable)
      .where(eq(parentInvitesTable.schoolId, schoolId));
    await db
      .delete(schoolFeatureOverridesTable)
      .where(eq(schoolFeatureOverridesTable.schoolId, schoolId));
    await db.delete(studentsTable).where(eq(studentsTable.schoolId, schoolId));
    await db.delete(staffTable).where(eq(staffTable.schoolId, schoolId));
    await db
      .delete(schoolSettingsTable)
      .where(eq(schoolSettingsTable.schoolId, schoolId));
    await db.delete(schoolsTable).where(eq(schoolsTable.id, schoolId));
    await db
      .delete(plansTable)
      .where(
        inArray(plansTable.id, [
          allOnPlanId,
          parentPortalOffPlanId,
          astOffPlanId,
        ]),
      );
    await db.delete(districtsTable).where(eq(districtsTable.id, districtId));
  } catch {
    // Swallow — test cleanup should never mask a real test failure.
  }
});

async function readSettingsFlag(
  col:
    | "superFeatureParentPortal"
    | "superFeatureAst"
    | "superFeatureHallPasses",
): Promise<boolean> {
  const [row] = await db
    .select()
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, schoolId))
    .limit(1);
  return Boolean((row as unknown as Record<string, unknown>)[col]);
}

async function assignPlan(planId: number) {
  await request(app)
    .patch(`/api/feature-licensing/schools/${schoolId}/plan`)
    .set("Authorization", `Bearer ${superToken}`)
    .send({ planId })
    .expect(200);
}

async function upsertOverride(
  featureKey: string,
  enabled: boolean,
): Promise<void> {
  await request(app)
    .post(`/api/feature-licensing/schools/${schoolId}/overrides`)
    .set("Authorization", `Bearer ${superToken}`)
    .send({ featureKey, enabled })
    .expect(200);
}

async function deleteOverride(featureKey: string): Promise<void> {
  const [existing] = await db
    .select()
    .from(schoolFeatureOverridesTable)
    .where(
      and(
        eq(schoolFeatureOverridesTable.schoolId, schoolId),
        eq(schoolFeatureOverridesTable.featureKey, featureKey),
      ),
    );
  if (!existing) return;
  await request(app)
    .delete(
      `/api/feature-licensing/schools/${schoolId}/overrides/${existing.id}`,
    )
    .set("Authorization", `Bearer ${superToken}`)
    .expect(200);
}

describe("feature licensing — end-to-end propagation", () => {
  it("assign plan → schoolSettings super_feature_* flags flip", async () => {
    // Baseline (all-on) — parent portal flag is true.
    expect(await readSettingsFlag("superFeatureParentPortal")).toBe(true);
    expect(await readSettingsFlag("superFeatureAst")).toBe(true);

    // Switch to a plan with parentPortal disabled → flag flips off.
    await assignPlan(parentPortalOffPlanId);
    expect(await readSettingsFlag("superFeatureParentPortal")).toBe(false);
    // Unrelated flags stay on (hallPasses is in both plans).
    expect(await readSettingsFlag("superFeatureHallPasses")).toBe(true);

    // Switch back; flag returns to on.
    await assignPlan(allOnPlanId);
    expect(await readSettingsFlag("superFeatureParentPortal")).toBe(true);
  });

  it("add override → effective map (and runtime flag) reflects it", async () => {
    // Force ast off via override on top of an all-on plan.
    await upsertOverride("ast", false);

    const res = await request(app)
      .get("/api/me/features")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body.features.ast.enabled).toBe(false);

    // Runtime flag is the actual gate; verify the override wrote through.
    expect(await readSettingsFlag("superFeatureAst")).toBe(false);

    // Restore.
    await upsertOverride("ast", true);
    expect(await readSettingsFlag("superFeatureAst")).toBe(true);
    await deleteOverride("ast");
  });

  it("/api/me/features shape matches the FEATURE_KEYS registry", async () => {
    const res = await request(app)
      .get("/api/me/features")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    const map = res.body.features as Record<string, unknown>;
    expect(Object.keys(map).sort()).toEqual(
      FEATURE_KEYS.map((f) => f.key).sort(),
    );
    for (const f of FEATURE_KEYS) {
      const entry = map[f.key] as Record<string, unknown>;
      expect(entry).toBeDefined();
      expect(typeof entry.enabled).toBe("boolean");
      expect(typeof entry.showUpsell).toBe("boolean");
      expect(typeof entry.quotas).toBe("object");
    }
  });

  it("/api/ast/* returns 404 when ast license is off", async () => {
    // Verify it works first so a 404 in the off-case actually means the
    // gate fired (not "route missing" or "no school context").
    await request(app)
      .get("/api/ast/me")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    await upsertOverride("ast", false);

    const off = await request(app)
      .get("/api/ast/me")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(404);
    expect(off.body.error).toBe("feature_not_available");

    await deleteOverride("ast");
  });

  it("/api/admin/parent-invites returns 404 when parentPortal off", async () => {
    // On baseline — admin can read the list.
    await request(app)
      .get("/api/admin/parent-invites")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    await upsertOverride("parentPortal", false);

    const off = await request(app)
      .get("/api/admin/parent-invites")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(404);
    expect(off.body.error).toBe("feature_not_available");

    await deleteOverride("parentPortal");
  });

  it("POST /parent-auth/accept-invite: 410 when license off, 200 when on (real pending invite)", async () => {
    // Turn parent portal off via override.
    await upsertOverride("parentPortal", false);
    expect(await readSettingsFlag("superFeatureParentPortal")).toBe(false);

    const off = await request(app)
      .post("/api/parent-auth/accept-invite")
      .send({
        token: inviteToken,
        password: "correcthorsebatterystaple",
        displayName: "Licensing Parent",
      })
      .expect(410);
    expect(off.body.error).toBeDefined();

    // Invite must still be pending — the 410 path returns BEFORE consuming.
    const [stillPending] = await db
      .select({ status: parentInvitesTable.status })
      .from(parentInvitesTable)
      .where(eq(parentInvitesTable.id, inviteId));
    expect(stillPending.status).toBe("pending");

    // Restore license and retry — should succeed and consume the invite.
    await deleteOverride("parentPortal");
    expect(await readSettingsFlag("superFeatureParentPortal")).toBe(true);

    const on = await request(app)
      .post("/api/parent-auth/accept-invite")
      .send({
        token: inviteToken,
        password: "correcthorsebatterystaple",
        displayName: "Licensing Parent",
      })
      .expect(200);
    expect(on.body.email).toBe(
      `parent-${tag}@licensing.test.invalid`,
    );

    const [consumed] = await db
      .select({ status: parentInvitesTable.status })
      .from(parentInvitesTable)
      .where(eq(parentInvitesTable.id, inviteId));
    expect(consumed.status).toBe("accepted");
  });
});
