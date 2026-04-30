import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

// Tier 3 weekly tracking record. ONE row per (student, teacher, week).
// Every teacher on a Tier 3 student's schedule must complete their own
// weekly record; one teacher's submission does not clear the obligation
// for the others.
//
// `weekStartDate` is always a Monday in school-local time, stored as
// "YYYY-MM-DD" text (timezone-safe).
//
// Score scale (frozen): 5 = 80%+ of day, 4 = 60-80%, 3 = 40-60%,
// 2 = 20-40%, 1 = <20%. Stored as integer 1..5 or NULL when the day
// hasn't been scored.
//
// PRIDE / school-wide expectation tracking is optional per plan. When
// the plan's `track_school_wide_expectations` flag is on, the form also
// captures pride_mon..pride_fri on a 0..2 scale: 0 = Not at all, 1 = 50%,
// 2 = 80%+. NULL when the plan has the option off.
//
// `goalVersionIds` snapshots which `tier3_goals.id`s were the active
// goal text for each slot when this week was scored, so historical
// reports can pair scores with the goals as they were worded then.
// Shape: { "1": <goalId>, "2": <goalId>, "3": <goalId>?, ... }
export const tier3WeeklyRecordsTable = pgTable(
  "tier3_weekly_records",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    studentId: text("student_id").notNull(),
    teacherStaffId: integer("teacher_staff_id").notNull(),
    weekStartDate: text("week_start_date").notNull(), // Monday "YYYY-MM-DD"

    monScore: integer("mon_score"),
    tueScore: integer("tue_score"),
    wedScore: integer("wed_score"),
    thuScore: integer("thu_score"),
    friScore: integer("fri_score"),

    monComment: text("mon_comment"),
    tueComment: text("tue_comment"),
    wedComment: text("wed_comment"),
    thuComment: text("thu_comment"),
    friComment: text("fri_comment"),

    weeklyComment: text("weekly_comment").notNull().default(""),

    prideMon: integer("pride_mon"),
    prideTue: integer("pride_tue"),
    prideWed: integer("pride_wed"),
    prideThu: integer("pride_thu"),
    prideFri: integer("pride_fri"),

    goalVersionIds: jsonb("goal_version_ids")
      .$type<Record<string, number>>()
      .notNull()
      .default({}),

    // Per-goal-per-day score map. Shape:
    //   { "1": {"mon":5,"tue":4,"wed":null,"thu":3,"fri":null}, "2": {...} }
    // Slot keys are "1".."tier3GoalSlots" (max 5). Day keys mon..fri.
    // Values: integer 1..5 or null when the day hasn't been scored for
    // that goal. The single-column `monScore..friScore` fields above
    // remain authoritative for whole-day analytics; the server
    // auto-populates them as the rounded average of the per-goal
    // scores on save so existing dashboards keep working unchanged.
    goalScores: jsonb("goal_scores")
      .$type<Record<string, Record<string, number | null>>>()
      .notNull()
      .default({}),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (t) => ({
    schoolIdx: index("tier3_weekly_school_idx").on(t.schoolId),
    studentWeekIdx: index("tier3_weekly_student_week_idx").on(
      t.schoolId,
      t.studentId,
      t.weekStartDate,
    ),
    teacherWeekIdx: index("tier3_weekly_teacher_week_idx").on(
      t.schoolId,
      t.teacherStaffId,
      t.weekStartDate,
    ),
  }),
);

export type Tier3WeeklyRecordRow =
  typeof tier3WeeklyRecordsTable.$inferSelect;
