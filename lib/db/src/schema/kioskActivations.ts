import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";

export const kioskActivationsTable = pgTable("kiosk_activations", {
  id: serial("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  room: text("room").notNull(),
  staffId: integer("staff_id").notNull(),
  activatedAt: timestamp("activated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
  deactivatedByStaffId: integer("deactivated_by_staff_id"),
});

export type KioskActivationRow = typeof kioskActivationsTable.$inferSelect;
