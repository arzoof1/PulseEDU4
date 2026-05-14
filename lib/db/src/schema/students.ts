import { pgTable, serial, text, integer, boolean } from "drizzle-orm/pg-core";

export const studentsTable = pgTable("students", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull(),
  studentId: text("student_id").notNull().unique(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  grade: integer("grade").notNull(),
  parentName: text("parent_name"),
  parentEmail: text("parent_email"),
  parentPhone: text("parent_phone"),
  // Optional PBIS house affiliation (FK to houses.id). Nullable so existing
  // students remain valid; populated by seed (round-robin) and by the
  // forthcoming admin houses screen.
  houseId: integer("house_id"),
  // Set when the row was inserted by a CSV roster importer. Lets the
  // History tab roll back a botched import: DELETE WHERE import_job_id = X.
  // Nullable because UI-created students and pre-importer rows have no job.
  importJobId: integer("import_job_id"),
  // ----- Whole-child demographic flags (Insights v1) ---------------------
  // Source of truth: the SIS / roster import for ELL/ESE/504/gender; the
  // MTSS team for ct_ela / ct_math (Critical Thinking designations are
  // assigned, not measured). All booleans default false so existing rows
  // and roster imports without these columns remain valid.
  gender: text("gender"),
  ell: boolean("ell").notNull().default(false),
  ese: boolean("ese").notNull().default(false),
  is504: boolean("is_504").notNull().default(false),
  ctEla: boolean("ct_ela").notNull().default(false),
  ctMath: boolean("ct_math").notNull().default(false),
  // ----- Race & Ethnicity (separate fields, federal-reporting style) ------
  // `race` is the primary single-bucket category (one of: white | hispanic |
  // black | asian | multi | native | pacific). Note that "hispanic" appears
  // in the race column for K-12 SIS display compatibility (Skyward / Focus
  // both expose a single race bucket that can include Hispanic). The
  // separate `ethnicity` field carries the federally-required "Hispanic
  // origin Y/N" flag (one of: hispanic | non_hispanic) which is independent
  // of race per OMB Directive 15. Both nullable so existing rows + roster
  // imports without these columns remain valid.
  race: text("race"),
  ethnicity: text("ethnicity"),
  // ----- Dismissal mode (Parent Pick-Up Module) ---------------------------
  // How this student leaves at end-of-day. Drives which dismissal flow
  // they appear in (curb queue, walker gate, bus list) and the
  // end-of-day "still on campus" reconciliation tile.
  // Values: 'car_rider' | 'walker' | 'bus' | 'aftercare' | 'parent_pickup_only'
  dismissalMode: text("dismissal_mode").notNull().default("car_rider"),
});

export type StudentRow = typeof studentsTable.$inferSelect;
