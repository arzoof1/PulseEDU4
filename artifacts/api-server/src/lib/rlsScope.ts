// DV-01 — per-request tenant context for Row-Level Security (Phase 1).
//
// RLS policies (lib/db/rls/phase1_policies.sql) read the tenant from a
// transaction-local GUC `app.current_school_id`. This helper runs a callback
// inside a transaction with that GUC set, so any query issued via the passed
// `tx` is DB-enforced to the given school.
//
// Opt-in by design: existing routes are unchanged, so this changes nothing on
// production today (and RLS is bypassed by the owner role until a restricted
// role is activated — see the SQL file). Callers can migrate the most sensitive
// reads onto withSchoolScope over time to get the DB-enforced second wall.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Run `fn` in a transaction scoped to `schoolId`. The GUC is set with
 * is_local=true so it is automatically reset when the transaction ends — no
 * leakage onto the pooled connection.
 */
export async function withSchoolScope<T>(
  schoolId: number,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.current_school_id', ${String(schoolId)}, true)`,
    );
    return fn(tx);
  });
}
