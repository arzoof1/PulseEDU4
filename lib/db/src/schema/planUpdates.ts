import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Student Plan Updates (v1).
//
// After a support meeting revises a student's plan (504 / ESE-IEP / ELL /
// Behavior), the MTSS coordinator (Core Team / counselors) logs a Plan
// Update: a short plain-language summary of what changed, an effective
// date (defaults to the linked meeting's date), and the set of teachers
// who must re-read the plan and acknowledge.
//
// Teachers see an "Updated" dot on the matching program pill on their
// Teacher Roster; the pill's hover box shows the summary and an
// "I've re-read this plan" checkbox that records the acknowledgment.
// The coordinator's Plan Updates tab shows per-update ack progress.
//
// student_id stores the canonical students.student_id TEXT value (SIS id),
// same convention as support_meetings.
// ---------------------------------------------------------------------------

export const planUpdatesTable = pgTable("plan_updates", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull(),
  // ese | 504 | ell | behavior — matches the roster pill set.
  planType: text("plan_type").notNull(),
  studentId: text("student_id").notNull(),
  studentName: text("student_name").notNull(),
  grade: integer("grade"),
  // Plain-language summary of what changed — this is what teachers read.
  summary: text("summary").notNull(),
  // Local date, YYYY-MM-DD. Defaults client-side to the linked meeting date.
  effectiveDate: text("effective_date").notNull(),
  // Optional link to the support meeting that produced the change.
  meetingId: integer("meeting_id"),
  createdByStaffId: integer("created_by_staff_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  // Soft close: archived updates stop showing dots / counting acks.
  archivedAt: timestamp("archived_at", { withTimezone: true }),
});

// One row per teacher who must acknowledge; acknowledged_at NULL = pending.
export const planUpdateRecipientsTable = pgTable(
  "plan_update_recipients",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    updateId: integer("update_id").notNull(),
    staffId: integer("staff_id").notNull(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    // Last manual "send reminder" ping from the coordinator.
    remindedAt: timestamp("reminded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Mirrors plan_update_recipients_unique in ensurePlanUpdatesSchema.
    unique("plan_update_recipients_unique").on(t.updateId, t.staffId),
  ],
);
