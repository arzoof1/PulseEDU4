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

// On-Time Attendance ledger. Written when a student scans/enters their ID
// on a classroom-door kiosk that has auto-flipped to Attendance mode during
// the passing period. This is a SEPARATE ledger from pbis_entries on
// purpose: on-time points DO count toward house standings (see
// routes/houses.ts) but are NEVER part of the "Invisible Student"
// calculation (which reads pbis_entries only), so auto-earned arrival
// points can't quietly remove a student from the adult-recognition list.
//
// `studentId` is the canonical FLEID (students.student_id, TEXT) to match
// the pbis_entries / section_roster join style used by house standings.
// student_id is NOT globally unique — every query MUST also filter school_id.
//
// `kind`:
//   'checkin'  — a normal on-time arrival (points = ceil(min to bell),
//                capped; or flat post-bell credit when postBell = true).
//   'lottery'  — a Tardy-Lottery bonus row materialized at reveal time for
//                every student who was present (had a 'checkin') in the
//                winning class. Lives here so it also counts toward house
//                standings without touching pbis_entries.
//
// Idempotency: one row per (school_id, student_id, period_key, kind) so a
// rapid double-scan in the same passing window is a no-op ("Already in").
export const attendanceCheckinsTable = pgTable(
  "attendance_checkins",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    studentId: text("student_id").notNull(),
    kioskActivationId: integer("kiosk_activation_id"),
    staffId: integer("staff_id"),
    scheduleId: integer("schedule_id"),
    // The INCOMING period the student is arriving to (the class they get
    // on-time credit for), matched against class_sections.period for the
    // roster gate.
    periodNumber: integer("period_number").notNull(),
    // s<scheduleId>:p<incomingPeriodNumber>:<YYYY-MM-DD> school-local.
    periodKey: text("period_key").notNull(),
    day: text("day").notNull(),
    kind: text("kind").notNull().default("checkin"),
    points: integer("points").notNull().default(0),
    // Minutes until the tardy bell at scan time. NULL for lottery rows.
    minutesRemaining: integer("minutes_remaining"),
    // True when the scan landed AFTER the bell but before the teacher tapped
    // Done (the in-line grace window) — these earn a flat credit.
    postBell: boolean("post_bell").notNull().default(false),
    // 'usb' | 'camera' | 'keypad' | 'lottery' — informational.
    source: text("source"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    oncePerPeriod: uniqueIndex("attendance_checkins_once_idx").on(
      t.schoolId,
      t.studentId,
      t.periodKey,
      t.kind,
    ),
    schoolDayIdx: index("attendance_checkins_school_day_idx").on(
      t.schoolId,
      t.day,
    ),
    studentIdx: index("attendance_checkins_student_idx").on(
      t.schoolId,
      t.studentId,
      t.createdAt,
    ),
  }),
);

export type AttendanceCheckinRow = typeof attendanceCheckinsTable.$inferSelect;

// Append-only log of scans REJECTED by the roster gate (student scanned at a
// room whose incoming class they are not rostered to). No points, no
// presence credit — purely so admins can see "wrong door" attempts. No
// unique constraint: a student can (and will) re-try, and each attempt is
// recorded. studentId may be NULL when the scanned localSisId resolves to no
// student in this school.
export const onTimeRejectedScansTable = pgTable(
  "on_time_rejected_scans",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    studentId: text("student_id"),
    scannedLocalSisId: text("scanned_local_sis_id"),
    kioskActivationId: integer("kiosk_activation_id"),
    staffId: integer("staff_id"),
    periodNumber: integer("period_number"),
    periodKey: text("period_key"),
    day: text("day").notNull(),
    // 'not_rostered' | 'unknown_student'
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    schoolDayIdx: index("on_time_rejected_school_day_idx").on(
      t.schoolId,
      t.day,
    ),
  }),
);

export type OnTimeRejectedScanRow =
  typeof onTimeRejectedScansTable.$inferSelect;
