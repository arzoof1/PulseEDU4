import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

// =============================================================================
// ticket_events — a free-ticket school event (8th-grade promotion, graduation,
// etc.). Phase 1 of the Event Ticketing module.
//
// An admin/front-office user creates an event, allocates a per-student ticket
// quota by grade (with overrides), then emails each student's guardian their
// QR-code tickets. Families share codes freely; staff scan at the gate where
// the first scan admits and any rescan shows "already used".
//
// `capacity` is nullable — null means unlimited (no cap). When set, the live
// "X of Y admitted" count + near-full warning are driven by the count of
// tickets in status 'used'.
//
// `eventDayOnly` is an optional validity window: when true, the scan endpoints
// only admit on `eventDate` (school-local). Default false = valid anytime.
//
// Phase 2 will extend this table for paid tickets (price/currency/Stripe),
// reserved seating, and waitlists — left additive on purpose.
// =============================================================================
export const ticketEventsTable = pgTable(
  "ticket_events",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    // School-local calendar date "YYYY-MM-DD" (text to avoid UTC pitfalls).
    eventDate: text("event_date"),
    // School-local start time "HH:MM" (optional, display only).
    startTime: text("start_time"),
    location: text("location"),
    // null = unlimited; when set, drives the live admitted count + warning.
    capacity: integer("capacity"),
    // 'draft' | 'published' | 'closed'
    status: text("status").notNull().default("draft"),
    // Optional validity window — only admit scans on eventDate when true.
    eventDayOnly: boolean("event_day_only").notNull().default(false),
    createdByStaffId: integer("created_by_staff_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    bySchool: index("ticket_events_by_school").on(t.schoolId),
  }),
);

export type TicketEventRow = typeof ticketEventsTable.$inferSelect;
