import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { pulloutsTable } from "./pullouts";

export const issRosterTable = pgTable(
  "iss_roster",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    studentId: text("student_id").notNull(),
    source: text("source").notNull(),
    pulloutId: integer("pullout_id").references(() => pulloutsTable.id, {
      onDelete: "set null",
    }),
    period: integer("period"),
    notes: text("notes"),
    addedById: integer("added_by_id"),
    addedByName: text("added_by_name"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pulloutIdx: uniqueIndex("iss_roster_pullout_id_idx").on(t.pulloutId),
  }),
);

export type IssRosterRow = typeof issRosterTable.$inferSelect;
