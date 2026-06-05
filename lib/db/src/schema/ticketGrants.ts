import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// =============================================================================
// ticket_grants — one row per (event, student) allocation. Holds the per-
// student quota and the email-delivery status snapshot. The individual QR
// codes live in the `tickets` table (one row per ticket, `seq` 1..quota).
//
// Siblings each get their OWN grant + their OWN email (the family receives a
// separate email per student), so the snapshot fields here are per-student.
//
// emailStatus vocabulary:
//   - pending  — allocated, not yet sent
//   - sent     — Resend accepted the message
//   - bounced  — delivery failed downstream (reserved; set by webhook later)
//   - failed   — the send call threw (Resend error / network)
//   - no_email — no guardian email on file (surfaced in the "couldn't send"
//                report + office handout sheet)
//   - printed  — front office printed the tickets on demand (independent of
//                whether an email was ever sent)
// =============================================================================
export const ticketGrantsTable = pgTable(
  "ticket_grants",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    eventId: integer("event_id").notNull(),
    // students.id (integer PK).
    studentId: integer("student_id").notNull(),
    quota: integer("quota").notNull().default(0),
    // Snapshot of the guardian contact at send time (the student row's
    // parent_email / parent_name can change later).
    guardianEmail: text("guardian_email"),
    guardianName: text("guardian_name"),
    emailStatus: text("email_status").notNull().default("pending"),
    emailSentAt: timestamp("email_sent_at", { withTimezone: true }),
    emailTo: text("email_to"),
    emailError: text("email_error"),
    // Set whenever the office prints this family's tickets on demand.
    printedAt: timestamp("printed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniquePerEventStudent: uniqueIndex("ticket_grants_event_student_unique").on(
      t.schoolId,
      t.eventId,
      t.studentId,
    ),
    byEvent: index("ticket_grants_by_event").on(t.schoolId, t.eventId),
  }),
);

export type TicketGrantRow = typeof ticketGrantsTable.$inferSelect;
