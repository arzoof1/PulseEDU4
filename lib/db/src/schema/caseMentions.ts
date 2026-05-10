import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

// Generic "this text mentions student X" index for any free-text field on
// a discipline case. The body of the source field still owns the canonical
// chip token (`@[Display Name|STUDENTID]`); this table is a derived,
// re-buildable index used for fast queries like "every case that named
// Mary Johnson" without grepping prose.
//
// `sourceKind` keeps the table generic so Phase 2 (video evidence
// description) and Phase 3 (case notes / consistency check inputs) can
// reuse the same infrastructure without a migration.
export const caseMentionsTable = pgTable(
  "case_mentions",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    // 'witness_statement' | 'case_note' | 'video_evidence_note'
    sourceKind: text("source_kind").notNull(),
    sourceId: integer("source_id").notNull(),
    // The owning case (nullable for sources not yet attached to one — but
    // every Phase 1 source is). Stored denormalized so case-level queries
    // don't have to join through witness_statements → interactions.
    caseId: integer("case_id"),
    studentId: text("student_id").notNull(),
    // Snapshot at insert time so a later name change in the SIS doesn't
    // rewrite history on a witness statement.
    displayNameAtTime: text("display_name_at_time").notNull(),
    // Character offset of the chip token within the source body. Used by
    // the renderer to show the mention's neighborhood in roll-up views.
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    schoolIdx: index("case_mentions_school_idx").on(t.schoolId),
    sourceIdx: index("case_mentions_source_idx").on(t.sourceKind, t.sourceId),
    studentIdx: index("case_mentions_student_idx").on(t.schoolId, t.studentId),
    caseIdx: index("case_mentions_case_idx").on(t.schoolId, t.caseId),
  }),
);
export type CaseMentionRow = typeof caseMentionsTable.$inferSelect;
