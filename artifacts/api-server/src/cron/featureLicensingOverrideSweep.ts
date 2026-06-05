// Expired-override sweep — Phase 2 of feature licensing.
//
// `loadEffectiveFeatures` already filters expired overrides at read
// time, so showUpsell + per-override quotas stop leaking the moment
// expires_at passes. The runtime `super_feature_*` boolean on
// school_settings, however, was written by an earlier
// `applyOverridesToSchool` call and stays stuck at the override's
// value until SOMETHING re-applies. That something is this cron.
//
// What it does, once per day:
//   1. Find every override row whose expires_at has passed AND that
//      has NOT yet been processed (idempotency via partial unique
//      index on feature_licensing_audit_log).
//   2. For each distinct school: lock + re-apply plan flags + re-apply
//      remaining (non-expired) overrides. This rolls the
//      super_feature_* boolean back to "what the plan says, minus any
//      still-live overrides."
//   3. Insert one audit row per expired override. ON CONFLICT DO
//      NOTHING — if a prior run already swept this override the
//      insert no-ops and we move on.
//
// Concurrency: the sweep takes the same per-school FOR UPDATE lock
// `reapplyLicensingToSchool` uses, so it can't interleave with a
// SuperUser admin write in flight.

import { and, eq, isNotNull, lt, sql } from "drizzle-orm";
import {
  db,
  featureLicensingAuditLogTable,
  schoolFeatureOverridesTable,
} from "@workspace/db";
import { logger } from "../lib/logger.js";
import { reapplyLicensingToSchool } from "../lib/featureLicensing.js";

export type SweepResult = {
  schoolsReapplied: number;
  overridesSwept: number;
  auditRowsInserted: number;
};

export async function runFeatureLicensingOverrideSweep(
  now: Date = new Date(),
): Promise<SweepResult> {
  // Pull every override that has expired AND whose expiration has not
  // already been audited. The LEFT JOIN check via NOT EXISTS keeps us
  // crash-safe — if a previous run committed the reapply but crashed
  // before inserting the audit row, the next run will redo BOTH
  // (reapply is idempotent; audit insert uses ON CONFLICT DO NOTHING).
  const expired = await db.execute<{
    id: number;
    school_id: number;
    feature_key: string;
    enabled: boolean;
    expires_at: Date;
  }>(sql`
    SELECT o.id, o.school_id, o.feature_key, o.enabled, o.expires_at
      FROM school_feature_overrides o
     WHERE o.expires_at IS NOT NULL
       AND o.expires_at < ${now}
       AND NOT EXISTS (
         SELECT 1
           FROM feature_licensing_audit_log a
          WHERE a.override_id = o.id
            AND a.action = 'override_expired_sweep'
       )
  `);

  // drizzle's .execute returns { rows: [...] } on pg — normalise.
  const rows = (expired as unknown as {
    rows: Array<{
      id: number;
      school_id: number;
      feature_key: string;
      enabled: boolean;
      expires_at: Date;
    }>;
  }).rows;

  if (rows.length === 0) {
    return { schoolsReapplied: 0, overridesSwept: 0, auditRowsInserted: 0 };
  }

  // Reapply once per distinct school — the reapply already considers
  // ALL overrides on that school in one pass, so doing it per-override
  // would be wasted work.
  const distinctSchools = Array.from(new Set(rows.map((r) => r.school_id)));
  let schoolsReapplied = 0;
  for (const schoolId of distinctSchools) {
    try {
      await reapplyLicensingToSchool(schoolId);
      schoolsReapplied++;
    } catch (err) {
      logger.error(
        { err, schoolId },
        "Feature licensing override sweep: reapply failed for school",
      );
      // Don't abort the whole sweep — other schools should still be
      // processed. The audit rows for THIS school's overrides will not
      // be inserted (below) so the next run picks them up again.
    }
  }

  // Audit row per expired override. ON CONFLICT DO NOTHING on the
  // partial unique index makes this safe to re-run.
  let auditRowsInserted = 0;
  for (const r of rows) {
    try {
      const res = await db.execute(sql`
        INSERT INTO feature_licensing_audit_log
          (school_id, action, override_id, feature_key, payload)
        VALUES (
          ${r.school_id},
          'override_expired_sweep',
          ${r.id},
          ${r.feature_key},
          ${sql.raw(
            `'${JSON.stringify({
              wasEnabled: r.enabled,
              expiresAt: r.expires_at instanceof Date
                ? r.expires_at.toISOString()
                : String(r.expires_at),
            }).replace(/'/g, "''")}'::jsonb`,
          )}
        )
        ON CONFLICT (override_id) WHERE action = 'override_expired_sweep'
        DO NOTHING
      `);
      // drizzle.execute returns { rowCount } on pg
      const rc = (res as unknown as { rowCount?: number }).rowCount ?? 0;
      auditRowsInserted += rc;
    } catch (err) {
      logger.error(
        { err, overrideId: r.id, schoolId: r.school_id },
        "Feature licensing override sweep: audit insert failed",
      );
    }
  }

  return {
    schoolsReapplied,
    overridesSwept: rows.length,
    auditRowsInserted,
  };
}
