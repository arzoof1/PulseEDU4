// DV-01 — Row-Level Security Phase 1, isolation proof.
//
// Applies lib/db/rls/phase1_policies.sql to the test DB, then runs queries
// under a dedicated NON-owner, NOBYPASSRLS role via SET ROLE (which makes RLS
// apply even though the login role is a superuser). Proves the policies block
// cross-tenant reads: scoped to school A the role sees A's student and NOT B's,
// and vice-versa; with no tenant GUC it sees nothing (fail-closed). Also
// confirms the OWNER connection (what production uses today) still sees
// everything — applying this is INERT for prod until a restricted role is
// activated. Requires DATABASE_URL; skipped otherwise.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HAS_DB = !!process.env.DATABASE_URL;
const tag = `rls-${Date.now()}-${process.pid}`;
const ROLE = "rls_phase1_test";

describe.skipIf(!HAS_DB)("RLS Phase 1 tenant isolation (DV-01)", () => {
  let db: typeof import("@workspace/db").db;
  let T: typeof import("@workspace/db");

  const districtIds: number[] = [];
  let schoolA = 0;
  let schoolB = 0;
  const studentA = `rlsA-${tag}`;
  const studentB = `rlsB-${tag}`;

  // Count visible `students` rows for a studentId while acting AS the restricted
  // role, scoped to `scope` (null = no tenant GUC). SET ROLE drops the login
  // role's superuser bypass so RLS applies; SET LOCAL keeps it transaction-local.
  async function visibleAsRole(
    studentId: string,
    scope: number | null,
  ): Promise<number> {
    return db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET ROLE ${ROLE}`));
      if (scope !== null) {
        await tx.execute(
          sql`SELECT set_config('app.current_school_id', ${String(scope)}, true)`,
        );
      }
      const r = await tx.execute(
        sql`SELECT count(*)::int AS c FROM students WHERE student_id = ${studentId}`,
      );
      await tx.execute(sql.raw("RESET ROLE"));
      return (r.rows[0] as { c: number }).c;
    });
  }

  beforeAll(async () => {
    T = await import("@workspace/db");
    db = T.db;

    // 1. Apply the RLS policy artifact.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const sqlPath = path.resolve(here, "../../../../lib/db/rls/phase1_policies.sql");
    await db.execute(sql.raw(readFileSync(sqlPath, "utf8")));

    // 2. Restricted, non-owner role (NOLOGIN — reached only via SET ROLE).
    await db.execute(
      sql.raw(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${ROLE}') THEN
          CREATE ROLE ${ROLE};
        END IF;
      END $$;`),
    );
    await db.execute(sql.raw(`GRANT USAGE ON SCHEMA public TO ${ROLE}`));
    await db.execute(sql.raw(`GRANT SELECT ON students TO ${ROLE}`));

    // 3. Two isolated tenants, one student each.
    const fx = await import("./support/authFixtures");
    const a = await fx.createTenant(`${tag}A`);
    const b = await fx.createTenant(`${tag}B`);
    schoolA = a.schoolId;
    schoolB = b.schoolId;
    districtIds.push(a.districtId, b.districtId);
    await db.insert(T.studentsTable).values([
      { schoolId: schoolA, studentId: studentA, firstName: "A", lastName: "One", grade: 5 },
      { schoolId: schoolB, studentId: studentB, firstName: "B", lastName: "Two", grade: 5 },
    ]);
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(T.studentsTable).where(inArray(T.studentsTable.schoolId, [schoolA, schoolB]));
    await db.delete(T.schoolsTable).where(inArray(T.schoolsTable.id, [schoolA, schoolB]));
    for (const id of districtIds) {
      await db.delete(T.districtsTable).where(eq(T.districtsTable.id, id));
    }
    await db.execute(sql.raw(`DROP OWNED BY ${ROLE}`)).catch(() => {});
    await db.execute(sql.raw(`DROP ROLE IF EXISTS ${ROLE}`)).catch(() => {});
  });

  it("enables RLS on all three pilot tables", async () => {
    const r = await db.execute(
      sql`select relname, relrowsecurity from pg_class where relname in ('students','safety_plans','interaction_cases')`,
    );
    const rows = r.rows as Array<{ relname: string; relrowsecurity: boolean }>;
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row.relrowsecurity).toBe(true);
  });

  it("with NO tenant GUC, the restricted role sees nothing (fail-closed)", async () => {
    expect(await visibleAsRole(studentA, null)).toBe(0);
    expect(await visibleAsRole(studentB, null)).toBe(0);
  });

  it("scoped to school A: sees A's student, NOT B's", async () => {
    expect(await visibleAsRole(studentA, schoolA)).toBe(1);
    expect(await visibleAsRole(studentB, schoolA)).toBe(0);
  });

  it("scoped to school B: sees B's student, NOT A's", async () => {
    expect(await visibleAsRole(studentB, schoolB)).toBe(1);
    expect(await visibleAsRole(studentA, schoolB)).toBe(0);
  });

  it("the OWNER connection (production today) is UNAFFECTED — sees both", async () => {
    const rows = await db
      .select({ id: T.studentsTable.id })
      .from(T.studentsTable)
      .where(
        and(
          inArray(T.studentsTable.schoolId, [schoolA, schoolB]),
          inArray(T.studentsTable.studentId, [studentA, studentB]),
        ),
      );
    expect(rows).toHaveLength(2);
  });
});
