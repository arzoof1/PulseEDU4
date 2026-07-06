import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

// School-level "call script" library used by the Call Initiative feature.
// A small, ordered set (max 5, enforced in the route) of title + body scripts
// that teachers can pull up in a drawer while logging a family call. School
// scoped and shared across every campaign (not per-campaign).
export const callScriptsTable = pgTable(
  "call_scripts",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    sort: integer("sort").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    schoolSortIdx: index("call_scripts_school_sort_idx").on(t.schoolId, t.sort),
  }),
);

export type CallScriptRow = typeof callScriptsTable.$inferSelect;
