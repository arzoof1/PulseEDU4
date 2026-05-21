import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Discipline reasons used by the Add ISS / OSS Log modals.
//
// Two scopes are supported (exactly one of the two id columns is set
// per row — enforced by a CHECK constraint in seed.ts):
//   - District master list (district_id set, school_id NULL): managed
//     by a district admin, visible read-only at every school in the
//     district. Use when a district has a unified code of conduct.
//   - School list (school_id set, district_id NULL): managed by the
//     school admin. Use when a school purchased the app standalone,
//     or when the school wants additional reasons on top of the
//     district master list.
//
// The Add ISS / OSS Log modal merges both lists. Inactive rows still
// display on historical entries but don't appear in the dropdown for
// new logs.
export const disciplineReasonsTable = pgTable(
  "discipline_reasons",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id"),
    districtId: integer("district_id"),
    label: text("label").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  // Partial unique indexes are created in seed.ts (drizzle's index DSL
  // doesn't model partial WHERE clauses well, and we don't run
  // drizzle-kit anyway). The constraints enforced there are:
  //   - UNIQUE(school_id, label)   WHERE school_id   IS NOT NULL
  //   - UNIQUE(district_id, label) WHERE district_id IS NOT NULL
  //   - CHECK ((school_id IS NULL) <> (district_id IS NULL))
);

export type DisciplineReasonRow = typeof disciplineReasonsTable.$inferSelect;
