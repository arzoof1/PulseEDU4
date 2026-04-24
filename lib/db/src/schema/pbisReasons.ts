import { pgTable, serial, text, integer, boolean, index } from "drizzle-orm/pg-core";

export const pbisReasonsTable = pgTable(
  "pbis_reasons",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    name: text("name").notNull(),
    category: text("category").notNull().default("General"),
    defaultPoints: integer("default_points").notNull().default(1),
    active: boolean("active").notNull().default(true),
    polarity: text("polarity").notNull().default("positive"),
    sortOrder: integer("sort_order").notNull().default(0),
    ownerScope: text("owner_scope").notNull().default("school"),
    ownerStaffId: integer("owner_staff_id"),
  },
  (t) => ({
    schoolOwnerIdx: index("pbis_reasons_school_owner_idx").on(
      t.schoolId,
      t.ownerScope,
      t.ownerStaffId,
    ),
  }),
);

export type PbisReasonRow = typeof pbisReasonsTable.$inferSelect;
