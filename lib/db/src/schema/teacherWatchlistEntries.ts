import {
  pgTable,
  serial,
  integer,
  text,
  date,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// "My Watch List" — teacher-personal, hand-curated bookmark list.
// Distinct from the system Insights Watchlist (which is data-driven and
// shows everyone in the caller's visibility scope). This is each
// teacher's own private "kids on my mind" list with sticky-note style
// notes, self-tagged groups, follow-up nudges, and a last-touch log.
//
// Visibility: rows are scoped to the staff member who created them; a
// teacher cannot see another teacher's list. No sharing in v1 — the
// whole point is that this is the teacher's own working notes (they
// chose what they wrote there knowing nobody else would see it).
//
// Schema choices:
//  - staffId is an integer FK to staff.id. We do NOT declare an FK
//    constraint at the DB level — that's the codebase convention here
//    (see studentMtssPlans.ts). Application code is the source of truth.
//  - studentId is the text business student id (matches every other
//    table that joins to students by their alphanumeric school id, not
//    by the serial PK).
//  - schoolId is captured at write time for multi-tenancy hygiene; it
//    lets us scope cleanups + admin queries by school without joining
//    to staff. SuperUsers acting as another school still write entries
//    pinned to that school, which is the desired behavior.
//  - groupKey is a free-form string. v1 hardcodes four built-in
//    groups in the client (reading / behavior / family / shine);
//    custom groups are a future follow-up but the column already
//    accepts any string so no schema change is needed for that.
//  - note is the freeform "why I'm watching" text. Defaulted to ""
//    so the row stays valid if the teacher is still drafting it.
//  - followupText + followupDue are an optional reminder on a single
//    next action ("call home Friday"). Date-only because real teacher
//    follow-ups don't have a clock time and we don't want a date-time
//    picker in the UI.
//  - lastTouch* are stamped by the server when a quick-action button
//    fires. lastTouchBy is a display name (frozen at touch time) so the
//    log stays human-readable even if the staff record changes later.
//  - UNIQUE (staffId, studentId) enforces "a kid can be on my list
//    once". The teacher edits the existing entry rather than adding a
//    duplicate.
export const teacherWatchlistEntriesTable = pgTable(
  "teacher_watchlist_entries",
  {
    id: serial("id").primaryKey(),
    staffId: integer("staff_id").notNull(),
    schoolId: integer("school_id").notNull(),
    studentId: text("student_id").notNull(),
    groupKey: text("group_key").notNull(),
    note: text("note").notNull().default(""),
    followupText: text("followup_text"),
    followupDue: date("followup_due"),
    addedAt: timestamp("added_at").notNull().defaultNow(),
    // Staff id of who actually CREATED this entry. Null = self-added
    // (the row's owner did it themselves). Non-null = a core-team
    // member (admin / MTSS coord / behavior specialist / PBIS coord /
    // SuperUser) seeded the entry on the teacher's behalf, in which
    // case the UI surfaces a small "Added by X" badge so the teacher
    // knows the entry didn't appear out of nowhere.
    addedByStaffId: integer("added_by_staff_id"),
    lastTouchBy: text("last_touch_by"),
    lastTouchWhat: text("last_touch_what"),
    lastTouchAt: timestamp("last_touch_at"),
  },
  (t) => ({
    uniqStaffStudent: uniqueIndex(
      "teacher_watchlist_staff_student_uniq",
    ).on(t.staffId, t.studentId),
    byStaff: index("teacher_watchlist_by_staff_idx").on(t.staffId),
  }),
);

export type TeacherWatchlistEntry =
  typeof teacherWatchlistEntriesTable.$inferSelect;
export type NewTeacherWatchlistEntry =
  typeof teacherWatchlistEntriesTable.$inferInsert;
