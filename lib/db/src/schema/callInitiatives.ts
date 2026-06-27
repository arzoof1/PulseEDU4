import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

// A "call all families" campaign created by Core Team. One active per school
// (enforced in the route: creating a new active campaign archives the prior).
//
// completionRule:
//   strict   -> must have a log with outcome = Reached
//   balanced -> Reached OR attemptsRequired logged attempts (default N=2)
//   any      -> any logged contact counts
//
// responsiblePeriod = the class period whose teacher "owns" each student's call
// (default 1 = first period). Days remaining + the per-teacher worklist derive
// from startDate + windowDays and the responsible-period roster.
export const callInitiativesTable = pgTable(
  "call_initiatives",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    name: text("name").notNull(),
    startDate: text("start_date").notNull(), // YYYY-MM-DD (school-local)
    windowDays: integer("window_days").notNull().default(14),
    responsiblePeriod: integer("responsible_period").notNull().default(1),
    completionRule: text("completion_rule").notNull().default("balanced"),
    attemptsRequired: integer("attempts_required").notNull().default(2),
    active: boolean("active").notNull().default(true),
    createdByStaffId: integer("created_by_staff_id"),
    createdByName: text("created_by_name"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    schoolActiveIdx: index("call_initiatives_school_active_idx").on(
      t.schoolId,
      t.active,
    ),
  }),
);

export type CallInitiativeRow = typeof callInitiativesTable.$inferSelect;
