import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Watchlist interactions — every logged "thing that happened between students"
// that the Core Team wants to keep eyes on. Distinct from disciplinary
// records (ISS/OSS) and from supportNotes: this is the lighter layer of
// peripheral-presence + rumor + low-grade incidents that compound into a
// case if you're paying attention.
//
// One row per incident. Participants live in `interaction_participants`
// (many students per interaction, each with a role). An interaction may
// optionally be linked to an `interaction_cases` row; "loose" interactions
// (caseId IS NULL) show up in the hub's recent feed waiting to be linked.
export const interactionsTable = pgTable(
  "interactions",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    // School-local YYYY-MM-DD for fast date filtering — matches how the
    // rest of the codebase dodges TZ pitfalls.
    occurredDate: text("occurred_date").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // 'fight' | 'verbal' | 'rumor' | 'property' | 'class_disruption' |
    // 'peripheral_note' | 'threat' | 'other'
    kind: text("kind").notNull(),
    // 1 = note, 2 = minor, 3 = significant, 4 = major.
    severity: integer("severity").notNull().default(1),
    location: text("location").notNull().default(""),
    // Short headline (≤ 280 chars). Required.
    summary: text("summary").notNull(),
    // Optional longer narrative.
    detail: text("detail").notNull().default(""),
    // Optional link to a case. NULL = "loose" interaction.
    caseId: integer("case_id"),
    loggedByStaffId: integer("logged_by_staff_id"),
    loggedByName: text("logged_by_name").notNull().default(""),
    // 'open' | 'resolved' | 'dismissed'. Dismissed = logged in error.
    status: text("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    schoolIdx: index("interactions_school_idx").on(t.schoolId),
    schoolDateIdx: index("interactions_school_date_idx").on(
      t.schoolId,
      t.occurredDate,
    ),
    schoolCaseIdx: index("interactions_school_case_idx").on(
      t.schoolId,
      t.caseId,
    ),
  }),
);
export type InteractionRow = typeof interactionsTable.$inferSelect;

// Many-to-many between interactions and students, with a role. The role
// drives the network coloring and most of the alert rules ("always
// peripheral", "co-occurrence", etc).
export const interactionParticipantsTable = pgTable(
  "interaction_participants",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    interactionId: integer("interaction_id").notNull(),
    // students.student_id is text — same convention as everywhere else.
    studentId: text("student_id").notNull(),
    // 'direct' | 'target' | 'instigator' | 'rumor' | 'witness' |
    // 'peripheral' | 'deescalator'
    role: text("role").notNull(),
    notes: text("notes").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    schoolIdx: index("interaction_participants_school_idx").on(t.schoolId),
    interactionStudentIdx: uniqueIndex(
      "interaction_participants_interaction_student_idx",
    ).on(t.interactionId, t.studentId),
    schoolStudentIdx: index(
      "interaction_participants_school_student_idx",
    ).on(t.schoolId, t.studentId),
  }),
);
export type InteractionParticipantRow =
  typeof interactionParticipantsTable.$inferSelect;

// Optional structured payload for participant notes (eg, witnessed-from
// vantage, distance, etc). Stored as JSONB so we can extend without
// migrations.
export type InteractionParticipantPayload = {
  vantage?: string;
  distance?: "close" | "near" | "far";
  [k: string]: unknown;
};

// Convenience: schemas can opt in to attach a JSONB payload column later
// via ALTER TABLE without touching this file's structural exports.
export const INTERACTION_ROLES = [
  "direct",
  "target",
  "instigator",
  "rumor",
  "witness",
  "peripheral",
  "deescalator",
] as const;
export type InteractionRole = (typeof INTERACTION_ROLES)[number];

export const INTERACTION_KINDS = [
  "fight",
  "verbal",
  "rumor",
  "property",
  "class_disruption",
  "peripheral_note",
  "threat",
  "other",
] as const;
export type InteractionKind = (typeof INTERACTION_KINDS)[number];

// Re-export `jsonb` so the route file can typecheck against this column
// shape without re-declaring it (kept here defensively in case future
// migrations add a `metadata jsonb` column to interactions).
export type _InteractionsJsonb = ReturnType<typeof jsonb>;
