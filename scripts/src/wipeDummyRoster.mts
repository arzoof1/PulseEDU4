/**
 * wipeDummyRoster — clean-slate the tenant/operational data before the first
 * real ClassLink roster import, PRESERVING super-user staff accounts and
 * per-school configuration.
 *
 * Strategy (schema-driven, so it can't miss a table): TRUNCATE every public
 * table that carries a `school_id` tenant column — students, hall passes, PBIS,
 * attendance, class sections, rosters, safety plans, cases, etc. — with CASCADE
 * (clears student/staff-keyed child tables too), EXCEPT an explicit PRESERVE
 * set. Then delete non-super-user staff. Schools/districts are kept (the setup
 * script upserts the real ones over them by state code).
 *
 * PRESERVE set: staff (handled specially — keep super-users), school_settings
 * and school_heartbeat_settings (feature/config, so the app keeps working).
 *
 * *** DESTRUCTIVE. DRY-RUN by default. *** To actually wipe, ALL of:
 *   - env CONFIRM_WIPE=YES
 *   - env SNAPSHOT_ID=<the RDS snapshot you just took>
 *   - flag --apply
 * Runs in one transaction (rolls back on any error).
 *
 * Usage (prod, from repo root):
 *   DATABASE_URL=... pnpm --filter @workspace/scripts classlink-wipe          # dry run
 *   DATABASE_URL=... CONFIRM_WIPE=YES SNAPSHOT_ID=rds:pulseedu-2026-08-06 \
 *     pnpm --filter @workspace/scripts classlink-wipe -- --apply
 */
import { db, pool, staffTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";

// Tables that have a school_id column but must NOT be truncated.
const PRESERVE = new Set<string>([
  "staff", // super-users preserved via targeted delete below
  "school_settings", // per-school feature flags — keep so the app works
  "school_heartbeat_settings", // parent-portal config
]);

type Row = Record<string, unknown>;
function rowsOf(res: unknown): Row[] {
  const r = res as { rows?: Row[] };
  return Array.isArray(r.rows) ? r.rows : (res as Row[]);
}

async function tablesWithSchoolId(): Promise<string[]> {
  const res = await db.execute(sql`
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'school_id'
    ORDER BY table_name
  `);
  return rowsOf(res)
    .map((r) => String(r.table_name))
    .filter((t) => !PRESERVE.has(t));
}

async function count(table: string): Promise<number> {
  const res = await db.execute(sql.raw(`SELECT COUNT(*)::int AS n FROM "${table}"`));
  return Number(rowsOf(res)[0]?.n ?? 0);
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const confirmed = process.env.CONFIRM_WIPE === "YES";
  const snapshotId = process.env.SNAPSHOT_ID?.trim();

  console.log(`\n[classlink-wipe] ${apply ? "APPLY (DESTRUCTIVE)" : "DRY-RUN"}\n`);

  const targets = await tablesWithSchoolId();

  // Staff accounting.
  const superUsers = await db
    .select({ id: staffTable.id, email: staffTable.email })
    .from(staffTable)
    .where(eq(staffTable.isSuperUser, true));
  const totalStaff = await count("staff");

  // Preview: row counts on the biggest targets so the operator sees the scope.
  const previewed = await Promise.all(
    targets.map(async (t) => ({ table: t, rows: await count(t) })),
  );
  const nonEmpty = previewed.filter((p) => p.rows > 0).sort((a, b) => b.rows - a.rows);
  console.log(
    `Will TRUNCATE ${targets.length} tenant tables (${nonEmpty.length} non-empty). Top by rows:`,
  );
  console.table(nonEmpty.slice(0, 15));
  console.log(
    `Staff: ${totalStaff} total → keep ${superUsers.length} super-user(s), delete ${totalStaff - superUsers.length}.`,
  );
  console.log(
    `Super-users preserved:\n` +
      (superUsers.length
        ? superUsers.map((s) => `   - ${s.email} (id ${s.id})`).join("\n")
        : "   ⚠ NONE FOUND — you will have no super-user login after this!"),
  );

  if (!apply) {
    console.log(`\nDry run complete. To execute: set CONFIRM_WIPE=YES + SNAPSHOT_ID + --apply.\n`);
    return;
  }

  // Guards.
  if (!confirmed) throw new Error("Refusing to wipe: env CONFIRM_WIPE=YES not set.");
  if (!snapshotId)
    throw new Error("Refusing to wipe: env SNAPSHOT_ID (your fresh RDS snapshot) not set.");
  if (superUsers.length === 0)
    throw new Error("Refusing to wipe: no super-user found — you'd be locked out. Seed one first.");

  console.log(`\nSnapshot on record: ${snapshotId}. Proceeding in a transaction...\n`);

  await db.transaction(async (tx) => {
    if (targets.length > 0) {
      const list = targets.map((t) => `"${t}"`).join(", ");
      await tx.execute(sql.raw(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`));
    }
    await tx.delete(staffTable).where(eq(staffTable.isSuperUser, false));
  });

  const staffAfter = await count("staff");
  console.log(
    `\n✅ Wiped ${targets.length} tenant tables. Staff now: ${staffAfter} (super-users only).\n` +
      `Next: run classlink-setup --apply, then the first one-school sync.\n`,
  );
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error("[classlink-wipe] FAILED (no changes committed):", err);
    await pool.end();
    process.exit(1);
  });
