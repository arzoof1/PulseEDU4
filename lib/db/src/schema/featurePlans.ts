import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// =============================================================================
// Feature licensing — Plans + per-school Overrides
// =============================================================================
// SuperUser-facing licensing layer on top of the existing
// `school_settings.super_feature_*` flags. The flags remain the runtime
// source of truth that every gate reads from; this module is the editing
// UX that bundles flags into Plans and lets SuperUser flip individual
// features per school with expiration + audit.
//
// Effective feature for a school = applyPlan(plan_id) overridden by
// any rows in school_feature_overrides. Both write through to the
// existing super_feature_* booleans on school_settings so the runtime
// behavior is unchanged.
//
// `features` JSONB on plans: { [featureKey]: true }. Only enabled keys
// appear; absence = disabled. Mirrors the pattern of "what's included
// in the package".
//
// `quotas` JSONB on plans + on overrides: { [featureKey]: { [quotaName]:
// number | string[] } }. Phase 1 is plumbing only — no feature reads
// these yet, but the schema + admin UI + server helper are wired so
// Phase 3 can flip on a quota with one consumer-side change.
//
// `show_upsell` on overrides: when TRUE and `enabled` is FALSE, the
// client renders a "🔒 Upgrade" pill in the nav and an Upsell card on
// the page (instead of hiding entirely). Per the hybrid visibility
// model — default hidden, opt-in upsell.
// =============================================================================

export const plansTable = pgTable("plans", {
  id: serial("id").primaryKey(),
  // Stable machine key (e.g. "core", "core_pbis", "enterprise"). Used in
  // logs and any URL routing. Distinct from the human label so renaming
  // "Core" → "Starter" in the UI doesn't break audit trails.
  key: text("key").notNull(),
  label: text("label").notNull(),
  description: text("description"),
  // { [featureKey]: true }. Absence = disabled.
  features: jsonb("features").$type<Record<string, true>>().notNull(),
  // { [featureKey]: { [quotaName]: number | string[] } }
  quotas: jsonb("quotas")
    .$type<Record<string, Record<string, number | string[]>>>()
    .notNull()
    .default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => ({
  byKey: uniqueIndex("plans_key_unique").on(t.key),
}));

export type PlanRow = typeof plansTable.$inferSelect;

export const schoolFeatureOverridesTable = pgTable(
  "school_feature_overrides",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    // Feature key from FEATURE_KEYS registry (server-side validated).
    featureKey: text("feature_key").notNull(),
    // Override the plan's enabled value. TRUE forces on, FALSE forces off.
    enabled: boolean("enabled").notNull(),
    // Hybrid visibility: when the feature is off, should the client
    // render a locked badge + upsell card (TRUE) or hide entirely (FALSE).
    showUpsell: boolean("show_upsell").notNull().default(false),
    // Per-override quota overrides. Same shape as plans.quotas[featureKey].
    quotas: jsonb("quotas")
      .$type<Record<string, number | string[]>>()
      .notNull()
      .default({}),
    // When the override should automatically expire. NULL = permanent
    // until manually removed. A daily cron (Phase 4) will sweep expired
    // overrides and post an audit row.
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    // Why the override was granted ("Q4 trial", "comped per contract",
    // "billing dispute hold"). Required to remind the SuperUser six
    // months later what this was about.
    reason: text("reason"),
    // Who granted it. Staff id; the SuperUser page resolves the display
    // name at render time so a renamed staff still shows correctly.
    grantedByStaffId: integer("granted_by_staff_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    bySchoolFeatureUnique: uniqueIndex(
      "school_feature_overrides_school_feature_unique",
    ).on(t.schoolId, t.featureKey),
    bySchool: index("school_feature_overrides_school_idx").on(t.schoolId),
  }),
);

export type SchoolFeatureOverrideRow =
  typeof schoolFeatureOverridesTable.$inferSelect;
