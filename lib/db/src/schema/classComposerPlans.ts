import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

// Class Composer "Master Plans" — a scheduler-side workspace where an
// admin / counselor / Core Team member iteratively locks groups
// produced by the Class Composer until they have a full plan for one
// (subject, grade) pair. Single-grade by design (cusp cut scores are
// grade-specific and master schedules carve a grade at a time). The
// composer routes use these tables to (a) list saved plans, (b)
// exclude already-locked students from the candidate pool, (c) hand
// the finalized plan back as CSV + printable PDF.
//
// Two tables:
//   1. class_composer_plans — header row per plan
//   2. class_composer_plan_groups — one row per locked group; the
//      group's roster is stored inline as a text[] of student_ids
//      so reads/writes stay in a single row (consistent with the
//      safety_plans JSONB-roster pattern).
//
// Nothing in this schema writes back to section_roster or
// class_sections — the plan is a paper artifact for the master
// scheduler to recreate in Skyward / RosterOne, exactly like the
// rest of Class Composer.
export const classComposerPlansTable = pgTable(
  "class_composer_plans",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    // schoolYear + window aren't pinned to the plan because the
    // window can change between recipes (you might lock a PM2-based
    // group then run a PM3 recipe). schoolYear IS pinned because the
    // grade roster is year-scoped.
    schoolYear: text("school_year").notNull(),
    subject: text("subject").notNull(), // 'ela' | 'math' | 'algebra1' | 'geometry'
    grade: integer("grade").notNull(),
    name: text("name").notNull(),
    // 'draft' while the admin is still locking/unlocking groups,
    // 'final' once they hit Finalize. Final plans are read-only;
    // exports are produced from final OR draft plans.
    status: text("status").notNull().default("draft"),
    // Short opaque ID printed on every PDF page footer + encoded into
    // the QR code so a stray page can be reunited with its plan.
    // 8 chars, base32-ish (alphanumeric uppercase no I/O/0/1).
    publicId: text("public_id").notNull(),
    createdByStaffId: integer("created_by_staff_id").notNull(),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    schoolIdx: index("class_composer_plans_school_idx").on(t.schoolId),
    schoolSubjectGradeIdx: index(
      "class_composer_plans_school_subject_grade_idx",
    ).on(t.schoolId, t.subject, t.grade, t.schoolYear),
  }),
);
export type ClassComposerPlanRow =
  typeof classComposerPlansTable.$inferSelect;

// Recipe captured at lock time so the PDF + audit trail can explain
// *why* each group exists. Stored as JSONB so it can grow without a
// migration.
export interface ClassComposerGroupRecipe {
  mode: "intensive" | "regular" | "cusp";
  window: string;
  arrangement?: "homogeneous" | "balanced" | null;
  eligibilityMaxPct?: number;
  // Legacy single window — kept for plans locked before the split.
  // New plans store cuspPointsBelow + cuspPointsAbove explicitly.
  cuspPoints?: number;
  cuspPointsBelow?: number;
  cuspPointsAbove?: number;
  cuspDirection?: "both" | "below" | "above" | "strand";
  cuspDoubleCounters?: boolean;
  cuspTrajectory?: boolean;
  // Human-readable one-liner the PDF cover renders verbatim, e.g.
  // "Cusp · Below cut (L2 → L3) · ±5 pts · PM3".
  summary: string;
}

export const classComposerPlanGroupsTable = pgTable(
  "class_composer_plan_groups",
  {
    id: serial("id").primaryKey(),
    planId: integer("plan_id").notNull(),
    schoolId: integer("school_id").notNull(),
    groupIndex: integer("group_index").notNull(),
    name: text("name").notNull(),
    recipe: jsonb("recipe").$type<ClassComposerGroupRecipe>().notNull(),
    // Per-school student IDs, in display order. Drizzle's text-array
    // mapping handles the Postgres `text[]` round-trip.
    studentIds: text("student_ids").array().notNull().default([]),
    seatsPerSection: integer("seats_per_section").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    planIdx: index("class_composer_plan_groups_plan_idx").on(t.planId),
    schoolIdx: index("class_composer_plan_groups_school_idx").on(t.schoolId),
  }),
);
export type ClassComposerPlanGroupRow =
  typeof classComposerPlanGroupsTable.$inferSelect;
