import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  boolean,
} from "drizzle-orm/pg-core";
import { encryptedText } from "./_encrypted";

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

    monComment: encryptedText("mon_comment"),
    tueComment: encryptedText("tue_comment"),
    wedComment: encryptedText("wed_comment"),
    thuComment: encryptedText("thu_comment"),
    friComment: encryptedText("fri_comment"),

    weeklyComment: encryptedText("weekly_comment").notNull().default(""),

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

    // Per-day absence map. Shape: { mon: true, tue: false, ... }.
    // An absent day is excluded from BOTH the numerator and denominator
    // of any weekly percentage calculation, and the "missing day"
    // count on the notification bell skips it (so teachers aren't
    // pestered to score a day the student wasn't present for). Keys
    // are mon..fri; missing or false means "present (or not yet
    // marked)".
    absentDays: jsonb("absent_days")
      .$type<Record<string, boolean>>()
      .notNull()
      .default({}),

    // --- Academic Tier 3 minutes model (rework) ---
    // Per-day minutes delivered in the academic small group. Shape:
    //   { mon: 30, tue: 0, wed: 15, ... }. Only meaningful for academic
    //   Tier 3 records (the plan carries fastSubject). Behavior records
    //   leave this as the empty default and keep using monScore..friScore.
    //   The week is "met" when the sum across days reaches the plan's
    //   academicMinutesTarget.
    academicMinutes: jsonb("academic_minutes")
      .$type<Record<string, number>>()
      .notNull()
      .default({}),
    // Release valve: the interventionist (or a coordinator) marks the week
    // "no group provided this week" so it counts as EXCUSED rather than
    // owed on the bell + reports. Captures who released it and why for the
    // audit trail. Clearing the flag (logging minutes again) reverts it.
    releasedNoIntervention: boolean("released_no_intervention")
      .notNull()
      .default(false),
    releaseReason: encryptedText("release_reason"),
    releasedByStaffId: integer("released_by_staff_id"),
    releasedAt: timestamp("released_at", { withTimezone: true }),

    // When the teacher clicks "Submit" on the weekly form. NULL means
    // the record is still a working draft — the teacher can save and
    // come back to it any number of times before submitting on Friday.
    // Submitting is non-destructive: edits are still allowed, the
    // timestamp just gets bumped on a re-submit.
    submittedAt: timestamp("submitted_at", { withTimezone: true }),

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
