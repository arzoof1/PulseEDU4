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
    // Links an auto-issued number to the SIS emergency-contact slot (1-4)
    // it was generated from, so the school-wide bulk-assign can stay
    // idempotent per (student, contact). NULL for manually-issued numbers
    // and for the single "Family" fallback issued to students with no
    // emergency contacts on file.
    contactSlot: integer("contact_slot"),
    // ---- Student-anchored alphanumeric scheme (redesign) ----------------
    // Each STUDENT owns ONE base number (e.g. "1001"); each authorized adult
    // on that student gets a letter suffix (A, B, C ...). The full code the
    // family reads/scans is base+letter (e.g. "1001C"), stored in
    // pickupNumber below so the existing lookup + partial-unique index keep
    // working unchanged. baseNumber is shared across all of a student's adult
    // rows; letter is the per-adult suffix.
    //
    // Legacy rows issued before the redesign have a bare 4-digit pickupNumber
    // and NULL base/letter/adultKey — the curb lookup falls back to the old
    // parentId-based sibling grouping for those until a school runs the
    // start-of-year cutover (re-run of bulk-assign), so nothing breaks.
    baseNumber: text("base_number"),
    letter: text("letter"),
    // Groups one real adult's authorizations across siblings so typing ONE
    // adult's code resolves ALL their kids. Portal parents → `p:<parentId>`;
    // non-portal SIS contacts → `c:<normalized name>|<normalized relationship>`.
    // NULL on legacy rows (see above).
    adultKey: text("adult_key"),
    // Full code printed on the hanger: base+letter for redesigned rows,
    // a bare 4-digit number for legacy rows. Unique per (school, active=true)
    // — see the partial unique index below. Re-issued when an authorization
    // is deactivated.
    pickupNumber: text("pickup_number").notNull(),
    restrictedFrom: boolean("restricted_from").notNull().default(false),
    active: boolean("active").notNull().default(true),
    // ---- Front-office manual override layer -----------------------------
    // RosterOne (via ClassLink) is the system of record: the bulk-assign /
    // SIS sync derives most rows from student_emergency_contacts. In edge
    // cases the front office must override (add an adult RosterOne doesn't
    // have yet, block a guardian on a same-day custody change, fix a label).
    //
    // `source` records HOW the row came to exist:
    //   - sis    — derived from an emergency contact by bulk-assign (default).
    //   - portal — issued to a parent-portal account.
    //   - manual — created by hand at the front office.
    // A row is SYNC-PROTECTED (bulk-assign must never rewrite/deactivate it)
    // when source = 'manual' OR overrideReason IS NOT NULL (the office has
    // deliberately touched an SIS-derived row). This is how "office wins
    // until manually cleared" is enforced.
    source: text("source").notNull().default("sis"),
    // Required free-text justification captured whenever the office creates
    // or edits an override. Mirrors the curb `restricted_override`
    // justification discipline (>= 5 chars). Stored on the row (not just the
    // audit log) so the reason is visible at a glance next to the tag.
    overrideReason: text("override_reason"),
    // staff.id of the office user who set the override, and when.
    overrideBy: integer("override_by"),
    overrideAt: timestamp("override_at", { withTimezone: true }),
    // Temporary overrides carry an expiry; permanent overrides leave it NULL.
    // The curb lookup ignores rows past expiry even before the sweep retires
    // them, so an expired temporary tag stops working immediately.
    expiresAt: timestamp("expires_at", { withTimezone: true }),
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
    // Curb lookup resolves an adult's code → all their kids by adultKey.
    byAdultKey: index("pickup_auth_by_adult_key").on(t.schoolId, t.adultKey),
  }),
);

export type StudentPickupAuthorizationRow =
  typeof studentPickupAuthorizationsTable.$inferSelect;
