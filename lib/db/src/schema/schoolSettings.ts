import { pgTable, serial, text, integer } from "drizzle-orm/pg-core";

export const schoolSettingsTable = pgTable("school_settings", {
  id: serial("id").primaryKey(),
  schoolName: text("school_name").notNull().default("PulseEDU"),
  fromName: text("from_name").notNull().default("PulseEDU"),
  emailSignature: text("email_signature").notNull().default("Thank you,\nPulseEDU"),
  periodCount: integer("period_count").notNull().default(7),
});

export type SchoolSettingsRow = typeof schoolSettingsTable.$inferSelect;
