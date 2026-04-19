import { pgTable, serial, text, integer, index } from "drizzle-orm/pg-core";

export const pulloutsTable = pgTable(
  "pullouts",
  {
    id: serial("id").primaryKey(),
    studentId: text("student_id").notNull(),
    requestedById: integer("requested_by_id"),
    requestedByName: text("requested_by_name").notNull(),
    requestedAt: text("requested_at").notNull(),
    referringTeacherStaffId: integer("referring_teacher_staff_id"),
    referringTeacherName: text("referring_teacher_name").notNull(),
    period: integer("period"),
    reason: text("reason").notNull(),
    editedReason: text("edited_reason"),
    interventionsTried: text("interventions_tried"),
    // pending | verified | enroute | arrived | returned | closed | rejected
    status: text("status").notNull().default("pending"),
    verifiedById: integer("verified_by_id"),
    verifiedByName: text("verified_by_name"),
    verifiedAt: text("verified_at"),
    rejectedAt: text("rejected_at"),
    rejectedReason: text("rejected_reason"),
    arrivedAt: text("arrived_at"),
    arrivedById: integer("arrived_by_id"),
    arrivedByName: text("arrived_by_name"),
    returnedAt: text("returned_at"),
    closedAt: text("closed_at"),
    parentEmailSentAt: text("parent_email_sent_at"),
    parentEmailStatus: text("parent_email_status"),
    parentEmailErrorMsg: text("parent_email_error_msg"),
    parentEmailTo: text("parent_email_to"),
    reviewedAt: text("reviewed_at"),
    reviewedById: integer("reviewed_by_id"),
    reviewedByName: text("reviewed_by_name"),
    reviewNotes: text("review_notes"),
  },
  (t) => ({
    studentIdx: index("pullouts_student_idx").on(t.studentId),
    statusIdx: index("pullouts_status_idx").on(t.status),
  }),
);

export type PulloutRow = typeof pulloutsTable.$inferSelect;
