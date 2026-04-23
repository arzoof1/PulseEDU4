import { pgTable, serial, text, integer, boolean, uniqueIndex } from "drizzle-orm/pg-core";

export const schoolAccommodationsTable = pgTable(
  "school_accommodations",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull().default(1),
    name: text("name").notNull(),
    category: text("category").notNull().default("Strategy"),
    active: boolean("active").notNull().default(true),
  },
  (t) => ({
    // Per-school uniqueness — name uniqueness must be tenant-scoped so that
    // school A creating an accommodation called "Extended Time" doesn't
    // block school B from doing the same.
    schoolNameUnique: uniqueIndex("school_accommodations_school_id_name_unique").on(
      t.schoolId,
      t.name,
    ),
  }),
);

export type SchoolAccommodationRow = typeof schoolAccommodationsTable.$inferSelect;
