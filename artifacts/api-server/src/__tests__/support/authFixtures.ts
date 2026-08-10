// Reusable authorization test fixtures (DV-03). Factory helpers to stand up a
// district → school → staff-of-a-given-role graph and log in as any of them,
// so per-role / cross-tenant access tests don't re-invent seeding each time.
//
// This module imports @workspace/db (which throws at import when DATABASE_URL
// is unset), so callers must import it DYNAMICALLY from inside a
// describe.skipIf(!DATABASE_URL) block — see authorizationMatrix.test.ts.

import request from "supertest";
import type { Express } from "express";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  districtsTable,
  schoolsTable,
  staffTable,
} from "@workspace/db";
import { bcryptHash } from "../../lib/bcrypt.js";

export type TestRole =
  | "superuser"
  | "districtadmin"
  | "admin"
  | "coreteam"
  | "teacher";

// Map a coarse role name to the exact legacy flag(s) that grant it. Teacher is
// the "no privileged flags" baseline.
function flagsForRole(role: TestRole): Record<string, boolean> {
  switch (role) {
    case "superuser":
      return { isSuperUser: true };
    case "districtadmin":
      return { isDistrictAdmin: true };
    case "admin":
      return { isAdmin: true };
    case "coreteam":
      return { isCoreTeam: true };
    case "teacher":
      return {};
  }
}

export interface Tenant {
  districtId: number;
  schoolId: number;
}

export interface TestStaff {
  id: number;
  email: string;
  role: TestRole;
}

export const TEST_PASSWORD = "Secret123!";

export async function createTenant(tag: string): Promise<Tenant> {
  const [district] = await db
    .insert(districtsTable)
    .values({ name: `Auth District ${tag}`, slug: tag })
    .returning();
  const [school] = await db
    .insert(schoolsTable)
    .values({ districtId: district.id, name: `Auth School ${tag}` })
    .returning();
  return { districtId: district.id, schoolId: school.id };
}

export async function createStaff(
  schoolId: number,
  role: TestRole,
  tag: string,
): Promise<TestStaff> {
  // Lowercase: the app normalizes emails to lowercase on login, so a mixed-case
  // tag would otherwise never match the lookup.
  const email = `${role}-${tag}@authmatrix.test.invalid`.toLowerCase();
  const passwordHash = await bcryptHash(TEST_PASSWORD, 10);
  const [row] = await db
    .insert(staffTable)
    .values({
      schoolId,
      email,
      passwordHash,
      displayName: `${role} ${tag}`,
      ...flagsForRole(role),
    })
    .returning();
  return { id: row.id, email, role };
}

// Log in via the same cookie flow the app uses; returns a supertest agent that
// carries the session cookie across subsequent requests.
export async function loginAs(
  app: Express,
  email: string,
): Promise<ReturnType<typeof request.agent>> {
  const agent = request.agent(app);
  await agent
    .post("/api/auth/login")
    .send({ email, password: TEST_PASSWORD })
    .expect(200);
  return agent;
}

// Like loginAs, but also returns the CSRF token from the login response so the
// caller can drive CSRF-protected POSTs (e.g. step-up reauth).
export async function loginAndCsrf(
  app: Express,
  email: string,
): Promise<{ agent: ReturnType<typeof request.agent>; csrfToken: string }> {
  const agent = request.agent(app);
  const res = await agent
    .post("/api/auth/login")
    .send({ email, password: TEST_PASSWORD })
    .expect(200);
  return { agent, csrfToken: res.body.csrfToken as string };
}

// Perform a step-up privileged reauth (Section 1.15) so a fresh-reauth-gated
// read (Safety Plan view, data-imports export) is permitted for ~5 minutes.
export async function reauth(
  agent: ReturnType<typeof request.agent>,
  csrfToken: string,
): Promise<void> {
  await agent
    .post("/api/auth/reauth")
    .set("x-csrf-token", csrfToken)
    .send({ currentPassword: TEST_PASSWORD })
    .expect(200);
}

// Tear down every staff row in the given schools, then the schools + districts.
export async function cleanupTenants(
  schoolIds: number[],
  districtIds: number[],
): Promise<void> {
  if (schoolIds.length) {
    await db.delete(staffTable).where(inArray(staffTable.schoolId, schoolIds));
    await db.delete(schoolsTable).where(inArray(schoolsTable.id, schoolIds));
  }
  for (const id of districtIds) {
    await db.delete(districtsTable).where(eq(districtsTable.id, id));
  }
}
