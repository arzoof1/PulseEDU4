import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Witness statements requested from students after an interaction.
// One row per (interaction, student). The hub surfaces stale ones
// (>7 days without completion) in red.
export const witnessStatementsTable = pgTable(
  "witness_statements",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    interactionId: integer("interaction_id").notNull(),
    studentId: text("student_id").notNull(),
    // 'requested' | 'reminded' | 'completed' | 'waived'
    status: text("status").notNull().default("requested"),
    requestedByStaffId: integer("requested_by_staff_id"),
    requestedByName: text("requested_by_name").notNull().default(""),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    remindedAt: timestamp("reminded_at", { withTimezone: true }),
    remindCount: integer("remind_count").notNull().default(0),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    body: text("body").notNull().default(""),
    // Per-case sequence number, assigned at the moment the owning
    // interaction is attached to a case (promote-to-case OR a PATCH
    // that sets caseId). Null while the statement's interaction is
    // still loose. Combined with the case number to form a human-
    // readable identifier admins can quote: CASE-26-27-0042-WS-03.
    // See formatWitnessStatementId() in lib/witnessStatementId.ts.
    wsSeq: integer("ws_seq"),
  },
  (t) => ({
    schoolIdx: index("witness_statements_school_idx").on(t.schoolId),
    interactionStudentIdx: uniqueIndex(
      "witness_statements_interaction_student_idx",
    ).on(t.interactionId, t.studentId),
  }),
);
export type WitnessStatementRow = typeof witnessStatementsTable.$inferSelect;
