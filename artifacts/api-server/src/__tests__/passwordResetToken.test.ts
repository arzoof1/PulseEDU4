// DV-08 — activation/reset tokens expire and are single-use.
//
// Two layers:
//  1. Signer expiry + integrity — pure HMAC, runs WITHOUT a database.
//  2. End-to-end single-use + DB-side expiry against the real
//     /api/auth/reset-password endpoint — SKIPPED unless DATABASE_URL is set.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import request from "supertest";
import type { Express } from "express";

const HAS_DB = !!process.env.DATABASE_URL;

// ---- Layer 1: signer expiry + integrity (DB-free, always runs) ------------

describe("staff reset token — expiry & integrity (DV-08)", () => {
  let mod: typeof import("../lib/staffPasswordResetToken");

  beforeAll(async () => {
    // The module reads SESSION_SECRET at import; provide one if the env didn't.
    process.env.SESSION_SECRET ||= "test-secret-dv08-reset-token";
    mod = await import("../lib/staffPasswordResetToken");
  });

  it("verifies a freshly-issued, unexpired token", () => {
    const token = mod.issueStaffPasswordResetToken({
      resetId: 42,
      staffId: 7,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });
    expect(mod.verifyStaffPasswordResetToken(token)).toEqual({
      resetId: 42,
      staffId: 7,
    });
  });

  it("rejects an EXPIRED token", () => {
    const token = mod.issueStaffPasswordResetToken({
      resetId: 1,
      staffId: 1,
      expiresAt: new Date(Date.now() - 1000), // already past
    });
    expect(mod.verifyStaffPasswordResetToken(token)).toBeNull();
  });

  it("rejects a tampered payload (signature mismatch)", () => {
    const token = mod.issueStaffPasswordResetToken({
      resetId: 5,
      staffId: 9,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const [body, sig] = token.split(".");
    // Flip the payload but keep the original signature.
    const forgedBody = body.slice(0, -2) + (body.endsWith("AA") ? "BB" : "AA");
    expect(
      mod.verifyStaffPasswordResetToken(`${forgedBody}.${sig}`),
    ).toBeNull();
  });

  it("rejects malformed tokens", () => {
    expect(mod.verifyStaffPasswordResetToken("")).toBeNull();
    expect(mod.verifyStaffPasswordResetToken("nodot")).toBeNull();
    expect(mod.verifyStaffPasswordResetToken("a.b.c")).toBeNull();
  });

  it("hashes deterministically (stored as token_hash, never raw)", () => {
    const token = mod.issueStaffPasswordResetToken({
      resetId: 3,
      staffId: 3,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const h1 = mod.hashStaffPasswordResetToken(token);
    const h2 = mod.hashStaffPasswordResetToken(token);
    expect(h1).toBe(h2);
    expect(h1).not.toContain(token);
    expect(h1).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
  });
});

// ---- Layer 2: end-to-end single-use + DB expiry (needs a database) --------

describe.skipIf(!HAS_DB)("staff reset endpoint — single-use & expiry (DV-08)", () => {
  let db: typeof import("@workspace/db").db;
  let tables: typeof import("@workspace/db");
  let tokenMod: typeof import("../lib/staffPasswordResetToken");
  let app: Express;

  const tag = `dv08-${Date.now()}-${process.pid}`;
  const districtIds: number[] = [];
  let schoolId = 0;

  const NEW_PASSWORD = "Newpass1!"; // meets policy: upper/lower/number/special/>=8

  async function seedResetRow(
    staffId: number,
    email: string,
    expiresAt: Date,
  ): Promise<{ token: string }> {
    const [row] = await db
      .insert(tables.staffPasswordResetsTable)
      .values({ staffId, email, status: "email_sent", expiresAt })
      .returning();
    const token = tokenMod.issueStaffPasswordResetToken({
      resetId: row.id,
      staffId,
      // Sign with a FUTURE token-exp so signature-verify passes and we exercise
      // the DB-side expiry branch specifically via expiresAt on the row.
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });
    await db
      .update(tables.staffPasswordResetsTable)
      .set({ tokenHash: tokenMod.hashStaffPasswordResetToken(token) })
      .where(eq(tables.staffPasswordResetsTable.id, row.id));
    return { token };
  }

  beforeAll(async () => {
    tables = await import("@workspace/db");
    db = tables.db;
    tokenMod = await import("../lib/staffPasswordResetToken");
    app = (await import("../app")).default;

    const fx = await import("./support/authFixtures");
    const tenant = await fx.createTenant(tag);
    schoolId = tenant.schoolId;
    districtIds.push(tenant.districtId);
  });

  afterAll(async () => {
    if (!db) return;
    await db
      .delete(tables.staffPasswordResetsTable)
      .where(eq(tables.staffPasswordResetsTable.email, `teacher-${tag}@authmatrix.test.invalid`));
    await db.delete(tables.staffTable).where(eq(tables.staffTable.schoolId, schoolId));
    await db.delete(tables.schoolsTable).where(eq(tables.schoolsTable.id, schoolId));
    for (const id of districtIds) {
      await db.delete(tables.districtsTable).where(eq(tables.districtsTable.id, id));
    }
  });

  it("consumes a valid token once, then rejects reuse (single-use)", async () => {
    const fx = await import("./support/authFixtures");
    const staff = await fx.createStaff(schoolId, "teacher", tag);
    const { token } = await seedResetRow(
      staff.id,
      staff.email,
      new Date(Date.now() + 30 * 60 * 1000),
    );

    await request(app)
      .post("/api/auth/reset-password")
      .send({ token, newPassword: NEW_PASSWORD })
      .expect(200);

    // Second use of the same link must fail — usedAt is now set.
    await request(app)
      .post("/api/auth/reset-password")
      .send({ token, newPassword: NEW_PASSWORD })
      .expect(400);

    const [row] = await db
      .select({ usedAt: tables.staffPasswordResetsTable.usedAt })
      .from(tables.staffPasswordResetsTable)
      .where(
        and(
          eq(tables.staffPasswordResetsTable.staffId, staff.id),
          eq(tables.staffPasswordResetsTable.status, "used"),
        ),
      );
    expect(row?.usedAt).toBeTruthy();
  });

  it("rejects a token whose DB row has already expired", async () => {
    const fx = await import("./support/authFixtures");
    const staff = await fx.createStaff(schoolId, "teacher", `${tag}b`);
    const { token } = await seedResetRow(
      staff.id,
      staff.email,
      new Date(Date.now() - 60_000), // row already expired
    );
    await request(app)
      .post("/api/auth/reset-password")
      .send({ token, newPassword: NEW_PASSWORD })
      .expect(400);
  });
});
