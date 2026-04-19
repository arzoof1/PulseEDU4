import { pgTable, serial, text, boolean, uniqueIndex } from "drizzle-orm/pg-core";

export const schoolAccommodationsTable = pgTable(
  "school_accommodations",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    category: text("category").notNull().default("Strategy"),
    active: boolean("active").notNull().default(true),
  },
  (t) => ({
    nameUnique: uniqueIndex("school_accommodations_name_unique").on(t.name),
  }),
);

export type SchoolAccommodationRow = typeof schoolAccommodationsTable.$inferSelect;
