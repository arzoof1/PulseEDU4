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
// tickets — one row per individual QR code. A grant of quota N produces N
// ticket rows with `seq` 1..N ("Ticket X of N").
//
// `token` is an unguessable random string (base64url of 24+ random bytes) and
// IS the QR payload. It never encodes the student id — leaking a code reveals
// nothing about the student, and codes can't be guessed/forged. Unique per
// school so scanning lookups are tenant-scoped.
//
// First-scan-wins is enforced atomically by a conditional UPDATE
//   SET status='used' ... WHERE id=? AND status='valid'
// so two gates scanning the same code at the same instant can never both
// admit (rowCount === 1 means "you won the scan").
//
// status: 'valid' | 'used' | 'void'  (void = revoked/reissued lost or leaked).
// =============================================================================
export const ticketsTable = pgTable(
  "tickets",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    eventId: integer("event_id").notNull(),
    grantId: integer("grant_id").notNull(),
    // students.id (integer PK).
    studentId: integer("student_id").notNull(),
    token: text("token").notNull(),
    seq: integer("seq").notNull(),
    status: text("status").notNull().default("valid"),
    usedAt: timestamp("used_at", { withTimezone: true }),
    usedGate: text("used_gate"),
    usedByStaffId: integer("used_by_staff_id"),
    // 'staff' | 'scanner_link' — how the admitting scan was performed.
    usedVia: text("used_via"),
    voidReason: text("void_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqueToken: uniqueIndex("tickets_token_unique").on(t.schoolId, t.token),
    byEvent: index("tickets_by_event").on(t.schoolId, t.eventId),
    byGrant: index("tickets_by_grant").on(t.grantId),
  }),
);

export type TicketRow = typeof ticketsTable.$inferSelect;
