import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

// =============================================================================
// pickup_queue_events — append-only audit log for the dismissal queue.
//
// The "active queue" is DERIVED at read time: students with an `added` event
// today minus students with a terminal event today (`in_car`, `auto_cleared`,
// `walker_released`). Append-only so the audit trail survives state changes
// and so a parent's "what time did you release my kid?" question can always
// be answered.
//
// Action vocabulary:
//  - added                — curb staff added student to the queue
//  - released_to_walk     — teacher tapped "send to pickup line"
//  - in_car               — curb staff confirmed student got in the car
//  - walker_released      — walker gate released student through the gate
//  - auto_cleared         — end-of-day cron cleared a stale queue entry
//  - restricted_attempt   — typed number was restricted_from this student
//  - restricted_override  — admin overrode the restriction with justification
// =============================================================================
export const pickupQueueEventsTable = pgTable(
  "pickup_queue_events",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    // students.id (integer PK).
    studentId: integer("student_id").notNull(),
    // The authorization that triggered this event (null for terminal
    // events that aren't tied to a specific number — walker_released,
    // auto_cleared, teacher's release_to_walk).
    pickupAuthorizationId: integer("pickup_authorization_id"),
    actorStaffId: integer("actor_staff_id").notNull(),
    actorDisplayName: text("actor_display_name").notNull(),
    action: text("action").notNull(),
    // Justification text for restricted_override; free-form note otherwise.
    note: text("note"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    bySchoolAndDate: index("pickup_events_by_school_date").on(
      t.schoolId,
      t.occurredAt,
    ),
    byStudent: index("pickup_events_by_student").on(t.studentId),
  }),
);

export type PickupQueueEventRow =
  typeof pickupQueueEventsTable.$inferSelect;
