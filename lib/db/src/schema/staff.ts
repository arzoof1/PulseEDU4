import { pgTable, serial, text, boolean, timestamp } from "drizzle-orm/pg-core";

export const staffTable = pgTable("staff", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").notNull(),
  isAdmin: boolean("is_admin").notNull().default(false),
  isEseCoordinator: boolean("is_ese_coordinator").notNull().default(false),
  isPbisCoordinator: boolean("is_pbis_coordinator").notNull().default(false),
  isBehaviorSpecialist: boolean("is_behavior_specialist").notNull().default(false),
  externalId: text("external_id"),
  ssoProvider: text("sso_provider"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type StaffRow = typeof staffTable.$inferSelect;
