import { pgTable, serial, integer, timestamp, index } from "drizzle-orm/pg-core";

// Append-only ledger of kiosk "Sign in to class" events. Written by
// POST /api/kiosk/class-signin after a student scans / types their ID
// on an activated kiosk. Used by the kiosk to show the welcome card
// and (future) by teachers as a low-friction arrival roll-call.
//
// Tenant column: school_id is required and indexed for the inevitable
// per-school day rollups. There is intentionally no unique constraint
// on (student_id, day) — a student can sign in multiple times if they
// change classrooms / re-enter after a pass.
export const classSigninsTable = pgTable(
  "class_signins",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    studentId: integer("student_id").notNull(),
    kioskActivationId: integer("kiosk_activation_id"),
    signedInByStaffId: integer("signed_in_by_staff_id"),
    signedInAt: timestamp("signed_in_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    schoolDayIdx: index("class_signins_school_day_idx").on(
      t.schoolId,
      t.signedInAt,
    ),
    studentIdx: index("class_signins_student_idx").on(
      t.schoolId,
      t.studentId,
      t.signedInAt,
    ),
  }),
);

export type ClassSigninRow = typeof classSigninsTable.$inferSelect;
