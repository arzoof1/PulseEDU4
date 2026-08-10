# Database migrations (DV-05)

This documents the **gated, versioned** migration process that replaces
"schema diff pushed on boot" for production. It exists to satisfy the district
requirement for a reviewable, auditable, rollback-capable schema change process.

## Current state vs. target

| | Today (push-on-boot) | Target (versioned) |
|---|---|---|
| How schema changes reach prod | `drizzle-kit push` diffs `src/schema` against the live DB and applies it; app-time `ensure*` functions top up columns on boot | Reviewed, checked-in SQL migration files applied by an explicit `migrate` step before the app starts |
| Auditability | None — the diff is implicit | Every change is a committed `.sql` file with a hash in `meta/_journal.json` |
| Rollback | None (manual SSH intervention) | Paired down-SQL + restore-from-backup SOP (below) |
| Review gate | None | PR review of the generated `.sql` before merge/deploy |

## Layout

- `migrations/` — generated `NNNN_<name>.sql` files + `meta/_journal.json` (created here).
- `drizzle.config.ts` — `out` points at `migrations/`.
- Scripts (in `package.json`): `generate`, `migrate`, `migrate:check`.

## Process (once the toolchain blocker below is cleared)

1. Change `src/schema/*.ts`.
2. `DATABASE_URL=<dev> pnpm --filter @workspace/db generate --name <change>`
   → writes a new `migrations/NNNN_<change>.sql`. **Review it in the PR.**
3. `pnpm --filter @workspace/db migrate:check` in CI to verify migrations are
   consistent and un-applied ones are detected (the gate).
4. Deploy applies pending migrations with `pnpm --filter @workspace/db migrate`
   as an explicit **pre-start** step (not on boot), against a DB backed up in
   step 0 of the rollback SOP.

## Rollback SOP

Drizzle does not auto-generate down-migrations, so rollback is explicit:

1. **Before every prod migrate**, take an immutable snapshot/backup and record
   its id in the deploy log (ties into DO-01/DO-03).
2. If a migration misbehaves:
   - **Additive change** (new table/column/index): safe to leave; redeploy the
     previous app build — it simply ignores the new object.
   - **Destructive/altering change**: restore the pre-migration snapshot, then
     redeploy the previous app build. Never hand-edit prod schema.
3. Author a paired `migrations/NNNN_<change>.down.sql` for any destructive
   migration and attach it to the PR so the reverse is reviewed up front.

## ⚠️ Toolchain blocker (investigated 2026-08-05 — needs a drizzle v1 upgrade)

`drizzle-kit` cannot serialize this schema under `drizzle-orm@0.45.1`:

```
TypeError: sql2.toQuery is not a function
    at PgDialect.sqlToQuery (.../drizzle-orm/pg-core/dialect.ts:610)
    at generatePgSnapshot (.../drizzle-kit/bin.cjs)   // Array.forEach over index predicates
```

**Root cause (confirmed):** the 7 PARTIAL indexes that use `.where(sql\`…\`)`
predicates (bellSchedules, kioskEnrollTokens, kioskActivations,
teacherDestinationAllowlist, accommodationLogs, staffDefaults,
studentHallPassLimits). drizzle-kit 0.31.x fails to serialize those predicates
against orm 0.45.1's SQL API. Affects both `push` AND `generate` (the failure is
in snapshot generation, before any DB connection).

**Version probe results (all keep drizzle-orm pinned at 0.45.1):**
- `drizzle-kit@0.31.9` and `@0.31.10` (latest stable 0.31.x) → same `toQuery` error.
- `drizzle-kit@1.0.0-rc.4` (only line that could fix it) → `ERR_PACKAGE_PATH_NOT_EXPORTED`;
  it requires **drizzle-orm v1**'s export map. drizzle-kit v1 is paired with orm v1.

**Conclusion:** activating drizzle-kit `generate`/`migrate`/`push` requires a
COORDINATED upgrade to **drizzle-orm v1 + drizzle-kit v1** — a breaking change to
the ORM the entire app runs on. That is deliberately NOT done here: it must be
its own validated project (full app typecheck + test pass on orm v1, plus a
push/generate smoke-test), not a side effect of setting up migrations.

**Upgrade attempt — measured blast radius (2026-08-05).** Bumped the catalog to
`drizzle-orm@1.0.0-rc.4` + `drizzle-kit@1.0.0-rc.4`, installed, and typechecked:

```
api-server tsc --noEmit under drizzle-orm v1:  13,639 errors
  4,552 TS2345 (argument types)   4,284 TS2322 (assignment)   4,065 TS2339 (missing prop)
```

drizzle-orm v1 rewrote the table/column/query type system (PgColumn shape,
`drizzle()` config, table brands), so essentially every schema file and query
site fails to typecheck. This is a **multi-week migration on release-candidate
software** — far outside "won't break prod." The bump was **reverted** (catalog
back to `^0.45.1`, lockfile restored, typecheck green). Recommendation: schedule
the drizzle v1 upgrade as its own post-launch project once v1 ships **stable**.

**Interim (works today):** provision/refresh a database from the schema with the
programmatic builder `scripts/src/testSchemaSync.mts` (drizzle `getTableConfig`
→ CREATE TABLE for all 198 tables; used to stand up the integration-test DB).
Production continues on push-on-boot + the app-time `ensure*` top-ups. The
scaffolding here (config `out`, scripts, this SOP) stays in place so that once
the drizzle v1 upgrade lands, activation is one `generate` away.
