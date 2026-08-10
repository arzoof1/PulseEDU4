import {
  pgTable,
  serial,
  integer,
  text,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

// Authentication & privileged-identity audit trail (Gate A / items 2.5,
// 3.6). Same shape as the other domain audit tables (interaction_audit_log,
// data_export_audit_log, ...). Seeded by the MFA work — records enrollment,
// login-verify success/failure, recovery-code use, session revocation, and
// MFA-policy changes — and is the table later extended to cover role changes
// and roster imports. school_id is nullable because some auth events (e.g. a
// failed login before a school context resolves) are not school-scoped.
export const authAuditLogTable = pgTable(
  "auth_audit_log",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id"),
    action: text("action").notNull(),
    actorStaffId: integer("actor_staff_id"),
    actorName: text("actor_name"),
    targetStaffId: integer("target_staff_id"),
    ip: text("ip"),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Tamper-evidence hash chain (Section 3.8). prevHash links to the prior
    // row's entryHash; entryHash commits to this row's canonical content.
    // Nullable so rows written before 3.8 shipped remain valid (legacy).
    prevHash: text("prev_hash"),
    entryHash: text("entry_hash"),
  },
  (t) => ({
    createdIdx: index("auth_audit_log_created_idx").on(t.createdAt),
    actorIdx: index("auth_audit_log_actor_idx").on(t.actorStaffId),
  }),
);

export type AuthAuditLogRow = typeof authAuditLogTable.$inferSelect;
