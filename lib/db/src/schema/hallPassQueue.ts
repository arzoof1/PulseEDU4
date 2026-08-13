import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Per-ROOM waiting line for hall passes. A student joins the line either from
// a kiosk (scan/type their ID) or by their teacher adding them in the staff
// app; when the active pass-holder returns, the next entry is promoted. The
// line is tagged with the bell-schedule period it was queued in so it
// auto-clears at the period boundary.
//
// ANCHOR: the line is keyed on (school_id, room) — NOT on a kiosk activation.
// It was originally per-activation, but the district blocked kiosk devices, so
// teacher-created passes became the only path and a queue that required an
// activation row could not exist for them. Room anchoring also means a teacher
// and a kiosk standing in the same room share ONE line instead of keeping two
// private ones that each believe they hold the next student.
export const hallPassQueueTable = pgTable(
  "hall_pass_queue",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    // Which kiosk device the student used to join, when they used one. NULL
    // for teacher-created entries — the common case now. Retained purely as
    // provenance: nothing keys off it, and it must never be used to scope a
    // read, or teacher entries disappear from that surface.
    kioskActivationId: integer("kiosk_activation_id"),
    // The anchor. Matches an active origin `locations.name` for the school.
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
    // A student can only be in a given ROOM's line once at a time. Scoped to
    // the room rather than the school on purpose: a student legitimately
    // appears in two different rooms' lines (e.g. queued in class, then
    // summoned), and a school-wide constraint would reject the second.
    roomStudentIdx: uniqueIndex("hall_pass_queue_room_student_idx").on(
      t.schoolId,
      t.room,
      t.studentId,
    ),
  }),
);

export type HallPassQueueRow = typeof hallPassQueueTable.$inferSelect;
