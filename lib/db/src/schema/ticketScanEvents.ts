import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

// =============================================================================
// ticket_scan_events — append-only audit of every scan at the gate, including
// rejected ones. Answers "who admitted this code, when, and at which gate?"
// and lets a rescan show the original admission time/gate.
//
// result vocabulary:
//   - admitted     — first scan of a valid ticket (this scan won)
//   - already_used — the ticket was already 'used' (over-shared / re-scan)
//   - void         — the ticket was revoked
//   - wrong_event  — the code belongs to a different event than this gate
//   - invalid      — no matching ticket for the scanned token
//
// scannedByStaffId is set for in-app staff scans; scannerLinkId is set for the
// no-login volunteer "scanner link". Exactly one is typically populated.
// =============================================================================
export const ticketScanEventsTable = pgTable(
  "ticket_scan_events",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    eventId: integer("event_id").notNull(),
    // tickets.id — null when the scan didn't match a known ticket.
    ticketId: integer("ticket_id"),
    tokenScanned: text("token_scanned").notNull(),
    result: text("result").notNull(),
    gateLabel: text("gate_label"),
    scannedByStaffId: integer("scanned_by_staff_id"),
    scannerLinkId: integer("scanner_link_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    byEventDate: index("ticket_scan_events_by_event_date").on(
      t.schoolId,
      t.eventId,
      t.createdAt,
    ),
    byTicket: index("ticket_scan_events_by_ticket").on(t.ticketId),
  }),
);

export type TicketScanEventRow = typeof ticketScanEventsTable.$inferSelect;
