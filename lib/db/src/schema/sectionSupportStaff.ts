import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// section_support_staff — grants a support teacher (e.g. an ESE / co-teaching
// teacher) access to another teacher's WHOLE class section, assigned by the
// ESE Coordinator.
//
// A support assignment widens the support teacher's Insights visibility scope
// (they can SEE the section's students across the app) AND lets them LOG
// accommodation delivery (single + bulk/small-group) for those students. It
// does NOT let them edit the students' accommodation lists — that stays with
// the ESE Coordinator / Admin.
//
// IMPORTANT — durability across roster re-imports:
// class_sections is WIPED and reinserted on every RosterOne/Skyward rebuild,
// so class_sections.id is NOT stable. We therefore key the assignment on the
// STABLE business identity of a section — (school_id, teacher_staff_id,
// period) — which survives re-imports (staff are never wiped, and there is a
// unique index on class_sections(teacher_staff_id, period)). Every read
// re-resolves the live section from this business key.
//
// Conventions match the rest of this codebase: schoolId is duplicated for
// multi-tenancy and every JOIN is done JS-side with an AND-school filter.
export const sectionSupportStaffTable = pgTable(
  "section_support_staff",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    // The teacher-of-record whose section is being shared (stable identity).
    teacherStaffId: integer("teacher_staff_id").notNull(),
    period: integer("period").notNull(),
    // The support teacher being granted access.
    supportStaffId: integer("support_staff_id").notNull(),
    assignedByStaffId: integer("assigned_by_staff_id"),
    assignedByName: text("assigned_by_name"),
    assignedAt: timestamp("assigned_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    notes: text("notes"),
  },
  (t) => ({
    // Idempotent assignment: one (section business key, support staff) pair per
    // school. POST upgrades a collision to a 200-with-existing-row.
    assignmentUnique: uniqueIndex("section_support_staff_unique").on(
      t.schoolId,
      t.teacherStaffId,
      t.period,
      t.supportStaffId,
    ),
    // Fast lookup for the visibility-scope filter: "all sections this support
    // teacher can see at this school".
    supportIdx: index("section_support_staff_support_idx").on(
      t.schoolId,
      t.supportStaffId,
    ),
    // Fast lookup for the coordinator management UI: "all support staff on
    // this teacher's section".
    sectionIdx: index("section_support_staff_section_idx").on(
      t.schoolId,
      t.teacherStaffId,
      t.period,
    ),
  }),
);

export type SectionSupportStaffRow =
  typeof sectionSupportStaffTable.$inferSelect;
