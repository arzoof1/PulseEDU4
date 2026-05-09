import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Per-kiosk waiting line for hall passes. A student adds themselves to the
// queue from the kiosk, and when the active pass-holder taps "I'm back" the
// next entry pops onto the kiosk screen waiting for ID entry. Entries are
// scoped to a single `kiosk_activations` row (i.e. one queue per device per
// activation) and tagged with the bell-schedule period they were queued in
// so the queue auto-clears at the period boundary.
export const hallPassQueueTable = pgTable(
  "hall_pass_queue",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    kioskActivationId: integer("kiosk_activation_id").notNull(),
    // Cached so we can render the queue on the teacher chip without
    // re-resolving the activation row.
    room: text("room").notNull(),
    studentId: text("student_id").notNull(),
    firstName: text("first_name"),
    lastName: text("last_name"),
    destination: text("destination").notNull(),
    position: integer("position").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Period bucket key. When the current period key changes, all queue
    // rows with a stale key are cleared on the next read so each period
    // starts with an empty line.
    periodKey: text("period_key").notNull(),
  },
  (t) => ({
    // A student can only be in a given kiosk's queue once at a time.
    kioskStudentIdx: uniqueIndex("hall_pass_queue_kiosk_student_idx").on(
      t.kioskActivationId,
      t.studentId,
    ),
  }),
);

export type HallPassQueueRow = typeof hallPassQueueTable.$inferSelect;
