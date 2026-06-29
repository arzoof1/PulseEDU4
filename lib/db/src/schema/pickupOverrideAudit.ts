import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

// =============================================================================
// pickup_override_audit — append-only history of front-office overrides to
// car-tag / rider / dismissal data that is normally sourced from RosterOne
// (via ClassLink).
//
// Separate from pickup_queue_events (which logs curb/dismissal-queue activity)
// because this log answers a different question: "who changed the authoritative
// pickup record, when, and why?" Every manual create/edit/clear and every
// dismissal-mode change writes one row. Append-only so the trail survives later
// edits and a parent/admin can always reconstruct what the office did.
//
// Action vocabulary:
//  - manual_add     — office created a manual authorization row.
//  - relabel        — office changed the guardian label on a row.
//  - restrict       — office set restricted_from = true (block guardian).
//  - unrestrict     — office set restricted_from = false.
//  - deactivate     — office deactivated a row (= manually clearing it).
//  - set_expiry     — office set/changed/cleared a temporary expiry.
//  - dismissal_mode — office changed students.dismissal_mode.
//  - auto_expire    — the expiry sweep retired a past-due temporary override.
// =============================================================================
export const pickupOverrideAuditTable = pgTable(
  "pickup_override_audit",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    // students.id (integer PK).
    studentId: integer("student_id").notNull(),
    // The authorization row this action touched (null for dismissal_mode,
    // which is keyed to the student rather than a tag).
    authorizationId: integer("authorization_id"),
    // staff.id + display name of the office user (auto_expire uses 0 / "system").
    actorStaffId: integer("actor_staff_id").notNull(),
    actorDisplayName: text("actor_display_name").notNull(),
    action: text("action").notNull(),
    // Required justification for office actions; null for auto_expire.
    reason: text("reason"),
    // Optional human-readable old->new detail (e.g. "car_rider -> walker").
    detail: text("detail"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    bySchoolAndDate: index("pickup_override_audit_by_school_date").on(
      t.schoolId,
      t.createdAt,
    ),
    byStudent: index("pickup_override_audit_by_student").on(t.studentId),
  }),
);

export type PickupOverrideAuditRow =
  typeof pickupOverrideAuditTable.$inferSelect;
