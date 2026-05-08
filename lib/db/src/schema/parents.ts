import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// =============================================================================
// HeartBEAT Parent Portal — schema
//
// Parents are a SEPARATE identity from staff. They live in their own table,
// have their own session key (req.session.parentId), and never overlap with
// the staff capability system. A parent is created when an admin sends them
// an invite and they accept it (sets the password, links them to a student).
// One parent row per email per school. Multi-student parents (siblings) are
// modeled via parent_students.
// =============================================================================

export const parentsTable = pgTable(
  "parents",
  {
    id: serial("id").primaryKey(),
    // Tenant column. A parent is anchored to one school. If the same email
    // is used by parents at two different schools, that's two rows. (Edge
    // case; we'll cross that bridge if it shows up.)
    schoolId: integer("school_id").notNull(),
    email: text("email").notNull(),
    // Null until the parent accepts the invite and sets a password.
    passwordHash: text("password_hash"),
    // What we display in the header ("Hi, Sarah"). Defaults to parentName
    // off the student row at invite time, parent can edit later.
    displayName: text("display_name").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  },
  (t) => ({
    // Email is unique per school (allows the same parent address to be
    // re-used across schools if a family moves districts).
    emailPerSchool: uniqueIndex("parents_email_per_school").on(
      t.schoolId,
      t.email,
    ),
  }),
);

export type ParentRow = typeof parentsTable.$inferSelect;

// -----------------------------------------------------------------------------
// parent_students — M:N link. One parent can see multiple students (siblings),
// one student can have multiple parents (mom + dad + guardian).
// -----------------------------------------------------------------------------
export const parentStudentsTable = pgTable(
  "parent_students",
  {
    id: serial("id").primaryKey(),
    parentId: integer("parent_id").notNull(),
    // Refers to students.id (the integer PK), NOT students.student_id (the
    // string district code). Matches the convention used by other join tables.
    studentId: integer("student_id").notNull(),
    // Optional label the parent supplies ("Mom", "Step-dad", "Aunt"). Free
    // text so it never gets in the way; defaults blank.
    relationship: text("relationship"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniquePair: uniqueIndex("parent_students_pair_unique").on(
      t.parentId,
      t.studentId,
    ),
    byParent: index("parent_students_by_parent").on(t.parentId),
    byStudent: index("parent_students_by_student").on(t.studentId),
  }),
);

export type ParentStudentRow = typeof parentStudentsTable.$inferSelect;

// -----------------------------------------------------------------------------
// parent_invites — one row per (student × email) invite. Survives the parent
// accepting the invite (we just flip status to "accepted") so admins can see
// who has and hasn't taken action, and so resend has something to grab.
// -----------------------------------------------------------------------------
export const parentInvitesTable = pgTable(
  "parent_invites",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    // The student this invite is FOR. We snapshot the email at send time
    // (rather than always reading students.parent_email) so a parent who
    // already accepted can see consistent history even if the roster email
    // changes later.
    studentId: integer("student_id").notNull(),
    email: text("email").notNull(),
    // 64-char URL-safe random token (set in code via crypto.randomBytes).
    token: text("token").notNull().unique(),
    // pending | accepted | expired | revoked
    status: text("status").notNull().default("pending"),
    sentAt: timestamp("sent_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    // The staff member who triggered the send (or resend-most-recent).
    sentByStaffId: integer("sent_by_staff_id").notNull(),
    resendCount: integer("resend_count").notNull().default(0),
    lastResentAt: timestamp("last_resent_at", { withTimezone: true }),
    // Once the invite is accepted, point at the parent row that was created
    // (or matched, if a sibling invite). Lets the admin UI show "Accepted by
    // <displayName>" without an extra join.
    acceptedParentId: integer("accepted_parent_id"),
  },
  (t) => ({
    byStudent: index("parent_invites_by_student").on(t.studentId),
    bySchoolStatus: index("parent_invites_by_school_status").on(
      t.schoolId,
      t.status,
    ),
  }),
);

export type ParentInviteRow = typeof parentInvitesTable.$inferSelect;

