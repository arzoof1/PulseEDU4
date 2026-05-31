import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// =============================================================================
// ticket_scanner_links — no-login "scanner link" tokens for volunteers at the
// gate. An admin mints a link scoped to ONE event; opening it on any phone or
// tablet lets a volunteer scan without signing in.
//
// Only the SHA-256 hash of the URL token is stored (`tokenHash`) — same
// pattern as kiosk_activations — so a DB read can never reconstruct a live
// link. The raw token is shown to the admin exactly once at mint time.
//
// Deactivating a link (active=false) revokes it immediately without deleting
// the audit trail of scans performed through it.
// =============================================================================
export const ticketScannerLinksTable = pgTable(
  "ticket_scanner_links",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    eventId: integer("event_id").notNull(),
    label: text("label").notNull(),
    tokenHash: text("token_hash").notNull(),
    // Optional gate label stamped onto every scan made through this link.
    gateLabel: text("gate_label"),
    active: boolean("active").notNull().default(true),
    createdByStaffId: integer("created_by_staff_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
  },
  (t) => ({
    uniqueHash: uniqueIndex("ticket_scanner_links_hash_unique").on(t.tokenHash),
    byEvent: index("ticket_scanner_links_by_event").on(t.schoolId, t.eventId),
  }),
);

export type TicketScannerLinkRow = typeof ticketScannerLinksTable.$inferSelect;
