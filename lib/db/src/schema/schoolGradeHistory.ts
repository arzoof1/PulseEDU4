import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

// school_grade_history — hand-entered prior-year official school-grade
// rows so the year-over-year table has real history on day one (e.g.
// "FSA 2019", "FAST 24-25"). The admin types the component scores; the
// module computes total/percent/letter the same way it does for a live
// run, UNLESS the admin overrides total/letter directly (FSA years used
// a different component set, so an override escape hatch is provided).
//
// Component columns are nullable — older accountability models had fewer
// components, and N/A is meaningful.
export const schoolGradeHistoryTable = pgTable(
  "school_grade_history",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    // Free-text label for the row, e.g. "FAST 24-25" or "FSA 2019".
    yearLabel: text("year_label").notNull(),
    // Ascending sort key so the table orders oldest → newest regardless
    // of the label text.
    displayOrder: integer("display_order").notNull().default(0),
    schoolType: text("school_type").notNull().default("middle"),
    elaAch: integer("ela_ach"),
    mathAch: integer("math_ach"),
    sciAch: integer("sci_ach"),
    ssAch: integer("ss_ach"),
    elaLg: integer("ela_lg"),
    mathLg: integer("math_lg"),
    elaLgL25: integer("ela_lg_l25"),
    mathLgL25: integer("math_lg_l25"),
    accel: integer("accel"),
    // Optional overrides for legacy years where the stored components
    // don't cleanly sum to the published grade.
    totalOverride: integer("total_override"),
    letterOverride: text("letter_override"),
    createdByStaffId: integer("created_by_staff_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    schoolIdx: index("school_grade_history_school_idx").on(t.schoolId),
  }),
);

export type SchoolGradeHistoryRow =
  typeof schoolGradeHistoryTable.$inferSelect;
