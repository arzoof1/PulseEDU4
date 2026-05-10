import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Per-school onboarding checklist state. One row per (school_id, step_key).
// A row is created (or updated) the first time an admin manually toggles
// the step. Auto-detected statuses are computed at read-time from other
// tables and do NOT live here, so we never have to keep the two in sync.
//
// `manualChecked` is the admin's explicit "yes, I'm done with this" tick.
// It complements (not replaces) the server-side auto-check — both are
// surfaced separately in the UI so an admin can manually mark complete
// even when no signal exists (e.g. "Signage URLs are configured on TVs").
export const onboardingChecklistStateTable = pgTable(
  "onboarding_checklist_state",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    stepKey: text("step_key").notNull(),
    manualChecked: boolean("manual_checked").notNull().default(false),
    completedByStaffId: integer("completed_by_staff_id"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    schoolStepUnique: uniqueIndex("onboarding_checklist_school_step_uq").on(
      t.schoolId,
      t.stepKey,
    ),
  }),
);

export type OnboardingChecklistStateRow =
  typeof onboardingChecklistStateTable.$inferSelect;
