import { pgTable, serial, integer, text, timestamp, index } from "drizzle-orm/pg-core";

// Append-only audit ledger of student ID badge PDF generations.
// Written by POST /api/students/id-badges.pdf — one row per student
// per batch — so admins can see lost-badge / reissue patterns
// (a student showing up here 4 times in a month is losing badges
// faster than the office can keep up). The optional reason field
// is free-text supplied by the reprinting admin ("lost", "damaged",
// "name change", etc.).
//
// Tenant column: school_id is indexed for per-school recent prints
// queries. Per-student index supports "show me every time this
// student's badge was reprinted."
export const badgePrintEventsTable = pgTable(
  "badge_print_events",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    studentId: integer("student_id").notNull(),
    printedByStaffId: integer("printed_by_staff_id"),
    size: text("size").notNull(),
    reason: text("reason"),
    batchSize: integer("batch_size").notNull().default(1),
    printedAt: timestamp("printed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    schoolPrintedAtIdx: index("badge_print_events_school_printed_at_idx").on(
      t.schoolId,
      t.printedAt,
    ),
    studentIdx: index("badge_print_events_student_idx").on(
      t.schoolId,
      t.studentId,
      t.printedAt,
    ),
  }),
);

export type BadgePrintEventRow = typeof badgePrintEventsTable.$inferSelect;
