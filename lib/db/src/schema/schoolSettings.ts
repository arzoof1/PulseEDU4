import { pgTable, serial, text } from "drizzle-orm/pg-core";

export const schoolSettingsTable = pgTable("school_settings", {
  id: serial("id").primaryKey(),
  schoolName: text("school_name").notNull().default("PulseED"),
  fromName: text("from_name").notNull().default("PulseED"),
  emailSignature: text("email_signature").notNull().default("Thank you,\nPulseED"),
});

export type SchoolSettingsRow = typeof schoolSettingsTable.$inferSelect;
