import {
  pgTable,
  serial,
  text,
  integer,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

// Append-only audit trail for edits/trims/deletes against
// iss_admin_logs assignments. Drives the "who changed what, when,
// and why" view in the Admin Hub ISS detail drawer.
//
// Every mutating action (edit reason, edit notes, edit dates, trim
// days, delete assignment) writes exactly one row here, with a
// required `edit_reason` justification supplied by the actor.
//
// Actor columns are NOT NULL because every action goes through a
// signed-in admin — no cron paths mutate these.
export const issAdminLogAuditTable = pgTable(
  "iss_admin_log_audit",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    adminLogId: integer("admin_log_id").notNull(),
    actorStaffId: integer("actor_staff_id").notNull(),
    actorDisplayName: text("actor_display_name").notNull(),
    // Closed enum, server-validated:
    //   'edit_reason' | 'edit_notes' | 'edit_dates' | 'trim_days'
    //   | 'delete_assignment'
    action: text("action").notNull(),
    beforeJson: jsonb("before_json").$type<Record<string, unknown>>(),
    afterJson: jsonb("after_json").$type<Record<string, unknown>>(),
    // Required justification — "why are you changing this?" — min 5
    // chars enforced on the route. Auditors read this first.
    editReason: text("edit_reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    byLog: index("iss_admin_log_audit_by_log").on(t.adminLogId),
    bySchool: index("iss_admin_log_audit_by_school").on(t.schoolId),
  }),
);

export type IssAdminLogAuditRow = typeof issAdminLogAuditTable.$inferSelect;
