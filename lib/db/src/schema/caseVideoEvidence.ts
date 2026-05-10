import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

// Per-case catalogue of video evidence the admin has identified —
// "Cafeteria North camera, 11:42–11:46, here's the cloud link." Keyed
// to a case (not a loose interaction): video review is part of formal
// investigation, not the initial log.
//
// `cameraLabel` is intentionally free-form text rather than a foreign
// key into a managed catalog. v1 ships with a typeahead over distinct
// labels previously used by the school, which keeps the data clean
// without forcing schools to set up a camera registry up-front.
//
// Time fields are stored as TIMESTAMPTZ so a printout shows the wall
// clock the security system displayed; `timestampEnd` is nullable for
// single-frame references.
//
// Strict admin-only — every route gates on isAdminOrSuperUser. Teachers
// and parents never see this surface.
export const caseVideoEvidenceTable = pgTable(
  "case_video_evidence",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    caseId: integer("case_id").notNull(),
    cameraLabel: text("camera_label").notNull(),
    timestampStart: timestamp("timestamp_start", { withTimezone: true })
      .notNull(),
    timestampEnd: timestamp("timestamp_end", { withTimezone: true }),
    sourceUrl: text("source_url"),
    notes: text("notes"),
    loggedByStaffId: integer("logged_by_staff_id"),
    loggedByName: text("logged_by_name"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    caseIdx: index("case_video_evidence_case_idx").on(t.schoolId, t.caseId),
    schoolLabelIdx: index("case_video_evidence_school_label_idx").on(
      t.schoolId,
      t.cameraLabel,
    ),
  }),
);
export type CaseVideoEvidenceRow = typeof caseVideoEvidenceTable.$inferSelect;
