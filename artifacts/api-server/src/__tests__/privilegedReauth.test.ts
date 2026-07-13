import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import {
  db,
  districtsTable,
  schoolsTable,
  staffTable,
} from "@workspace/db";
import app from "../app";
import { bcryptHash } from "../lib/bcrypt.js";

const tag = `reauth-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const PASSWORD = "Secret123!";

let districtId: number;
let schoolId: number;
let targetId: number;
let actorEmail = "";

beforeAll(async () => {
  const [district] = await db
    .insert(districtsTable)
    .values({ name: `Reauth District ${tag}`, slug: tag })
    .returning();
  districtId = district.id;

  const [school] = await db
    .insert(schoolsTable)
    .values({ districtId, name: `Reauth School ${tag}` })
    .returning();
  schoolId = school.id;

  const passwordHash = await bcryptHash(PASSWORD, 10);
  actorEmail = `admin-${tag}@reauth.test.invalid`;
  const [actor] = await db
    .insert(staffTable)
    .values({
      schoolId,
      email: actorEmail,
      passwordHash,
      displayName: "Reauth Admin",
      isAdmin: true,
    })
    .returning();

  const [target] = await db
    .insert(staffTable)
    .values({
      schoolId,
      email: `target-${tag}@reauth.test.invalid`,
      passwordHash: await bcryptHash("Target123!", 10),
      displayName: "Reauth Target",
      isGuardian: false,
    })
    .returning();
  targetId = target.id;
});

afterAll(async () => {
  await db.delete(staffTable).where(eq(staffTable.schoolId, schoolId));
  await db.delete(schoolsTable).where(eq(schoolsTable.id, schoolId));
  await db.delete(districtsTable).where(eq(districtsTable.id, districtId));
});

describe("privileged reauthentication for staff access edits", () => {
  it("rejects sensitive access changes without a fresh current-password check", async () => {
    const agent = request.agent(app);
    await agent
      .post("/api/auth/login")
      .send({ email: actorEmail, password: PASSWORD })
      .expect(200);

    const res = await agent
      .patch(`/api/admin/staff/${targetId}`)
      .send({ isGuardian: true })
      .expect(403);

    expect(res.body).toEqual({ error: "reauth_required" });
  });

  it("accepts the change when the current password is re-entered", async () => {
    const agent = request.agent(app);
    await agent
      .post("/api/auth/login")
      .send({ email: actorEmail, password: PASSWORD })
      .expect(200);

    const res = await agent
      .patch(`/api/admin/staff/${targetId}`)
      .send({
        isGuardian: true,
        reauth: { currentPassword: PASSWORD },
      })
      .expect(200);

    expect(res.body.isGuardian).toBe(true);

    const [row] = await db
      .select({ isGuardian: staffTable.isGuardian })
      .from(staffTable)
      .where(and(eq(staffTable.id, targetId), eq(staffTable.schoolId, schoolId)));
    expect(row?.isGuardian).toBe(true);
  });
});
