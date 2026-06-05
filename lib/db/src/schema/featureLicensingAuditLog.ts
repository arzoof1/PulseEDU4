import {
  pgTable,
  serial,
  text,
  integer,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// =============================================================================
// Feature licensing — audit log
// =============================================================================
// Append-only audit trail for everything that mutates effective licensing
// state on a school. Drives:
//
//   * The expired-override cron sweep's idempotency (partial unique index
//     on override_id where action='override_expired_sweep' — at most one
//     sweep audit row per override, ever).
//   * Future "who flipped this feature, when, and why" questions an
//     auditor or angry tenant will ask six months later.
//
// Actor columns are nullable because the sweep cron has no human actor.
// Payload is intentionally loose-jsonb so future event kinds (plan
// reassign, manual override mutation) can land here without a migration.
// =============================================================================
export const featureLicensingAuditLogTable = pgTable(
  "feature_licensing_audit_log",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    // Closed enum, server-validated. Today: 'override_expired_sweep'.
    // Future: 'plan_assigned' | 'override_upserted' | 'override_deleted'.
    action: text("action").notNull(),
    // FK-by-convention to school_feature_overrides.id. NULL for non-
    // override events (e.g. future plan reassign rows). The partial
    // unique index below dedupes the sweep on this column.
    overrideId: integer("override_id"),
    featureKey: text("feature_key"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    actorStaffId: integer("actor_staff_id"),
    actorName: text("actor_name"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    bySchool: index("feature_licensing_audit_school_idx").on(
      t.schoolId,
      t.createdAt,
    ),
    // Partial unique index — at most one sweep audit row per override.
    // Used by the cron as a cheap "have I processed this override yet?"
    // check via ON CONFLICT DO NOTHING.
    expiredSweepUnique: uniqueIndex(
      "feature_licensing_audit_expired_sweep_unique",
    ).on(t.overrideId)
      .where(`action = 'override_expired_sweep'` as unknown as never),
  }),
);

export type FeatureLicensingAuditRow =
  typeof featureLicensingAuditLogTable.$inferSelect;
