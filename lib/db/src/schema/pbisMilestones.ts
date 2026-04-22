import {
  pgTable,
  serial,
  integer,
  boolean,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Per-school PBIS milestone thresholds. Two schools may both use 50 pts,
// but a single school can't use the same points value twice — enforced by
// the composite unique index below (matches DB constraint
// `pbis_milestones_school_points_unique`).
export const pbisMilestonesTable = pgTable(
  "pbis_milestones",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull().default(1),
    points: integer("points").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    schoolPointsUnique: uniqueIndex("pbis_milestones_school_points_unique").on(
      t.schoolId,
      t.points,
    ),
  }),
);
export type PbisMilestoneRow = typeof pbisMilestonesTable.$inferSelect;

export const pbisMilestoneEmailsTable = pgTable(
  "pbis_milestone_emails",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull().default(1),
    studentId: text("student_id").notNull(),
    milestonePoints: integer("milestone_points").notNull(),
    sentAt: text("sent_at").notNull(),
    emailTo: text("email_to"),
    status: text("status").notNull(), // pending | sent | skipped | error
    errorMsg: text("error_msg"),
  },
  (t) => ({
    // D5: include schoolId so school A claiming/sending a student's
    // milestone email doesn't silently block school B (same student id at
    // both schools) from sending its own milestone email.
    studentMilestoneUnique: uniqueIndex(
      "pbis_milestone_emails_student_pts_unique",
    ).on(t.studentId, t.milestonePoints, t.schoolId),
  }),
);
export type PbisMilestoneEmailRow = typeof pbisMilestoneEmailsTable.$inferSelect;
