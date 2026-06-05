import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// algebra_placement_overrides — audit row per (school, student, schoolYear)
// that the school has manually overridden away from Florida's automatic
// "7th-grade Math PM3 L3+ → Algebra I in 8th" placement rule.
//
// One row per student per school year. Re-saving an override for the
// same (school, student, schoolYear) UPDATES the existing row (we
// upsert) so a counselor can adjust the justification or attach a
// late-arriving opt-out PDF without leaving a stale duplicate row in
// the audit trail.
//
// The unique key includes school_id (multi-tenancy). The
// `opt_out_file_object_key` field, when set, points at an object stored
// via /api/storage/* with a school-staff-only ACL (bindObjectToSchool)
// — explicitly NOT exposed to the parent portal in v1.
export const algebraPlacementOverridesTable = pgTable(
  "algebra_placement_overrides",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    // Matches students.student_id (text, not globally unique).
    studentId: text("student_id").notNull(),
    // "YY-YY" label of the placement year the override applies to.
    // E.g. for a current 7th-grader being placed for next year, this
    // is the CURRENT school year (the year of the PM3 that triggered
    // the mandate).
    schoolYear: text("school_year").notNull(),
    // Decision. v1 only supports "regular_8th" — the opt-out target.
    // Stored as text so future decisions ("intensive_algebra1", etc.)
    // can be added without a schema change.
    decision: text("decision").notNull().default("regular_8th"),
    // Free-form justification entered by the deciding staff member.
    // Required by the route (min 10 chars, max 2000).
    justification: text("justification").notNull(),
    // Optional /objects/<uuid> path of the signed parent-opt-out form.
    // bindObjectToSchool() is called by the route before the row is
    // saved so the file's ACL is locked to this school's staff.
    optOutFileObjectKey: text("opt_out_file_object_key"),
    // Staff member who saved this override. Used in the audit log and
    // rendered as "Decided by …" on the placement-review report.
    decidedByStaffId: integer("decided_by_staff_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (t) => ({
    schoolStudentYearUnique: uniqueIndex(
      "algebra_placement_overrides_unique",
    ).on(t.schoolId, t.studentId, t.schoolYear),
    schoolYearIdx: index("algebra_placement_overrides_school_year_idx").on(
      t.schoolId,
      t.schoolYear,
    ),
  }),
);

export type AlgebraPlacementOverrideRow =
  typeof algebraPlacementOverridesTable.$inferSelect;
