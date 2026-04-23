import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";

export const adminNotificationsTable = pgTable("admin_notifications", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull().default(1),
  type: text("type").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolvedByStaffId: integer("resolved_by_staff_id"),
});

export type AdminNotificationRow =
  typeof adminNotificationsTable.$inferSelect;
