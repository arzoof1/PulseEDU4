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

// PulseDNA — per-school saved "communication profile" plus an AI generation
// accountability log. Part of the Family Communication feature (gated on the
// `familyComm` license, Core-Team only).
//
// The profile is the school's externally-authored communication voice/policy
// (mission, tone, do/don't, signature). Schools paste it or upload a document
// that the client parses to TEXT before saving — the server only ever stores
// text, keeping the table light. When `enabled` is false the profile is kept
// but ignored by AI drafting.
export const pulseDnaProfilesTable = pgTable(
  "pulse_dna_profiles",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    // The communication-profile text the AI uses as background context.
    content: text("content").notNull().default(""),
    // Display name of the uploaded source file, if any (informational only).
    sourceName: text("source_name"),
    // When false, AI drafting ignores the profile (still saved for later use).
    enabled: boolean("enabled").notNull().default(true),
    updatedByStaffId: integer("updated_by_staff_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // Exactly one profile row per school (read-or-create on save).
    schoolUnique: uniqueIndex("pulse_dna_profiles_school_id_unique").on(
      t.schoolId,
    ),
  }),
);

export type PulseDnaProfileRow = typeof pulseDnaProfilesTable.$inferSelect;

// One row per AI draft generated, for accountability/audit. Persists even if
// the staffer discards the draft.
export const pulseDnaGenerationsTable = pgTable(
  "pulse_dna_generations",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    staffId: integer("staff_id").notNull(),
    // What the staffer asked for.
    outputType: text("output_type").notNull(),
    audience: text("audience").notNull(),
    tone: text("tone").notNull(),
    language: text("language").notNull().default("English"),
    // Whether the PulseDNA profile was active + folded into the prompt.
    usedPulseDna: boolean("used_pulse_dna").notNull().default(true),
    roughInput: text("rough_input").notNull(),
    output: text("output").notNull(),
    model: text("model").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    bySchool: index("pulse_dna_generations_school_created_idx").on(
      t.schoolId,
      t.createdAt,
    ),
  }),
);

export type PulseDnaGenerationRow = typeof pulseDnaGenerationsTable.$inferSelect;
