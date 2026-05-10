import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Cases — a named bundle of related interactions ("8th hallway arc",
// "Bus 14", etc). Cases give the Core Team a place to track the social
// situation across days. Participants are derived from the union of
// linked interactions; a case can also have its own narrative notes.
//
// `caseNumber` is sequential per school (1, 2, 3, ...) so the UI can
// display "Case #112" the same way teachers already think about it.
// (Generated server-side at insert time — see watchlist route.)
export const interactionCasesTable = pgTable(
  "interaction_cases",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    caseNumber: integer("case_number").notNull(),
    title: text("title").notNull(),
    // 'open' | 'monitoring' | 'escalated' | 'closed'
    status: text("status").notNull().default("open"),
    leadStaffId: integer("lead_staff_id"),
    leadStaffName: text("lead_staff_name").notNull().default(""),
    summary: text("summary").notNull().default(""),
    // The originating witness statement (interactions row) that triggered
    // this case. NULL is allowed because some cases are opened proactively
    // ("admin reported", "outside report") with no seeding statement.
    leadStatementId: integer("lead_statement_id"),
    openedAt: timestamp("opened_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdByStaffId: integer("created_by_staff_id"),
    createdByName: text("created_by_name").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    schoolIdx: index("interaction_cases_school_idx").on(t.schoolId),
    schoolNumberIdx: uniqueIndex(
      "interaction_cases_school_number_idx",
    ).on(t.schoolId, t.caseNumber),
  }),
);
export type InteractionCaseRow = typeof interactionCasesTable.$inferSelect;

// Free-form running notes on a case — meeting summaries, "talked to
// Marcus's mom", "moved Bus 14 seats". Append-only timeline.
export const interactionCaseNotesTable = pgTable(
  "interaction_case_notes",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    caseId: integer("case_id").notNull(),
    body: text("body").notNull(),
    authorStaffId: integer("author_staff_id"),
    authorName: text("author_name").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    caseIdx: index("interaction_case_notes_case_idx").on(t.schoolId, t.caseId),
  }),
);
export type InteractionCaseNoteRow =
  typeof interactionCaseNotesTable.$inferSelect;

export const INTERACTION_CASE_STATUSES = [
  "open",
  "monitoring",
  "escalated",
  "closed",
] as const;
export type InteractionCaseStatus =
  (typeof INTERACTION_CASE_STATUSES)[number];
