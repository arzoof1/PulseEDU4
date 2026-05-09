import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Teacher-filed "do not pair these two students" recommendations, scoped
// to a single class section so a teacher only ever flags pairs they have
// actually observed together. Aggregated across the whole school for the
// scheduling team (Counselors, Behavior Specialist, Dean, School
// Psychologist, MTSS Coordinator, Admin) so they can avoid putting
// repeatedly-flagged students together when building next year's master
// schedule (or making a mid-year section change).
//
// Storage rules:
//   - studentAId is always the lexicographically smaller student id.
//     This deduplicates (A,B) and (B,A) so the unique index works.
//   - reasonTagIds is a Postgres int[] of separation_reason_tags.id
//     entries. Empty array = teacher only filled in the free-text note,
//     or flagged with no reason at all.
//   - reasonNote is the optional free-text override; tags handle the
//     common cases, notes capture the unusual ones.
//   - schoolYear is an opaque string ("2025-2026") so the same pair can
//     be re-flagged in subsequent years without colliding.
//
// Visibility rules (enforced in the route layer, not the schema):
//   - The reporter_staff_id teacher only ever sees their own flags
//     filtered to one of their own class_section_ids. They never see
//     anyone else's flags.
//   - The aggregate / drill-down endpoints are gated to a fixed set of
//     scheduling-team roles.
export const studentSeparationsTable = pgTable(
  "student_separations",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    classSectionId: integer("class_section_id").notNull(),
    reporterStaffId: integer("reporter_staff_id").notNull(),
    studentAId: text("student_a_id").notNull(),
    studentBId: text("student_b_id").notNull(),
    schoolYear: text("school_year").notNull(),
    reasonTagIds: integer("reason_tag_ids").array().notNull().default([]),
    reasonNote: text("reason_note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pairUnique: uniqueIndex("student_separations_pair_unique").on(
      t.classSectionId,
      t.reporterStaffId,
      t.studentAId,
      t.studentBId,
      t.schoolYear,
    ),
  }),
);

export type StudentSeparationRow =
  typeof studentSeparationsTable.$inferSelect;
