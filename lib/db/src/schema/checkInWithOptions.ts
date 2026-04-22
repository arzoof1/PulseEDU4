import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const checkInWithOptionsTable = pgTable(
  "check_in_with_options",
  {
    id: serial("id").primaryKey(),
    label: text("label").notNull(),
    position: integer("position").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
  },
  (t) => ({
    labelUnique: uniqueIndex("check_in_with_options_label_unique").on(t.label),
  }),
);

export type CheckInWithOptionRow =
  typeof checkInWithOptionsTable.$inferSelect;
