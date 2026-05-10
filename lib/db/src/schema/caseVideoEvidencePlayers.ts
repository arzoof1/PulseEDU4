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

// Per-(clip × player) edge that says "this student appears in this
// clip, with this much confidence." Lives separately from the clip
// itself so that one clip can be linked to many players, each with
// their own confidence tier — a hallway camera might show one student
// clearly committing the act and another only walking past.
//
// Confidence is a closed enum encoded as TEXT to keep migrations
// painless. The three named tiers (`confirmed` / `inferred` /
// `possible`) are intentionally categorical — numeric scores invite
// false-precision arguments. `clearedByFootage` is an orthogonal flag
// rather than a fourth tier, because exoneration is a different axis
// from implication.
//
// `reason` is required at the server when `confidence === 'confirmed'`
// and pre-filled client-side as `Viewed by {staff name}`. The whole
// edge is audited via interaction_audit_log on every mutation.
export const caseVideoEvidencePlayersTable = pgTable(
  "case_video_evidence_players",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    evidenceId: integer("evidence_id").notNull(),
    // Denormalised so per-case rollups (the network view's badge
    // summary) avoid joining back through case_video_evidence.
    caseId: integer("case_id").notNull(),
    studentId: text("student_id").notNull(),
    confidence: text("confidence").notNull(), // 'confirmed' | 'inferred' | 'possible'
    clearedByFootage: boolean("cleared_by_footage").notNull().default(false),
    reason: text("reason"),
    setByStaffId: integer("set_by_staff_id"),
    setByName: text("set_by_name"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // One link per (clip, player) within a school — re-tagging the same
    // student on the same clip should PATCH, not duplicate.
    uniq: uniqueIndex("case_vid_evidence_players_uniq").on(
      t.schoolId,
      t.evidenceId,
      t.studentId,
    ),
    perClip: index("case_vid_evidence_players_clip_idx").on(
      t.schoolId,
      t.evidenceId,
    ),
    perCase: index("case_vid_evidence_players_case_idx").on(
      t.schoolId,
      t.caseId,
    ),
  }),
);
export type CaseVideoEvidencePlayerRow =
  typeof caseVideoEvidencePlayersTable.$inferSelect;

export const VIDEO_CONFIDENCE_TIERS = ["confirmed", "inferred", "possible"] as const;
export type VideoConfidenceTier = (typeof VIDEO_CONFIDENCE_TIERS)[number];
