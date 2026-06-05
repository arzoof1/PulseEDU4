import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// school_grade_manual_inputs — the three NON-FAST component values an
// admin enters by hand at PM1/PM2 (Science achievement, Social Studies /
// Civics achievement, and Acceleration). One row per (school, year,
// window); re-saving upserts. At PM3 these become uploads (Phase 2), but
// the manual values remain the fallback when an upload is still pending.
//
// Values are 0–100 point scores (NOT percentages of a max other than
// 100). Null means "not entered yet" → the component renders as pending
// and is excluded from the grade denominator.
export const schoolGradeManualInputsTable = pgTable(
  "school_grade_manual_inputs",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    schoolYear: text("school_year").notNull(),
    pmWindow: text("pm_window").notNull(), // 'pm1' | 'pm2' | 'pm3'
    science: integer("science"),
    socialStudies: integer("social_studies"),
    acceleration: integer("acceleration"),
    updatedByStaffId: integer("updated_by_staff_id").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    schoolYearWindowUnique: uniqueIndex(
      "school_grade_manual_inputs_school_year_window_unique",
    ).on(t.schoolId, t.schoolYear, t.pmWindow),
  }),
);

export type SchoolGradeManualInputRow =
  typeof schoolGradeManualInputsTable.$inferSelect;
