/**
 * Provision a full PulseEDU schema into a throwaway TEST database from the
 * Drizzle schema itself — used because `drizzle-kit push` is broken under the
 * pinned drizzle-kit/orm pair (sql.toQuery on partial-index predicates).
 *
 * Emits CREATE TABLE IF NOT EXISTS for every exported pgTable (columns, types,
 * NOT NULL, primitive/now() defaults, single-column primary keys). Foreign keys
 * and partial indexes are intentionally skipped — tests seed their own graphs
 * and don't need referential constraints. Idempotent (safe to re-run).
 *
 * Usage:
 *   DATABASE_URL=postgres://.../pulseedu_test \
 *     scripts/node_modules/.bin/tsx scripts/src/testSchemaSync.mts
 */
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { is } from "drizzle-orm";
import * as workspace from "@workspace/db";

const { pool } = workspace as unknown as { pool: import("pg").Pool };

function quoteLiteral(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

function columnDdl(col: ReturnType<typeof getTableConfig>["columns"][number]): string {
  const parts: string[] = [`"${col.name}"`, col.getSQLType()];
  if (col.primary) parts.push("PRIMARY KEY");
  else if (col.notNull) parts.push("NOT NULL");

  if (col.hasDefault) {
    const d = (col as unknown as { default?: unknown }).default;
    if (typeof d === "boolean" || typeof d === "number") {
      parts.push(`DEFAULT ${d}`);
    } else if (typeof d === "string") {
      parts.push(`DEFAULT ${quoteLiteral(d)}`);
    } else {
      // Complex default (e.g. defaultNow()/random()); approximate by type.
      const t = col.getSQLType();
      if (t.includes("timestamp") || t === "date") parts.push("DEFAULT now()");
      else if (t === "uuid") parts.push("DEFAULT gen_random_uuid()");
      else if (t.includes("json")) parts.push("DEFAULT '{}'");
    }
  }
  return parts.join(" ");
}

function tableDdl(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map(columnDdl);
  return `CREATE TABLE IF NOT EXISTS "${cfg.name}" (\n  ${cols.join(",\n  ")}\n);`;
}

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!/pulseedu_test|_test\b|pentest/.test(url)) {
    throw new Error(
      `Refusing to run: DATABASE_URL does not look like a test DB (${url}).`,
    );
  }

  const tables: PgTable[] = [];
  for (const value of Object.values(workspace)) {
    if (is(value, PgTable)) tables.push(value as PgTable);
  }
  console.log(`Discovered ${tables.length} tables in the Drizzle schema.`);

  let ok = 0;
  const failures: Array<{ table: string; error: string }> = [];
  for (const table of tables) {
    const cfg = getTableConfig(table);
    try {
      await pool.query(tableDdl(table));
      ok++;
    } catch (err) {
      failures.push({ table: cfg.name, error: (err as Error).message });
    }
  }

  const { rows } = await pool.query<{ n: string }>(
    "select count(*)::text as n from information_schema.tables where table_schema='public'",
  );
  console.log(`Created/verified ${ok}/${tables.length} tables. DB now has ${rows[0].n} public tables.`);
  if (failures.length) {
    console.log(`\n${failures.length} table(s) failed:`);
    for (const f of failures) console.log(`  - ${f.table}: ${f.error}`);
  }
  await pool.end();
  if (failures.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
