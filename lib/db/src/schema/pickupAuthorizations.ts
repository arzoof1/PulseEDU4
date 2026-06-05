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
// student_pickup_authorizations — per-(student, parent/guardian) pickup numbers
//
// A student can have multiple authorizations (Mom, Dad, grandparent, after-care
// driver). Each authorization owns ONE unique pickup_number that prints onto a
// hanger or sticker for that adult's car. When the curb monitor types a number,
// we look up THIS row to find the keying parent's other authorized students
// (siblings) — split-custody is handled by giving each parent their own row
// per student rather than sharing.
//
// `parent_id` is nullable: front office can issue a number to a guardian who
// hasn't onboarded into the parent portal yet. When null, `guardian_label` is
// the only display name we have.
//
// `restricted_from = true` means "the holder of this number is NOT permitted
// to pick up this student" — used for court-order / no-contact situations.
// We keep the row (rather than deleting) so the curb page can display a red
// banner and write a `restricted_attempt` audit row.
// =============================================================================
export const studentPickupAuthorizationsTable = pgTable(
  "student_pickup_authorizations",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    // students.id (integer PK), not the string district code.
    studentId: integer("student_id").notNull(),
    // Optional link to a parent_portal account; null when issued to a
    // guardian who has no portal account.
    parentId: integer("parent_id"),
    // Display label for the curb confirmation card and the audit log
    // ("Mom", "Dad", "Aunt Sarah"). Required even when parentId is set
    // because parents.displayName is the parent's chosen handle, which
    // may not be the relationship label the school wants on the screen.
    guardianLabel: text("guardian_label").notNull(),
    // 4-digit number printed on the hanger. Unique per (school, active=true)
    // — see the partial unique index below. Re-issued when an authorization
    // is deactivated.
    pickupNumber: text("pickup_number").notNull(),
    restrictedFrom: boolean("restricted_from").notNull().default(false),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
  },
  (t) => ({
    // Active number must be unique per school. Inactive rows can collide
    // (a re-issued number won't conflict with a retired one). Drizzle
    // doesn't model partial indexes natively in the type-level helper;
    // the migration in seed.ts creates the partial index explicitly.
    numberPerSchool: index("pickup_auth_number_per_school").on(
      t.schoolId,
      t.pickupNumber,
    ),
    byStudent: index("pickup_auth_by_student").on(t.studentId),
    byParent: index("pickup_auth_by_parent").on(t.parentId),
  }),
);

export type StudentPickupAuthorizationRow =
  typeof studentPickupAuthorizationsTable.$inferSelect;
