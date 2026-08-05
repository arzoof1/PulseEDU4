# Row-Level Security (DV-01) — Phase 1

DB-enforced tenant isolation as **defense-in-depth** behind the application's
`WHERE school_id = ...` filters. If a query ever forgets its school filter, RLS
still prevents cross-tenant rows from leaking.

## Status: staged & tested, INERT on production

- `phase1_policies.sql` enables RLS + a tenant-isolation policy on the three
  highest-sensitivity tables: **students, safety_plans, interaction_cases**.
- Policies read the tenant from a per-request GUC `app.current_school_id`
  (set by `artifacts/api-server/src/lib/rlsScope.ts` → `withSchoolScope`).
  No GUC ⇒ predicate is NULL ⇒ **no rows** (fail-closed).
- **Applying this changes nothing on production today.** The policies use
  `ENABLE` (not `FORCE`) ROW LEVEL SECURITY, and the Postgres **table owner**
  (the role the app currently connects as) bypasses RLS. Enforcement begins only
  once the app connects as a dedicated non-owner role (see Activation).
- Proven in `artifacts/api-server/src/__tests__/rlsIsolation.test.ts`: under a
  restricted role, school A cannot see school B's students and vice-versa, and
  an unset tenant sees nothing — while the owner connection still sees all.

## Apply the policies (safe, idempotent, no behavior change)

```
psql "$DATABASE_URL" -f lib/db/rls/phase1_policies.sql
```

## Activation (a DevOps step — do in staging first)

1. Create a dedicated, **non-owner, NOBYPASSRLS, non-superuser** login role:
   ```sql
   CREATE ROLE pulseedu_app LOGIN PASSWORD '<secret>';
   GRANT USAGE ON SCHEMA public TO pulseedu_app;
   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pulseedu_app;
   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pulseedu_app;
   ALTER DEFAULT PRIVILEGES IN SCHEMA public
     GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pulseedu_app;
   ```
2. Point the app's `DATABASE_URL` at `pulseedu_app` (not the owner).
3. Ensure every request that touches a policied table runs inside
   `withSchoolScope(schoolId, tx => ...)` so the tenant GUC is set. Bypass paths
   (SuperUser cross-district, seeds, cron, migrations) keep using the owner
   role / a `BYPASSRLS` role.
4. Verify with the isolation test against staging before prod.

## Extending coverage (future phases)

The `pilot` array in `phase1_policies.sql` lists the covered tables. To widen
coverage, add tables (all must have a `school_id` column) and migrate their
sensitive read paths onto `withSchoolScope`. Roll out table-by-table, verifying
the isolation test after each batch — a wrong policy blocks legitimate queries,
so incremental is safer than all-at-once (per the Section 5.3 evaluation).
