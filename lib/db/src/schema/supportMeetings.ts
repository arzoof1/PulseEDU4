import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Student Support Meetings module (v1).
//
// Centralizes scheduling, attendance confirmation, and teacher feedback for
// student support meetings (504, IEP, MTSS, parent conferences, ...).
// Meeting type is free-form text (from a configurable dropdown client-side)
// so districts can add types without a schema change.
//
// Student linkage: `student_id` stores the canonical students.student_id
// TEXT value (the SIS id used by section_roster), because attendee
// auto-assignment resolves the student's schedule teachers via
// section_roster which is keyed by that id.
// ---------------------------------------------------------------------------

export const supportMeetingsTable = pgTable("support_meetings", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull(),
  // e.g. "504 Annual Review", "IEP Annual Review", "MTSS Meeting", ...
  meetingType: text("meeting_type").notNull(),
  // Canonical students.student_id (SIS text id) + display snapshot so the
  // meeting record stays readable even if the roster row changes.
  studentId: text("student_id").notNull(),
  studentName: text("student_name").notNull(),
  grade: integer("grade"),
  // Local date + times, school timezone. date = YYYY-MM-DD, times = HH:MM.
  date: text("date").notNull(),
  startTime: text("start_time").notNull(),
  endTime: text("end_time"),
  location: text("location").notNull().default(""),
  virtualLink: text("virtual_link").notNull().default(""),
  // Staff-only notes — never shown to families in any future parent surface.
  notes: text("notes").notNull().default(""),
  organizerStaffId: integer("organizer_staff_id").notNull(),
  // scheduled | canceled | completed
  status: text("status").notNull().default("scheduled"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const supportMeetingAttendeesTable = pgTable(
  "support_meeting_attendees",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    meetingId: integer("meeting_id").notNull(),
    staffId: integer("staff_id").notNull(),
    // Auto-added from the student's schedule (vs manually added by the
    // organizer). Kept so edits can re-sync schedule teachers without
    // clobbering manual additions.
    fromSchedule: boolean("from_schedule").notNull().default(false),
    // pending | confirmed | declined
    response: text("response").notNull().default("pending"),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    // Last manual "send reminder" ping from the organizer.
    remindedAt: timestamp("reminded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

// One feedback submission per attendee per meeting (upsert semantics
// enforced in the route). Question set is the v1 default six fields;
// stored as individual columns for easy reporting.
export const supportMeetingFeedbackTable = pgTable(
  "support_meeting_feedback",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    meetingId: integer("meeting_id").notNull(),
    staffId: integer("staff_id").notNull(),
    academicPerformance: text("academic_performance").notNull().default(""),
    strengths: text("strengths").notNull().default(""),
    concerns: text("concerns").notNull().default(""),
    accommodations: text("accommodations").notNull().default(""),
    recommendations: text("recommendations").notNull().default(""),
    additional: text("additional").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

// Lightweight audit trail (created / updated / canceled / confirmed /
// declined / feedback_submitted / reminder_sent).
export const supportMeetingEventsTable = pgTable("support_meeting_events", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull(),
  meetingId: integer("meeting_id").notNull(),
  staffId: integer("staff_id").notNull(),
  action: text("action").notNull(),
  detail: text("detail").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
