import { pgTable, serial, text, integer } from "drizzle-orm/pg-core";

export const schoolSettingsTable = pgTable("school_settings", {
  id: serial("id").primaryKey(),
  schoolName: text("school_name").notNull().default("PulseED"),
  fromName: text("from_name").notNull().default("PulseED"),
  emailSignature: text("email_signature").notNull().default("Thank you,\nPulseED"),
  periodCount: integer("period_count").notNull().default(7),
  hallPassMaxMinutes: integer("hall_pass_max_minutes").notNull().default(30),
  hallPassDefaultMinutes: integer("hall_pass_default_minutes")
    .notNull()
    .default(5),
});

export type SchoolSettingsRow = typeof schoolSettingsTable.$inferSelect;
