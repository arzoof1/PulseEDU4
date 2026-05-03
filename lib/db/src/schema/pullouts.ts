import { pgTable, serial, text, integer, index } from "drizzle-orm/pg-core";

export const pulloutsTable = pgTable(
  "pullouts",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
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
    dispatchEmailSentAt: text("dispatch_email_sent_at"),
    dispatchEmailStatus: text("dispatch_email_status"),
    dispatchEmailTo: text("dispatch_email_to"),
    dispatchEmailErrorMsg: text("dispatch_email_error_msg"),
    // Parent send-to-ISS email — fired once at verify time using
    // the verifier-authored parent_message body. Idempotent on
    // sentToIssEmailSentAt so re-verifying or refreshing won't
    // double-send.
    sentToIssEmailSentAt: text("sent_to_iss_email_sent_at"),
    sentToIssEmailStatus: text("sent_to_iss_email_status"),
    sentToIssEmailTo: text("sent_to_iss_email_to"),
    sentToIssEmailErrorMsg: text("sent_to_iss_email_error_msg"),
    // Parent-facing message captured at the Verify step. Editable by the
    // verifier in a notes panel; if set, the arrival email uses this as
    // its body verbatim (with template placeholders already substituted
    // client-side). Null = fall back to the auto-generated arrival body.
    parentMessage: text("parent_message"),
    // Parent-facing message recorded when the student is marked
    // "returned to class". Auto-filled on /returned with the standard
    // wording so a future SMS sender can read the same string.
    returnMessage: text("return_message"),
  },
  (t) => ({
    studentIdx: index("pullouts_student_idx").on(t.studentId),
    statusIdx: index("pullouts_status_idx").on(t.status),
  }),
);

export type PulloutRow = typeof pulloutsTable.$inferSelect;

// School-scoped catalog of canned parent messages the verifier can
// drop into the Verify modal's notes textarea. Managed by Behavior
// Specialist / Admin / SuperUser from the Behavior Dashboard.
// Templates support these substitution placeholders, all of which the
// verifier already has on the pullout row:
//   {firstName} {lastName} {teacherName} {reason} {period} {schoolName}
export const pulloutNoteTemplatesTable = pgTable(
  "pullout_note_templates",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    active: text("active").notNull().default("true"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at"),
  },
  (t) => ({
    schoolIdx: index("pullout_note_templates_school_idx").on(t.schoolId),
  }),
);
export type PulloutNoteTemplateRow =
  typeof pulloutNoteTemplatesTable.$inferSelect;
