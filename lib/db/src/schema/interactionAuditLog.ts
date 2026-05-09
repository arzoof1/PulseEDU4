import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

// Append-only audit trail for the Watchlist feature. Every meaningful
// state change (create/update/delete on interactions, cases, players,
// statements, alert dismissals, scheduled check-ins) lands a row here.
// Used for the case-level history tab and any future "who edited what"
// auditor view.
export const interactionAuditLogTable = pgTable(
  "interaction_audit_log",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    // 'interaction' | 'case' | 'participant' | 'statement' |
    // 'alert_dismissal' | 'check_in'
    entityType: text("entity_type").notNull(),
    entityId: integer("entity_id").notNull(),
    // 'created' | 'updated' | 'deleted' | 'linked' | 'unlinked' |
    // 'dismissed' | 'reminded' | 'completed' | 'check_in_scheduled'
    action: text("action").notNull(),
    actorStaffId: integer("actor_staff_id"),
    actorName: text("actor_name").notNull().default(""),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    schoolIdx: index("interaction_audit_log_school_idx").on(t.schoolId),
    entityIdx: index("interaction_audit_log_entity_idx").on(
      t.schoolId,
      t.entityType,
      t.entityId,
    ),
  }),
);
export type InteractionAuditLogRow =
  typeof interactionAuditLogTable.$inferSelect;
