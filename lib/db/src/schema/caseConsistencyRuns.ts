import {
  pgTable,
  serial,
  text,
  integer,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

// One row per AI consistency-check execution against a case. Stores
// EVERYTHING the model saw and produced so an admin can later answer
// "why did the AI say that?" — the redacted input bundle, the raw
// output, the model name, and the prompt hash. The hash also drives
// dedupe: if two triggers fire back-to-back with identical inputs the
// runner skips the second call to save tokens.
//
// Phase 3 of the case enhancement suite. ADMIN + CORE TEAM ONLY —
// nothing in this table or its findings ever appears in a teacher,
// parent, student, or signage view. Privacy guardrail: bundle JSON is
// already redacted (Student A/B/C aliases) before insertion, so even
// a misdirected query can't leak PII.
export const caseConsistencyRunsTable = pgTable(
  "case_consistency_runs",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    caseId: integer("case_id").notNull(),
    triggeredById: integer("triggered_by_id"),
    triggeredByName: text("triggered_by_name"),
    // 'new_statement' | 'new_interaction' | 'new_video' | 'manual' | 'initial'
    triggerReason: text("trigger_reason").notNull(),
    model: text("model").notNull(),
    // SHA-256 of the canonicalised bundle JSON. Equal hashes ⇒ same
    // inputs ⇒ skip the AI call inside the debounce window.
    promptHash: text("prompt_hash").notNull(),
    inputBundleJson: jsonb("input_bundle_json").notNull(),
    rawOutputJson: jsonb("raw_output_json"),
    score: integer("score").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    // Populated when the AI call failed; the row is still inserted so
    // the failure is auditable and the debounce key advances.
    errorText: text("error_text"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    perCase: index("case_consistency_runs_case_idx").on(
      t.schoolId,
      t.caseId,
      t.createdAt,
    ),
    perHash: index("case_consistency_runs_hash_idx").on(
      t.schoolId,
      t.caseId,
      t.promptHash,
    ),
  }),
);
export type CaseConsistencyRunRow =
  typeof caseConsistencyRunsTable.$inferSelect;

export const CONSISTENCY_TRIGGER_REASONS = [
  "new_statement",
  "new_interaction",
  "new_video",
  "manual",
  "initial",
] as const;
export type ConsistencyTriggerReason =
  (typeof CONSISTENCY_TRIGGER_REASONS)[number];
