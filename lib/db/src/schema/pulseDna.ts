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

// PulseDNA videos — a recorded "principal-to-families" clip captured in the
// in-app Recording Studio. Only the ACCEPTED take is ever stored (retakes are
// discarded in the browser before upload). The original WebM is uploaded, then
// the server transcodes it to a broadly-playable MP4 (H.264/AAC, +faststart)
// and extracts an audio-only MP3. The teleprompter script is kept on the row
// as a permanent transcript even after the media files purge.
//
// TWO-TIER RETENTION (the media files only — the row + script persist):
//   - SENT to a family message (sentAt set) → kept for the school year, purged
//     at year rollover (cron compares the school-year label of sentAt vs now).
//   - NOT sent (library/draft) → purged at `purgeAfter` (createdAt + 14 days),
//     with ONE +7-day postpone (retentionPostponed). Hard stop ~21 days.
// On purge: media object keys are nulled, files deleted from storage, status
// flips to "purged"; the row stays for the audit/transcript.
export const pulseDnaVideosTable = pgTable(
  "pulse_dna_videos",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    createdByStaffId: integer("created_by_staff_id").notNull(),
    // processing | ready | failed | purged
    status: text("status").notNull().default("processing"),
    title: text("title"),
    // The teleprompter script, retained permanently as a transcript.
    script: text("script").notNull().default(""),
    durationSec: integer("duration_sec"),
    // Uploaded source (WebM) + server-derived MP4 / MP3. Nulled on purge.
    originalObjectKey: text("original_object_key"),
    mp4ObjectKey: text("mp4_object_key"),
    audioObjectKey: text("audio_object_key"),
    // Total stored bytes (original + derived) for a rough library footprint.
    sizeBytes: integer("size_bytes"),
    // Populated when transcode fails (status="failed").
    errorReason: text("error_reason"),
    // Set when the video is attached to a SENT family message → school-year
    // retention. Null = unsent (14-day library retention).
    sentAt: timestamp("sent_at", { withTimezone: true }),
    // One-time +7-day postpone for an unsent video before its 14-day purge.
    retentionPostponed: boolean("retention_postponed").notNull().default(false),
    // When an unsent video becomes eligible for purge (createdAt + 14d, +7 if
    // postponed). Ignored once sentAt is set (school-year rule takes over).
    purgeAfter: timestamp("purge_after", { withTimezone: true }),
    purgedAt: timestamp("purged_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    bySchool: index("pulse_dna_videos_school_created_idx").on(
      t.schoolId,
      t.createdAt,
    ),
  }),
);

export type PulseDnaVideoRow = typeof pulseDnaVideosTable.$inferSelect;
