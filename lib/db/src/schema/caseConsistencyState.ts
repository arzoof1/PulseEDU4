import {
  pgTable,
  text,
  integer,
  timestamp,
  primaryKey,
} from "drizzle-orm/pg-core";

// Per-case denormalised snapshot of the most recent consistency run.
// Exists purely to make the header pill on every case detail page a
// single cheap read instead of an aggregate over runs + findings. The
// authoritative data lives in caseConsistencyRunsTable +
// caseConsistencyFindingsTable; this row is upserted at the end of
// every run inside the same transaction.
//
// PK is composite (schoolId, caseId) so a case can only ever have one
// state row. ADMIN + CORE TEAM ONLY surface.
export const caseConsistencyStateTable = pgTable(
  "case_consistency_state",
  {
    schoolId: integer("school_id").notNull(),
    caseId: integer("case_id").notNull(),
    latestRunId: integer("latest_run_id"),
    score: integer("score").notNull().default(100),
    openFindingCount: integer("open_finding_count").notNull().default(0),
    highSeverityCount: integer("high_severity_count").notNull().default(0),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    // Soft trigger throttle column — last time the runner actually
    // attempted a call (success or failure). Used by the per-case
    // 60s debounce so we don't have to scan the runs table on every
    // hook fire.
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.schoolId, t.caseId] }),
  }),
);
export type CaseConsistencyStateRow =
  typeof caseConsistencyStateTable.$inferSelect;

// Score thresholds shared by server (state row writer) and client
// (pill color picker) so they can never drift.
export const CONSISTENCY_SCORE_THRESHOLDS = {
  green: 80, // ≥80 → green "Consistent"
  amber: 50, // 50..79 → amber "Mixed"; <50 → red "Conflicts"
} as const;
