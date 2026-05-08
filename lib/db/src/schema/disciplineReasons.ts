import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Per-school list of discipline reasons used by the Add ISS / OSS Log
// modals. Maintained by school Admin via a small admin screen. Inactive
// rows still display on historical entries but don't appear in the
// dropdown for new logs.
export const disciplineReasonsTable = pgTable(
  "discipline_reasons",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    label: text("label").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    bySchoolLabel: uniqueIndex("discipline_reasons_school_label_uq").on(
      t.schoolId,
      t.label,
    ),
  }),
);

export type DisciplineReasonRow = typeof disciplineReasonsTable.$inferSelect;
