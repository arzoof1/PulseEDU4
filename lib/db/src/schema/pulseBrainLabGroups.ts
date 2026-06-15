import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  date,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// PulseBrainLab DELIVERY tables — all SCHOOL-SCOPED (tenant data), unlike the
// global pulse_brain_lab_lessons catalog. These power the Behavior-Specialist
// delivery workflow: build a group, deliver a lesson to it on a date (a
// "session"), and mark per-member attendance.
//
// student references use the canonical students.student_id (the FLEID, a text
// foreign key). Per the FLEID boundary, that id is NEVER rendered — surfaces
// JOIN to students.local_sis_id for display.

// A named intervention group owned by a school. Members live in the child
// table below so attendance + work samples can reference a stable membership.
export const pulseBrainLabGroupsTable = pgTable(
  "pulse_brain_lab_groups",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    name: text("name").notNull(),
    // "K-2" | "3-5" | "6-8" | "9-12" — the band whose curriculum this group runs.
    gradeBand: text("grade_band").notNull(),
    schoolYear: text("school_year").notNull(),
    createdByStaffId: integer("created_by_staff_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    schoolIdx: index("pulse_brain_lab_groups_school_idx").on(t.schoolId),
    schoolYearIdx: index("pulse_brain_lab_groups_school_year_idx").on(
      t.schoolId,
      t.schoolYear,
    ),
  }),
);

// Group roster. One row per (group, student). schoolId is denormalized for
// cheap school-scoped filtering. studentId is the canonical FLEID FK.
export const pulseBrainLabGroupMembersTable = pgTable(
  "pulse_brain_lab_group_members",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    groupId: integer("group_id").notNull(),
    studentId: text("student_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    schoolIdx: index("pulse_brain_lab_group_members_school_idx").on(t.schoolId),
    groupIdx: index("pulse_brain_lab_group_members_group_idx").on(t.groupId),
    uniq: uniqueIndex("pulse_brain_lab_group_members_unique").on(
      t.groupId,
      t.studentId,
    ),
  }),
);

// A delivery of one lesson to one group on one date. lessonKey references the
// global catalog (pulse_brain_lab_lessons.lesson_key). sessionDate is a local
// calendar day (YYYY-MM-DD string) to avoid UTC drift.
export const pulseBrainLabSessionsTable = pgTable(
  "pulse_brain_lab_sessions",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    groupId: integer("group_id").notNull(),
    lessonKey: text("lesson_key").notNull(),
    sessionDate: date("session_date").notNull(),
    notes: text("notes"),
    createdByStaffId: integer("created_by_staff_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    schoolIdx: index("pulse_brain_lab_sessions_school_idx").on(t.schoolId),
    groupIdx: index("pulse_brain_lab_sessions_group_idx").on(t.groupId),
  }),
);

// Per-member attendance for a session. status is one of
// 'present' | 'absent' | 'excused' (validated at the route + OpenAPI layer).
export const pulseBrainLabSessionAttendanceTable = pgTable(
  "pulse_brain_lab_session_attendance",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    sessionId: integer("session_id").notNull(),
    studentId: text("student_id").notNull(),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    schoolIdx: index("pulse_brain_lab_session_attendance_school_idx").on(
      t.schoolId,
    ),
    sessionIdx: index("pulse_brain_lab_session_attendance_session_idx").on(
      t.sessionId,
    ),
    uniq: uniqueIndex("pulse_brain_lab_session_attendance_unique").on(
      t.sessionId,
      t.studentId,
    ),
  }),
);

// Per-(session, student) worksheet QR routing token. The printed worksheet
// carries an opaque base62 token (NO PII, never the FLEID); scanning it back in
// (phone or copier batch) resolves to exactly one (school, session, student) so
// the work sample files to the right place. Minting is idempotent per
// (session_id, student_id) so reprinting a sheet reuses the same token.
export const pulseBrainLabWorksheetTokensTable = pgTable(
  "pulse_brain_lab_worksheet_tokens",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    sessionId: integer("session_id").notNull(),
    studentId: text("student_id").notNull(),
    token: text("token").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    schoolIdx: index("pulse_brain_lab_worksheet_tokens_school_idx").on(
      t.schoolId,
    ),
    tokenUniq: uniqueIndex("pulse_brain_lab_worksheet_tokens_token_unique").on(
      t.token,
    ),
    sessionStudentUniq: uniqueIndex(
      "pulse_brain_lab_worksheet_tokens_session_student_unique",
    ).on(t.sessionId, t.studentId),
  }),
);

