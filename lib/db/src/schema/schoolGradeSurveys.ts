import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// school_grade_surveys — Survey 2 / Survey 3 enrollment-file uploads.
// Phase 1 is a PLACEHOLDER: the file is accepted and its raw CSV text +
// metadata are stored so nothing is lost, but it is NOT yet parsed or
// applied to the matched-cohort calculation. Phase 2 parses `rawCsv`
// into a matched student list and filters every component by it.
//
// One current row per (school, year, survey); re-uploading replaces it.
export const schoolGradeSurveysTable = pgTable(
  "school_grade_surveys",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    schoolYear: text("school_year").notNull(),
    survey: text("survey").notNull(), // 'survey2' | 'survey3'
    filename: text("filename").notNull(),
    byteSize: integer("byte_size").notNull().default(0),
    // Raw uploaded CSV text, retained for Phase 2 parsing. Nullable so a
    // metadata-only record is possible.
    rawCsv: text("raw_csv"),
    // Parsed row count (Phase 2). Null until parsed.
    rowCount: integer("row_count"),
    // 'uploaded' (Phase 1) → 'parsed' (Phase 2).
    status: text("status").notNull().default("uploaded"),
    uploadedByStaffId: integer("uploaded_by_staff_id").notNull(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    schoolYearSurveyUnique: uniqueIndex(
      "school_grade_surveys_school_year_survey_unique",
    ).on(t.schoolId, t.schoolYear, t.survey),
  }),
);

export type SchoolGradeSurveyRow =
  typeof schoolGradeSurveysTable.$inferSelect;
