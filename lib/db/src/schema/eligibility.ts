import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// =============================================================================
// Eligibility Hub — attendance-based participation eligibility for athletics,
// clubs, and other extracurricular activities. All tables are school-scoped
// (multi-tenant). Student references use the canonical `student_id` (FLEID) as
// the foreign key — NEVER displayed; the UI/exports render `local_sis_id`.
//
// Counting model (locked with product):
//   - The daily attendance upload is the NEW TRUTH: each upload REPLACES the
//     stored absence/tardy totals per student for the current semester (never
//     summed across files).
//   - Counted absences = uploaded absenceTotal − approved parent notes
//     (capped per semester) + tardy spillover (every `tardyToAbsenceRatio`
//     tardies counts as one absence; 0 = tardies ignored).
//   - Everything resets each semester (rows are keyed by `semesterLabel`).
// =============================================================================

// A team / club / activity a school tracks for eligibility.
export const eligibilityActivitiesTable = pgTable(
  "eligibility_activities",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    name: text("name").notNull(),
    // 'athletics' | 'club' | 'activity' — purely descriptive grouping. The
    // eligibility thresholds are uniform school-wide regardless of category.
    category: text("category").notNull().default("athletics"),
    active: boolean("active").notNull().default(true),
    createdByStaffId: integer("created_by_staff_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    schoolIdx: index("eligibility_activities_school_idx").on(t.schoolId),
  }),
);
export type EligibilityActivityRow =
  typeof eligibilityActivitiesTable.$inferSelect;

// A student on an activity roster. Jersey number is per-activity (a student
// can carry a different number on each team). Stored as text to allow "00",
// "7A", etc., and to leave band/chorus blank.
export const eligibilityActivityMembersTable = pgTable(
  "eligibility_activity_members",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    activityId: integer("activity_id").notNull(),
    studentId: text("student_id").notNull(),
    jerseyNumber: text("jersey_number"),
    active: boolean("active").notNull().default(true),
    addedByStaffId: integer("added_by_staff_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    schoolIdx: index("eligibility_members_school_idx").on(t.schoolId),
    activityIdx: index("eligibility_members_activity_idx").on(t.activityId),
    uniqMember: uniqueIndex("eligibility_members_activity_student_uq").on(
      t.activityId,
      t.studentId,
    ),
  }),
);
export type EligibilityActivityMemberRow =
  typeof eligibilityActivityMembersTable.$inferSelect;

// Staff assigned as a coach of an activity. Coaches get a read-only view of
// their roster's at-risk students + parent-note counts, and are on the
// notification audience for their activities.
export const eligibilityActivityCoachesTable = pgTable(
  "eligibility_activity_coaches",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    activityId: integer("activity_id").notNull(),
    staffId: integer("staff_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    schoolIdx: index("eligibility_coaches_school_idx").on(t.schoolId),
    activityIdx: index("eligibility_coaches_activity_idx").on(t.activityId),
    uniqCoach: uniqueIndex("eligibility_coaches_activity_staff_uq").on(
      t.activityId,
      t.staffId,
    ),
  }),
);
export type EligibilityActivityCoachRow =
  typeof eligibilityActivityCoachesTable.$inferSelect;

// Per-student absence/tardy totals for the current semester. The daily upload
// REPLACES these (upsert on the unique key). One row per (school, student,
// semester).
export const eligibilityAbsencesTable = pgTable(
  "eligibility_absences",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    studentId: text("student_id").notNull(),
    semesterLabel: text("semester_label").notNull(),
    absenceTotal: integer("absence_total").notNull().default(0),
    daysTardy: integer("days_tardy").notNull().default(0),
    lastUploadId: integer("last_upload_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    schoolIdx: index("eligibility_absences_school_idx").on(t.schoolId),
    uniqStudentSemester: uniqueIndex(
      "eligibility_absences_student_semester_uq",
    ).on(t.schoolId, t.studentId, t.semesterLabel),
  }),
);
export type EligibilityAbsenceRow = typeof eligibilityAbsencesTable.$inferSelect;

// Approved parent notes. Each row = one excused absence. Entered + approved by
// the attendance secretary (entering IS the approval). Capped per semester
// (school-configurable, default 5). Coaches see the count, read-only.
export const eligibilityParentNotesTable = pgTable(
  "eligibility_parent_notes",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    studentId: text("student_id").notNull(),
    semesterLabel: text("semester_label").notNull(),
    // Free-text reason / what the note said (optional).
    reason: text("reason"),
    // Optional date the absence being excused occurred (YYYY-MM-DD).
    noteDate: text("note_date"),
    enteredByStaffId: integer("entered_by_staff_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    schoolIdx: index("eligibility_parent_notes_school_idx").on(t.schoolId),
    studentSemesterIdx: index(
      "eligibility_parent_notes_student_semester_idx",
    ).on(t.schoolId, t.studentId, t.semesterLabel),
  }),
);
export type EligibilityParentNoteRow =
  typeof eligibilityParentNotesTable.$inferSelect;

// Audit of each daily attendance upload (matched / unmatched counts).
export const eligibilityUploadsTable = pgTable(
  "eligibility_uploads",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    semesterLabel: text("semester_label").notNull(),
    uploadedByStaffId: integer("uploaded_by_staff_id").notNull(),
    filename: text("filename"),
    rowCount: integer("row_count").notNull().default(0),
    matchedCount: integer("matched_count").notNull().default(0),
    unmatchedCount: integer("unmatched_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    schoolIdx: index("eligibility_uploads_school_idx").on(t.schoolId),
  }),
);
export type EligibilityUploadRow = typeof eligibilityUploadsTable.$inferSelect;

// Notification audit / dedup ledger. Records every eligibility notification so
// the weekly digest + threshold-crossing logic doesn't double-send and the
// "re-notify each upload while in the warning zone" cadence is traceable.
export const eligibilityNotificationsTable = pgTable(
  "eligibility_notifications",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    studentId: text("student_id").notNull(),
    semesterLabel: text("semester_label").notNull(),
    // 'warning' | 'ineligible' | 'digest'
    kind: text("kind").notNull(),
    // 'email' | 'sms'
    channel: text("channel").notNull(),
    // 'parent' | 'coach' | 'principal' | 'district_ad'
    audience: text("audience").notNull(),
    recipient: text("recipient"),
    // 'sent' | 'stubbed' | 'failed' | 'skipped'
    status: text("status").notNull(),
    countedAbsences: integer("counted_absences"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    schoolIdx: index("eligibility_notifications_school_idx").on(t.schoolId),
    studentIdx: index("eligibility_notifications_student_idx").on(
      t.schoolId,
      t.studentId,
    ),
  }),
);
export type EligibilityNotificationRow =
  typeof eligibilityNotificationsTable.$inferSelect;