// A captured student work sample (the completed worksheet photo/scan) attached
// to exactly one (school, session, student). Filed two ways: the phone path
// (live in-browser QR decode → one student at a time) and the copier-batch path
// (BS scans the whole stack to one multi-page PDF; each page is rasterized +
// QR-decoded in the browser and routed here). `source` records which path filed
// it ('phone' | 'batch' | 'manual' for unmatched-tray assignment). objectKey is
// the /objects/... storage path (school-bound via bindObjectToSchool).
// `shared` is staff-only-by-default: a sample is invisible to families until a
// BS flips the per-item share toggle (the HeartBEAT surface in T006).
export const pulseBrainLabWorkSamplesTable = pgTable(
  "pulse_brain_lab_work_samples",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    sessionId: integer("session_id").notNull(),
    studentId: text("student_id").notNull(),
    objectKey: text("object_key").notNull(),
    pageIndex: integer("page_index"),
    source: text("source").notNull(),
    shared: boolean("shared").notNull().default(false),
    createdByStaffId: integer("created_by_staff_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    schoolIdx: index("pulse_brain_lab_work_samples_school_idx").on(t.schoolId),
    sessionIdx: index("pulse_brain_lab_work_samples_session_idx").on(
      t.sessionId,
    ),
    studentIdx: index("pulse_brain_lab_work_samples_student_idx").on(
      t.schoolId,
      t.studentId,
    ),
  }),
);

// A scanned page whose QR could not be decoded (missing/unreadable) — it lands
// in the per-school "Unmatched" tray for one-tap manual assignment. The BS sees
// the printed local_sis_id + session code fallback (never the FLEID) on the
// page image and assigns it to the right (session, student), which promotes it
// to a work sample (source 'manual'). status: 'pending' | 'assigned' |
// 'discarded'. batchLabel groups pages from the same copier upload.
export const pulseBrainLabUnmatchedScansTable = pgTable(
  "pulse_brain_lab_unmatched_scans",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    objectKey: text("object_key").notNull(),
    source: text("source").notNull(),
    batchLabel: text("batch_label"),
    pageIndex: integer("page_index"),
    status: text("status").notNull().default("pending"),
    createdByStaffId: integer("created_by_staff_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => ({
    schoolStatusIdx: index("pulse_brain_lab_unmatched_scans_school_status_idx").on(
      t.schoolId,
      t.status,
    ),
  }),
);

export type PulseBrainLabGroupRow =
  typeof pulseBrainLabGroupsTable.$inferSelect;
export type PulseBrainLabGroupMemberRow =
  typeof pulseBrainLabGroupMembersTable.$inferSelect;
export type PulseBrainLabSessionRow =
  typeof pulseBrainLabSessionsTable.$inferSelect;
export type PulseBrainLabSessionAttendanceRow =
  typeof pulseBrainLabSessionAttendanceTable.$inferSelect;
export type PulseBrainLabWorksheetTokenRow =
  typeof pulseBrainLabWorksheetTokensTable.$inferSelect;
export type PulseBrainLabWorkSampleRow =
  typeof pulseBrainLabWorkSamplesTable.$inferSelect;
// Parent-submitted "Home Follow-Up" — a TRANSCRIPT of the parent recalling the
// lesson with their child (voice-to-text or typed). Strictly the family's own
// words; never staff-authored. One row per (student, lesson, prompt) so the
// parent can edit a single prompt's answer (upsert on that triple). studentId
// here is the canonical students.student_id (FLEID text FK) — NEVER rendered;
// surfaces JOIN to local_sis_id. createdByParentId attributes it to the parent
// portal account that submitted it. language is the language the prompt was
// shown in ('en' | 'es').
export const pulseBrainLabHomeResponsesTable = pgTable(
  "pulse_brain_lab_home_responses",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    studentId: text("student_id").notNull(),
    lessonKey: text("lesson_key").notNull(),
    // Optional anchor to the specific delivered session this reinforces.
    sessionId: integer("session_id"),
    // Which askYourChild prompt this answers (0-based index into the lesson's
    // parentReinforcement.askYourChild array, which has no stable IDs).
    promptIndex: integer("prompt_index").notNull(),
    transcript: text("transcript").notNull(),
    language: text("language").notNull().default("en"),
    createdByParentId: integer("created_by_parent_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    studentIdx: index("pulse_brain_lab_home_responses_student_idx").on(
      t.schoolId,
      t.studentId,
    ),
    lessonIdx: index("pulse_brain_lab_home_responses_lesson_idx").on(
      t.schoolId,
      t.studentId,
      t.lessonKey,
    ),
    // school_id leads the unique key because student_id (FLEID) is NOT
    // globally unique — two schools could otherwise collide on the same
    // (student_id, lesson_key, prompt_index) and overwrite each other.
    promptUnique: uniqueIndex("pulse_brain_lab_home_responses_prompt_unique").on(
      t.schoolId,
      t.studentId,
      t.lessonKey,
      t.promptIndex,
    ),
  }),
);

export type PulseBrainLabUnmatchedScanRow =
  typeof pulseBrainLabUnmatchedScansTable.$inferSelect;
export type PulseBrainLabHomeResponseRow =
  typeof pulseBrainLabHomeResponsesTable.$inferSelect;
