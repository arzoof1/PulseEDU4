import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// =============================================================================
// staff_feature_pilots — per-staff feature pilot grants.
// =============================================================================
// A school admin can run a feature in "pilot" for a handful of staff:
// the school-wide admin toggle (school_settings.feature_*) stays OFF,
// but staff listed here get the feature as if it were ON — provided the
// district half (super_feature_*) is licensed. District license always
// wins: a pilot row for an unlicensed feature grants nothing.
//
// Generic by design (feature_key TEXT, validated against FEATURE_KEYS
// at the API layer) so every current and future feature is pilotable
// without schema changes. One row per (school, feature, staff).
// =============================================================================
export const staffFeaturePilotsTable = pgTable(
  "staff_feature_pilots",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    featureKey: text("feature_key").notNull(),
    staffId: integer("staff_id").notNull(),
    grantedByStaffId: integer("granted_by_staff_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniquePilot: uniqueIndex("staff_feature_pilots_unique").on(
      t.schoolId,
      t.featureKey,
      t.staffId,
    ),
  }),
);

export type StaffFeaturePilotRow = typeof staffFeaturePilotsTable.$inferSelect;
