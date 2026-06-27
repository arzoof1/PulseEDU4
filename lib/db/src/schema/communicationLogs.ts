import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

// A single logged family communication (a call/email/message about a student).
// School-scoped + FLEID-safe (student_id is the FK; surfaces render localSisId).
//
// contactedAt is the time the communication actually happened — defaults to
// "now" but is editable (backdating an after-the-fact call). loggedAt is the
// audit stamp of when the row was created.
//
// outcome drives Call-Initiative completion (Reached, or N attempts). tone
// (positive|neutral|concern) drives the +/- report split.
export const communicationLogsTable = pgTable(
  "communication_logs",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    studentId: text("student_id").notNull(),
    // Snapshot of the communication-type name at log time (rename-preserving).
    type: text("type").notNull(),
    // Name of the person actually contacted (from the family contact list, or
    // free-text "Other"). Optional.
    whoContacted: text("who_contacted"),
    // Reached | Left message | No answer | Wrong number | Inbound
    outcome: text("outcome").notNull(),
    // positive | neutral | concern
    tone: text("tone").notNull().default("neutral"),
    note: text("note"),
    staffId: integer("staff_id").notNull(),
    staffName: text("staff_name").notNull(),
    contactedAt: timestamp("contacted_at", { withTimezone: true }).notNull(),
    loggedAt: timestamp("logged_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    schoolStudentIdx: index("communication_logs_school_student_idx").on(
      t.schoolId,
      t.studentId,
    ),
    schoolContactedIdx: index("communication_logs_school_contacted_idx").on(
      t.schoolId,
      t.contactedAt,
    ),
  }),
);

export type CommunicationLogRow = typeof communicationLogsTable.$inferSelect;
