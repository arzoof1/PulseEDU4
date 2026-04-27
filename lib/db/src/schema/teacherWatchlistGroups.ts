import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// Custom My Watch List groups (per-teacher).
//
// The first four groups (reading / behavior / family / shine) are
// hardcoded built-ins shared by every teacher and live in the client.
// This table stores any ADDITIONAL groups a teacher creates for their
// own list — e.g. "Math intervention", "Behavior plan candidates",
// "ESOL transition kids".
//
// Schema choices:
//   - staffId is the OWNER. Custom groups are private to one teacher
//     in the same way the entries themselves are; nobody else sees or
//     uses them.
//   - schoolId captured at create time for cleanup-by-school hygiene
//     (mirrors teacherWatchlistEntries).
//   - key is the normalized lowercase identifier (alphanumeric + "-",
//     max 40 chars). Stored on each entry as `groupKey`.
//   - label is the display string the teacher entered.
//   - emoji is optional; the UI falls back to a generic icon when
//     null/empty.
//   - UNIQUE (staffId, key) — a teacher can't have two groups with the
//     same normalized key. Built-in keys (reading/behavior/family/shine)
//     are rejected at the API layer to avoid shadowing.
export const teacherWatchlistGroupsTable = pgTable(
  "teacher_watchlist_groups",
  {
    id: serial("id").primaryKey(),
    staffId: integer("staff_id").notNull(),
    schoolId: integer("school_id").notNull(),
    key: text("key").notNull(),
    label: text("label").notNull(),
    emoji: text("emoji"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    uniqStaffKey: uniqueIndex("teacher_watchlist_groups_staff_key_uniq").on(
      t.staffId,
      t.key,
    ),
    byStaff: index("teacher_watchlist_groups_by_staff_idx").on(t.staffId),
  }),
);

export type TeacherWatchlistGroup =
  typeof teacherWatchlistGroupsTable.$inferSelect;
export type NewTeacherWatchlistGroup =
  typeof teacherWatchlistGroupsTable.$inferInsert;
