// DV-06 — fresh-provisioning idempotency + self-heal for staff_password_resets.
//
// Verifies the fixed boot ensure (seed.ts::ensureStaffPasswordResetsSchema):
//   1. runs twice without error and yields the current token_hash schema, and
//   2. repairs a LEGACY table shape (token NOT NULL, no email/token_hash) — the
//      exact shape that broke staff password resets on a freshly-provisioned DB.
// Requires DATABASE_URL; skipped otherwise.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("staff_password_resets provisioning (DV-06)", () => {
  let db: typeof import("@workspace/db").db;
  let ensure: () => Promise<void>;

  beforeAll(async () => {
    db = (await import("@workspace/db")).db;
    ensure = (await import("../seed")).ensureStaffPasswordResetsSchema;
  });

  async function columns(): Promise<Set<string>> {
    const r = await db.execute(
      sql`select column_name from information_schema.columns where table_name='staff_password_resets'`,
    );
    return new Set((r.rows as Array<{ column_name: string }>).map((x) => x.column_name));
  }

  afterAll(async () => {
    // Leave a valid current-shape table for any suite that runs after this one.
    if (ensure) await ensure();
  });

  it("is idempotent and yields the current token_hash schema", async () => {
    await ensure();
    await ensure(); // second run must be a no-op, not an error
    const cols = await columns();
    for (const c of [
      "token_hash",
      "email",
      "status",
      "request_ip",
      "used_ip",
      "expires_at",
      "used_at",
    ]) {
      expect(cols.has(c)).toBe(true);
    }
    // An app-shaped insert (email + token_hash + status, no legacy `token`) works.
    await db.execute(
      sql`insert into staff_password_resets (email, token_hash, status, expires_at)
          values ('dv06a@test.invalid', 'hash_dv06a', 'email_sent', now() + interval '30 minutes')`,
    );
  });

  it("self-heals a legacy (token NOT NULL) table shape", async () => {
    // Recreate the pre-fix legacy shape that broke fresh provisioning.
    await db.execute(sql`DROP TABLE IF EXISTS staff_password_resets`);
    await db.execute(sql`
      CREATE TABLE staff_password_resets (
        id serial primary key,
        staff_id integer not null,
        token text not null,
        expires_at timestamptz not null,
        used_at timestamptz,
        created_at timestamptz not null default now(),
        requested_ip text
      )
    `);

    await ensure(); // must repair the shape, not throw

    const cols = await columns();
    expect(cols.has("token_hash")).toBe(true);
    expect(cols.has("email")).toBe(true);
    expect(cols.has("status")).toBe(true);

    // The legacy `token` column must now be nullable (the app never sets it).
    const r = await db.execute(
      sql`select is_nullable from information_schema.columns
          where table_name='staff_password_resets' and column_name='token'`,
    );
    expect((r.rows[0] as { is_nullable: string }).is_nullable).toBe("YES");

    // An app-shaped insert (no token, no staff_id) now succeeds — before the
    // fix this failed because `token`/`staff_id` were NOT NULL and email/
    // token_hash didn't exist.
    await db.execute(
      sql`insert into staff_password_resets (email, token_hash, status, expires_at)
          values ('dv06b@test.invalid', 'hash_dv06b', 'email_sent', now() + interval '30 minutes')`,
    );
  });
});
