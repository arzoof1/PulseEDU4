import {
  pgTable,
  serial,
  text,
  integer,
  date,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

// benchmark_deliveries — one row per (teacher, benchmark, delivered_on).
// Teacher-owned instructional log used by:
//   - Per-teacher "star" badges (count of times *I* taught this) on
//     the Benchmarks heatmap and Benchmark Progress Report.
//   - Schoolwide Instructional Coverage dashboard (admin / core team)
//     which removes the teacher filter and groups by benchmark.
//
// Multi-tenancy: every read MUST filter by school_id.
// Backdating allowed within the current school year (validated at the
// route layer via schoolYearLabelFor). Deletes are hard, owner-only.
export const benchmarkDeliveriesTable = pgTable(
  "benchmark_deliveries",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    teacherStaffId: integer("teacher_staff_id").notNull(),
    subject: text("subject").notNull(),
    benchmarkCode: text("benchmark_code").notNull(),
    // YYYY-MM-DD; the actual instruction date the teacher entered.
    // Time-of-day intentionally omitted — counts are by day.
    deliveredOn: date("delivered_on").notNull(),
    // Optional free-text note (lesson title, "warm-up only", etc.).
    // 280-char soft cap enforced at the route layer.
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    teacherIdx: index("benchmark_deliveries_teacher_idx").on(
      t.schoolId,
      t.teacherStaffId,
      t.subject,
    ),
    benchmarkIdx: index("benchmark_deliveries_benchmark_idx").on(
      t.schoolId,
      t.subject,
      t.benchmarkCode,
    ),
    schoolDateIdx: index("benchmark_deliveries_school_date_idx").on(
      t.schoolId,
      t.deliveredOn,
    ),
  }),
);

export type BenchmarkDeliveryRow = typeof benchmarkDeliveriesTable.$inferSelect;
