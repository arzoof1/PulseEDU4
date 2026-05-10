import {
  pgTable,
  serial,
  text,
  integer,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

// Individual finding produced by the AI (or hand-authored by an admin
// to flag something the AI missed). Each finding cites the source rows
// it points at via `citedSourceRefs` so the UI can scroll-to and so
// the runner can compute a stable `signatureHash` for suppression-on-
// future-runs (admin dismisses a finding → its signature stops being
// re-flagged).
//
// `kind` is the analytical category. `severity` controls the score
// impact and the badge color. `source = 'ai' | 'human'` lets us count
// AI findings separately for telemetry and lets human findings persist
// across re-runs without being deleted.
//
// `dismissReason` is a closed enum so the cost-vs-quality dashboard
// can answer "of all dismissed findings, what fraction were
// false_positive vs already_verified" without parsing free text. The
// free-text `dismissNote` is the required justification (≥5 chars,
// enforced server-side) that an auditor reads to understand WHY a
// human disagreed with the AI.
//
// ADMIN + CORE TEAM ONLY. See caseConsistencyRunsTable header comment.
export const caseConsistencyFindingsTable = pgTable(
  "case_consistency_findings",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    caseId: integer("case_id").notNull(),
    // Nullable for source='human' findings (no run produced them).
    runId: integer("run_id"),
    source: text("source").notNull(), // 'ai' | 'human'
    kind: text("kind").notNull(), // 'contradiction' | 'gap' | 'corroboration'
    severity: text("severity").notNull(), // 'high' | 'med' | 'low'
    summary: text("summary").notNull(),
    detail: text("detail"),
    // Array of { kind: 'witness_statement'|'interaction'|'video_clip'|
    // 'case_note', id: number }. Stored as jsonb for flexible client-
    // side rendering; not FK-enforced on purpose so deleting a source
    // row doesn't cascade-delete audit history.
    citedSourceRefs: jsonb("cited_source_refs").notNull(),
    // Deterministic hash of (kind + sorted source refs) — the runner
    // skips re-emitting any AI finding whose signature appears on a
    // dismissed row for this case. This IS the suppression list; no
    // separate table needed.
    signatureHash: text("signature_hash").notNull(),
    status: text("status").notNull().default("open"), // 'open' | 'dismissed' | 'resolved'
    dismissedById: integer("dismissed_by_id"),
    dismissedByName: text("dismissed_by_name"),
    // 'false_positive' | 'already_verified' | 'duplicate' | 'other'
    dismissReason: text("dismiss_reason"),
    dismissNote: text("dismiss_note"),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    createdById: integer("created_by_id"),
    createdByName: text("created_by_name"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    perCaseStatus: index("case_consistency_findings_case_status_idx").on(
      t.schoolId,
      t.caseId,
      t.status,
    ),
    perSignature: index("case_consistency_findings_signature_idx").on(
      t.schoolId,
      t.caseId,
      t.signatureHash,
    ),
    perRun: index("case_consistency_findings_run_idx").on(t.runId),
  }),
);
export type CaseConsistencyFindingRow =
  typeof caseConsistencyFindingsTable.$inferSelect;

export const CONSISTENCY_FINDING_KINDS = [
  "contradiction",
  "gap",
  "corroboration",
] as const;
export type ConsistencyFindingKind =
  (typeof CONSISTENCY_FINDING_KINDS)[number];

export const CONSISTENCY_FINDING_SEVERITIES = ["high", "med", "low"] as const;
export type ConsistencyFindingSeverity =
  (typeof CONSISTENCY_FINDING_SEVERITIES)[number];

export const CONSISTENCY_FINDING_SOURCES = ["ai", "human"] as const;
export type ConsistencyFindingSource =
  (typeof CONSISTENCY_FINDING_SOURCES)[number];

export const CONSISTENCY_FINDING_STATUSES = [
  "open",
  "dismissed",
  "resolved",
] as const;
export type ConsistencyFindingStatus =
  (typeof CONSISTENCY_FINDING_STATUSES)[number];

export const CONSISTENCY_DISMISS_REASONS = [
  "false_positive",
  "already_verified",
  "duplicate",
  "other",
] as const;
export type ConsistencyDismissReason =
  (typeof CONSISTENCY_DISMISS_REASONS)[number];