// -----------------------------------------------------------------------------
// school_heartbeat_settings — admin layer of the toggle system. One row per
// school. Each `show_*` flag controls whether that section is even AVAILABLE
// to parents at this school. A parent can never override "false" to "true";
// they can only hide things the school has already exposed.
//
// Defaults below mirror the proposed positive-first ordering: recognition
// and attendance are open by default, sensitive sections (interventions,
// staff notes, ISS/MTSS) are off until an admin opts in.
// -----------------------------------------------------------------------------
export const schoolHeartbeatSettingsTable = pgTable(
  "school_heartbeat_settings",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    showRecognition: boolean("show_recognition").notNull().default(true),
    showAttendance: boolean("show_attendance").notNull().default(true),
    showHallPasses: boolean("show_hall_passes").notNull().default(true),
    showAccommodations: boolean("show_accommodations").notNull().default(true),
    showFastScores: boolean("show_fast_scores").notNull().default(true),
    showCommHistory: boolean("show_comm_history").notNull().default(true),
    showPullouts: boolean("show_pullouts").notNull().default(true),
    showInterventions: boolean("show_interventions").notNull().default(false),
    showStaffNotes: boolean("show_staff_notes").notNull().default(false),
    showIss: boolean("show_iss").notNull().default(false),
    showMtss: boolean("show_mtss").notNull().default(false),
    // OSS section in the parent portal. Off by default — schools opt in
    // via Heartbeat Settings. When ON parents see dates served + total
    // day count this year. Reasons are gated separately by showOssReason.
    showOss: boolean("show_oss").notNull().default(false),
    showOssReason: boolean("show_oss_reason").notNull().default(false),
    // When true, the school allows parents to opt in to the weekly Sunday
    // PDF email. When false, we hide that toggle on the parent side.
    allowWeeklyEmail: boolean("allow_weekly_email").notNull().default(true),
  },
  (t) => ({
    schoolIdUnique: uniqueIndex("school_heartbeat_settings_school_unique").on(
      t.schoolId,
    ),
  }),
);

export type SchoolHeartbeatSettingsRow =
  typeof schoolHeartbeatSettingsTable.$inferSelect;

// -----------------------------------------------------------------------------
// parent_heartbeat_prefs — per-parent, per-student toggle preferences. Mirror
// of the school flags; a `null` here means "use the school setting". A parent
// can only flip a section OFF; if the school has it OFF, the parent value is
// ignored at read time.
// -----------------------------------------------------------------------------
export const parentHeartbeatPrefsTable = pgTable(
  "parent_heartbeat_prefs",
  {
    id: serial("id").primaryKey(),
    parentId: integer("parent_id").notNull(),
    studentId: integer("student_id").notNull(),
    // Null = inherit school default. Boolean = explicit parent choice.
    showRecognition: boolean("show_recognition"),
    showAttendance: boolean("show_attendance"),
    showHallPasses: boolean("show_hall_passes"),
    showAccommodations: boolean("show_accommodations"),
    showFastScores: boolean("show_fast_scores"),
    showCommHistory: boolean("show_comm_history"),
    showPullouts: boolean("show_pullouts"),
    showInterventions: boolean("show_interventions"),
    showStaffNotes: boolean("show_staff_notes"),
    showIss: boolean("show_iss"),
    showMtss: boolean("show_mtss"),
    // Per-parent OSS toggle. Null = inherit school's showOss flag.
    showOss: boolean("show_oss"),
    // Weekly email opt-in (independent per student so a parent can subscribe
    // for one kid but not another).
    weeklyEmailEnabled: boolean("weekly_email_enabled").notNull().default(false),
    // Set to NOW() on each successful weekly email send. The weekly cron
    // uses this as a dedup window (skip rows sent in the last 6 days) so
    // a re-run on the same day doesn't double-mail. NULL = never sent.
    // Only updated on success — a failure leaves this NULL/old so the
    // next cron run retries.
    lastWeeklyEmailAt: timestamp("last_weekly_email_at", { withTimezone: true }),
    // 'semester' | 'month' | 'all' — default range for the report.
    dateRangeDefault: text("date_range_default").notNull().default("semester"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniquePair: uniqueIndex("parent_heartbeat_prefs_pair_unique").on(
      t.parentId,
      t.studentId,
    ),
  }),
);

export type ParentHeartbeatPrefsRow =
  typeof parentHeartbeatPrefsTable.$inferSelect;
