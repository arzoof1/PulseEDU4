// DV-10 — parent bearer-token version revocation.
//
// Layer 1 (DB-free): the token carries a version that round-trips.
// Layer 2 (needs DATABASE_URL): requireActiveParent honors a current-version
// bearer token, then rejects that SAME token the instant the version is bumped
// (logout / reset / admin revoke), and honors a freshly-issued token.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const HAS_DB = !!process.env.DATABASE_URL;
const tag = `dv10-${Date.now()}-${process.pid}`;

// ---- Layer 1: token version round-trips (DB-free) -------------------------
describe("parent token carries a version (DV-10)", () => {
  let mod: typeof import("../lib/authToken");
  beforeAll(async () => {
    process.env.SESSION_SECRET ||= "test-secret-dv10";
    mod = await import("../lib/authToken");
  });

  it("round-trips the embedded version", () => {
    const token = mod.issueParentAuthToken(42, 7);
    expect(mod.verifyParentAuthToken(token)).toEqual({
      parentId: 42,
      tokenVersion: 7,
    });
  });

  it("defaults a version-less (legacy) token to version 0", () => {
    const token = mod.issueParentAuthToken(9); // no version arg
    expect(mod.verifyParentAuthToken(token)).toEqual({
      parentId: 9,
      tokenVersion: 0,
    });
  });
});

// ---- Layer 2: enforcement in requireActiveParent (needs a DB) -------------
describe.skipIf(!HAS_DB)("requireActiveParent enforces the version (DV-10)", () => {
  let db: typeof import("@workspace/db").db;
  let T: typeof import("@workspace/db");
  let authToken: typeof import("../lib/authToken");
  let bearer: typeof import("../lib/parentBearerAuth");
  let mw: typeof import("../lib/parentAuthMiddleware");

  const districtIds: number[] = [];
  let schoolId = 0;
  let parentId = 0;

  function run(token: string | null) {
    const req = {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      session: { destroy: (cb: () => void) => cb() },
    } as never as import("express").Request;
    const res = {
      statusCode: 0,
      body: null as unknown,
      status(c: number) {
        (this as { statusCode: number }).statusCode = c;
        return this;
      },
      json(b: unknown) {
        (this as { body: unknown }).body = b;
        return this;
      },
    };
    const next = vi.fn();
    return { req, res, next };
  }

  beforeAll(async () => {
    T = await import("@workspace/db");
    db = T.db;
    authToken = await import("../lib/authToken");
    bearer = await import("../lib/parentBearerAuth");
    mw = await import("../lib/parentAuthMiddleware");

    // The pre-existing test DB predates the new column; add it up front (prod
    // does the same via ensureParentMessagesSchema at boot).
    await bearer.ensureParentAuthTokenVersionColumn();

    const fx = await import("./support/authFixtures");
    const tenant = await fx.createTenant(tag);
    schoolId = tenant.schoolId;
    districtIds.push(tenant.districtId);
    const [p] = await db
      .insert(T.parentsTable)
      .values({
        schoolId,
        email: `parent-${tag}@dv10.test.invalid`,
        displayName: "DV10 Parent",
      })
      .returning({ id: T.parentsTable.id });
    parentId = p.id;
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(T.parentsTable).where(eq(T.parentsTable.schoolId, schoolId));
    await db.delete(T.schoolsTable).where(eq(T.schoolsTable.id, schoolId));
    for (const id of districtIds) {
      await db.delete(T.districtsTable).where(eq(T.districtsTable.id, id));
    }
  });

  it("accepts a current-version bearer token", async () => {
    const token = await bearer.issueParentBearerToken(parentId);
    const { req, res, next } = run(token);
    await mw.requireActiveParent(req, res as never, next as never);
    expect(next).toHaveBeenCalledOnce();
    expect(req.parentId).toBe(parentId);
    expect(res.statusCode).toBe(0);
  });

  it("REJECTS that same token the instant the version is bumped", async () => {
    const token = await bearer.issueParentBearerToken(parentId);
    await bearer.bumpParentAuthTokenVersion(parentId); // e.g. logout / reset / revoke

    const { req, res, next } = run(token);
    await mw.requireActiveParent(req, res as never, next as never);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(req.parentId).toBeNull();
  });

  it("accepts a freshly-issued token after the bump", async () => {
    const fresh = await bearer.issueParentBearerToken(parentId); // stamped with new version
    const { req, res, next } = run(fresh);
    await mw.requireActiveParent(req, res as never, next as never);
    expect(next).toHaveBeenCalledOnce();
    expect(req.parentId).toBe(parentId);
  });

  it("rejects a token for a deactivated parent (active-flag check still holds)", async () => {
    const token = await bearer.issueParentBearerToken(parentId);
    await db
      .update(T.parentsTable)
      .set({ active: false })
      .where(eq(T.parentsTable.id, parentId));
    const { req, res, next } = run(token);
    await mw.requireActiveParent(req, res as never, next as never);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    // restore for any later runs
    await db
      .update(T.parentsTable)
      .set({ active: true })
      .where(eq(T.parentsTable.id, parentId));
  });
});
