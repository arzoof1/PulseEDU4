import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Behavior Supports — the teacher-facing "translation layer" for students
// with active behavior supports. Sits BESIDE ESE/504/ELL indicators; it is
// NOT a BIP/FBA and by design has no fields for confidential material
// (diagnoses, evals, counseling notes) — confidential content simply has
// nowhere to live on this record.
//
// Versioned as a history: exactly one CURRENT row per (school, student)
// (archived_at IS NULL, enforced by a partial unique index); every save
// archives the prior row and inserts a fresh one, so "what guidance was in
// effect in November?" is always answerable.
export const behaviorSupportsTable = pgTable(
  "behavior_supports",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    studentId: text("student_id").notNull(),
    // "Active Behavior Supports (Yes/No)" — only TRUE current rows drive
    // the purple Behavior pill on the Teacher Roster.
    isActive: boolean("is_active").notNull().default(true),
    effectiveDate: text("effective_date"),
    reviewDate: text("review_date"),
    // The five teacher-snapshot bullet lists. Total bullets capped (~15)
    // at ENTRY time by the route so editors know exactly what teachers see.
    behaviors: jsonb("behaviors").$type<string[]>().notNull().default([]),
    triggers: jsonb("triggers").$type<string[]>().notNull().default([]),
    responses: jsonb("responses").$type<string[]>().notNull().default([]),
    replacementBehaviors: jsonb("replacement_behaviors")
      .$type<string[]>()
      .notNull()
      .default([]),
    reinforcement: jsonb("reinforcement").$type<string[]>().notNull().default([]),
    updatedByStaffId: integer("updated_by_staff_id"),
    updatedByName: text("updated_by_name"),
    // NULL = current record; set = archived (history).
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    schoolIdx: index("behavior_supports_school_idx").on(t.schoolId),
    schoolStudentIdx: index("behavior_supports_school_student_idx").on(
      t.schoolId,
      t.studentId,
    ),
    // One current (non-archived) record per student per school.
    currentIdx: uniqueIndex("behavior_supports_current_idx")
      .on(t.schoolId, t.studentId)
      .where(sql`archived_at IS NULL`),
  }),
);
