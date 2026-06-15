import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Immutable log of the daily On-Time / Tardy-Lottery draw. One row per
// (school_id, day). The draw is performed at reveal time (the lead-time
// before end of day) FROM periods whose attendance windows have already
// closed, so no student can know the winner in advance — the row IS the
// tamper-evident record an admin checks the announced winner against.
//
// status:
//   'revealed' — a winning class was picked; bonus rows were materialized
//                into attendance_checkins (kind='lottery') and the admin
//                notification email was sent.
//   'skipped'  — no eligible class ran attendance today (early rollout / no
//                kiosks); `reason` explains why. No points awarded.
export const onTimeLotteryDrawsTable = pgTable(
  "on_time_lottery_draws",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    day: text("day").notNull(),
    scheduleId: integer("schedule_id"),
    periodNumber: integer("period_number"),
    sectionId: integer("section_id"),
    teacherStaffId: integer("teacher_staff_id"),
    teacherName: text("teacher_name"),
    courseName: text("course_name"),
    bonusPoints: integer("bonus_points").notNull().default(0),
    winnerCount: integer("winner_count").notNull().default(0),
    labelSnapshot: text("label_snapshot"),
    status: text("status").notNull().default("revealed"),
    reason: text("reason"),
    revealedAt: timestamp("revealed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    oncePerDay: uniqueIndex("on_time_lottery_once_per_day_idx").on(
      t.schoolId,
      t.day,
    ),
  }),
);

export type OnTimeLotteryDrawRow =
  typeof onTimeLotteryDrawsTable.$inferSelect;
