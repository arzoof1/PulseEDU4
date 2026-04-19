import { pgTable, serial, text, boolean } from "drizzle-orm/pg-core";

export const locationsTable = pgTable("locations", {
  id: serial("id").primaryKey(),
  externalId: text("external_id"),
  name: text("name").notNull().unique(),
  kind: text("kind").notNull().default("classroom"),
  isOrigin: boolean("is_origin").notNull().default(false),
  isDestination: boolean("is_destination").notNull().default(false),
  active: boolean("active").notNull().default(true),
});

export type LocationRow = typeof locationsTable.$inferSelect;
