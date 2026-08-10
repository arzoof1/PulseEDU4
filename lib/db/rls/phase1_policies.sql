-- =============================================================================
-- DV-01 — PostgreSQL Row-Level Security, PHASE 1 (defense-in-depth)
-- =============================================================================
-- Adds DB-enforced tenant isolation to the highest-sensitivity tables as a
-- second wall behind the application-layer `WHERE school_id = ...` filters. A
-- query that forgets its school filter still returns nothing across tenants.
--
-- Tenant context comes from a per-request GUC `app.current_school_id`, set by
-- artifacts/api-server/src/lib/rlsScope.ts (withSchoolScope). When the GUC is
-- unset the policy predicate is NULL, so NO rows are visible (fail-closed).
--
-- *** INERT ON PRODUCTION UNTIL ACTIVATED ***
-- These policies use ENABLE (not FORCE) ROW LEVEL SECURITY. The Postgres table
-- OWNER (the role the app currently connects as) BYPASSES RLS, so applying this
-- file changes NOTHING about current behavior. Enforcement begins only once the
-- app connects as a dedicated NON-owner, NOBYPASSRLS role (a DevOps step — see
-- README.md). This lets the policies be reviewed, applied, and tested now
-- without any risk to the running app.
--
-- Idempotent: safe to re-run.
-- =============================================================================

DO $$
DECLARE
  tbl text;
  pilot text[] := ARRAY['students', 'safety_plans', 'interaction_cases'];
BEGIN
  FOREACH tbl IN ARRAY pilot LOOP
    -- Only touch tables that actually exist + carry a school_id tenant column.
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = tbl AND column_name = 'school_id'
    ) THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_tenant_isolation', tbl);
      EXECUTE format(
        'CREATE POLICY %I ON %I '
        || 'USING (school_id = NULLIF(current_setting(''app.current_school_id'', true), '''')::int) '
        || 'WITH CHECK (school_id = NULLIF(current_setting(''app.current_school_id'', true), '''')::int)',
        tbl || '_tenant_isolation', tbl
      );
    END IF;
  END LOOP;
END $$;
