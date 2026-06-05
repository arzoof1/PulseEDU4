import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

// benchmark_reteach_log — per-student × per-benchmark reteach moments
// captured from the Teacher Roster → Benchmarks heatmap.
//
// One row per (student, benchmark, teacher) reteach. A small-group
// reteach inserts N rows that share the same `group_session_id`, so
// "this teacher ran 12 small groups" counts distinct session_ids
// without double-counting the students within each session.
//
// Multi-tenancy: school_id is required on every read. teacher_id +
// student_id are not globally unique — they pair with school_id.
//
// Edit/delete policy is enforced in the API layer, NOT the schema:
//   - Teacher can edit/delete their OWN log within 24h of created_at.
//   - Admin / Core Team can edit/delete anytime.
// `deleted_at` carries soft-delete state so analytics can ignore
// deleted rows without losing the audit trail.
export const benchmarkReteachLogTable = pgTable(
  "benchmark_reteach_log",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    // Matches students.student_id (TEXT). Not globally unique;
    // application enforces (school_id, student_id) co-filtering.
    studentId: text("student_id").notNull(),
    // Florida benchmark code (e.g. "ELA.6.R.1.1"). Mirrors the
    // benchmarkCode used in student_fast_item_responses so the
    // heatmap can JOIN by (student_id, benchmark_code).
    benchmarkCode: text("benchmark_code").notNull(),
    // Acting teacher (staff.id) — the person who pulled the reteach.
    // Carries attribution so an intensive reading teacher's logs
    // never get confused with the core-ELA teacher's logs for the
    // same student/standard.
    teacherStaffId: integer("teacher_staff_id").notNull(),
    // 'one_on_one' | 'small_group'. (Whole-class is a deliberate
    // future addition; gate at the API layer when we add it.)
    format: text("format").notNull(),
    // Shared id across the N rows written from a single small-group
    // bulk insert. NULL for 1:1 logs. Lets the UI render "small
    // group of 8 on Oct 3" as one row in the per-teacher report
    // and lets analytics count distinct sessions, not student-rows.
    groupSessionId: text("group_session_id"),
    // Free-text strategy label — optional. A future strategy-chip
    // library can populate this from a per-school catalog without
    // a schema change.
    strategy: text("strategy"),
    minutes: integer("minutes"),
    note: text("note"),
    // School year ("YY-YY") and PM window ("pm1"|"pm2"|"pm3") that
    // were active at the time of the log. Captured at write time so
    // effectiveness rollups can answer "did mastery move between
    // the PM at log time and the next PM?" without back-dating.
    schoolYear: text("school_year").notNull(),
    pmWindowAtLog: text("pm_window_at_log"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Soft-delete marker. NULL = active. Set by API layer; row is
    // never hard-deleted by the application (admin DB ops only).
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedByStaffId: integer("deleted_by_staff_id"),
  },
  (t) => ({
    schoolIdx: index("benchmark_reteach_log_school_idx").on(t.schoolId),
    cellIdx: index("benchmark_reteach_log_cell_idx").on(
      t.schoolId,
      t.studentId,
      t.benchmarkCode,
    ),
    teacherIdx: index("benchmark_reteach_log_teacher_idx").on(
      t.schoolId,
      t.teacherStaffId,
    ),
    sessionIdx: index("benchmark_reteach_log_session_idx").on(
      t.groupSessionId,
    ),
  }),
);

export type BenchmarkReteachLogRow =
  typeof benchmarkReteachLogTable.$inferSelect;
