import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

// A flag raised when a phone line for a student's family contact is bad
// (disconnected / wrong person / etc). Routed to front-office staff
// (capManageContactInfo) who enter a corrected number. The corrected number is
// an audited override that WINS until overwritten with new info — mirroring the
// pickup manual-override pattern.
//
// A phone line is identified by (studentId, contactSlot):
//   contactSlot = 0  -> primary guardian (students.parentPhone)
//   contactSlot = 1..4 -> studentEmergencyContacts.slot
//
// status: open (needs registrar) | resolved (registrar entered a corrected
// number or dismissed). correctedPhone, when set, is shown app-wide in place of
// the bad number.
export const badNumberFlagsTable = pgTable(
  "bad_number_flags",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    studentId: text("student_id").notNull(),
    contactSlot: integer("contact_slot").notNull(),
    // Snapshot for display: e.g. "Mom (Cell)" / "Primary guardian".
    contactLabel: text("contact_label"),
    badPhone: text("bad_phone"),
    // Disconnected | Not in service | Wrong person | Voicemail full
    reason: text("reason").notNull(),
    status: text("status").notNull().default("open"),
    flaggedByStaffId: integer("flagged_by_staff_id").notNull(),
    flaggedByName: text("flagged_by_name").notNull(),
    flaggedAt: timestamp("flagged_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    correctedPhone: text("corrected_phone"),
    resolvedByStaffId: integer("resolved_by_staff_id"),
    resolvedByName: text("resolved_by_name"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    note: text("note"),
  },
  (t) => ({
    schoolStatusIdx: index("bad_number_flags_school_status_idx").on(
      t.schoolId,
      t.status,
    ),
    schoolStudentIdx: index("bad_number_flags_school_student_idx").on(
      t.schoolId,
      t.studentId,
    ),
  }),
);

export type BadNumberFlagRow = typeof badNumberFlagsTable.$inferSelect;
