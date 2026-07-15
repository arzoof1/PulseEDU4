import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { encryptedText } from "./_encrypted";

// Cases — a named bundle of related interactions ("8th hallway arc",
// "Bus 14", etc). Cases give the Core Team a place to track the social
// situation across days. Participants are derived from the union of
// linked interactions; a case can also have its own narrative notes.
//
// `caseNumber` is sequential per (school, schoolYearLabel) so the UI
// can display "Case 26-27-0042" — the 42nd case opened in the 2026-27
// school year. The composite unique index `(school, year, number)`
// enforces that. Both fields are generated server-side at insert
// time from `openedAt` (US convention: school year runs July → June).
// See watchlist route.
export const interactionCasesTable = pgTable(
  "interaction_cases",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    caseNumber: integer("case_number").notNull(),
    // "26-27", "27-28", … — derived from openedAt at create time.
    schoolYearLabel: text("school_year_label").notNull(),
    title: encryptedText("title").notNull(),
    // 'open' | 'monitoring' | 'escalated' | 'closed'
    status: text("status").notNull().default("open"),
    leadStaffId: integer("lead_staff_id"),
    leadStaffName: text("lead_staff_name").notNull().default(""),
    summary: encryptedText("summary").notNull().default(""),
    // The originating witness statement (interactions row) that triggered
    // this case. NULL is allowed because some cases are opened proactively
    // ("admin reported", "outside report") with no seeding statement.
    leadStatementId: integer("lead_statement_id"),
    openedAt: timestamp("opened_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    // Closure metadata — set when the case moves to status='closed' via
    // the dedicated /close endpoint. `outcomeCode` references
    // `case_outcome_types.code` (per-school catalog). Closing a case
    // requires both an outcomeCode and (for the 'other' outcome or any
    // outcome the catalog marks "note required") an outcomeNote. Reopening
    // does NOT clear these — they are preserved as the historical record
    // of the previous closure cycle.
    outcomeCode: text("outcome_code"),
    outcomeNote: encryptedText("outcome_note").notNull().default(""),
    closedByStaffId: integer("closed_by_staff_id"),
    closedByName: text("closed_by_name").notNull().default(""),
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
    // Composite unique on (school, year, number). Replaces the old
    // (school, number) unique — see ensureWatchlistSchema in seed.ts
    // for the migration that drops the old index and re-sequences
    // existing rows per year.
    schoolYearNumberIdx: uniqueIndex(
      "interaction_cases_school_year_number_idx",
    ).on(t.schoolId, t.schoolYearLabel, t.caseNumber),
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
    body: encryptedText("body").notNull(),
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
