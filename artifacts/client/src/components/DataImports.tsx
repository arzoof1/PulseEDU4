import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, DragEvent, ReactNode } from "react";
import * as XLSX from "xlsx";
import { authFetch } from "../lib/authToken";
import { HowToUseHelp, HowToSection, RoleSection, howtoListStyle } from "./HowToUseHelp";

// ---------------------------------------------------------------------------
// Data Imports — Phase 3 first importer (assessments). Wraps the
// /api/data-imports/* endpoints with a 3-step flow:
//
//   1. Upload  → drag-drop CSV, server returns preview + suggested mapping
//   2. Map     → admin reviews/overrides the column mapping, sees row counts
//   3. Commit  → server inserts rows + history entry
//
// A "History" tab lists past imports with rollback. We deliberately keep
// every step self-contained so the next importer (rosters, attendance) can
// reuse the same component by parameterizing `kind` + the target-field
// dictionary.
// ---------------------------------------------------------------------------

export type Kind =
  | "assessments"
  | "rosters"
  | "behavior"
  | "fast_scores"
  | "fast_prior_year"
  | "bq_l25"
  | "fast_florida"
  | "gradebook"
  | "points_migration";
type Scope = "school" | "district";

type PreviewResponse = {
  headers: string[];
  autoMapping: Record<string, string>;
  suggestedMapping: Record<string, string>;
  unmappedCsvColumns: string[];
  totalRows: number;
  validRows: number;
  errorRows: number;
  sampleRows: Array<{
    studentId: string;
    assessmentName: string;
    score: number | null;
    scoreLevel: string | null;
    administeredAt: string;
    source: string | null;
    // District scope only — present when the row was routed by school_code.
    schoolId?: number;
    schoolCode?: string;
  }>;
  errors: Array<{ row: number; message: string }>;
  readyToCommit: boolean;
  // FAST Florida only — count of per-benchmark item rows that will be
  // written to student_fast_item_responses. Surfaced as a "Will import
  // items" stat on the preview step so admins see the data volume
  // before commit.
  totalItems?: number;
  // District-scope preview only.
  perSchool?: Array<{ schoolId: number; schoolName: string; rows: number }>;
  districtSchoolCount?: number;
  // points_migration only — local_sis_id match summary from previewExtras.
  pointsMigration?: {
    matched: number;
    unmatched: number;
    totalPoints: number;
  };
  // Roster-scope preview only. Present when one or more CSV rows have
  // a house_name we couldn't match to this school's houses. Non-blocking
  // — those rows still commit, falling back to the smallest-house
  // rotation.
  unrecognizedHouseNames?: {
    rowCount: number;
    distinctCount: number;
    // Each sample is the unrecognized CSV value plus, when a configured
    // house name is within a small edit distance, a "did you mean"
    // suggestion (e.g. "Pheonix" → "Phoenix").
    samples: Array<{ value: string; suggestion?: string }>;
    // 'fallback' (default) → row commits with smallest-house rotation.
    // 'strict' → row is rejected at commit (school_settings
    // .strict_house_name_match = true).
    policy?: "strict" | "fallback";
  };
};

type ImportTemplate = {
  id: number;
  schoolId: number | null;
  districtId: number | null;
  kind: string;
  name: string;
  mapping: Record<string, string>;
  createdBy: number;
  createdAt: string;
  scope: "school" | "district";
};

type ImportJob = {
  id: number;
  schoolId: number | null;
  districtId: number | null;
  kind: string;
  filename: string;
  uploadedBy: number;
  uploadedAt: string;
  status: string;
  totalRows: number;
  successRows: number;
  errorRows: number;
  errorLog: Array<{
    row: number;
    message: string;
    raw?: Record<string, string>;
    code?: string;
    bucket?: string;
  }>;
  mapping: Record<string, string>;
  committedAt: string | null;
  rolledBackAt: string | null;
};

// Target fields the importer recognizes (mirror of HEADER_SYNONYMS in the
// route file). Marked required if the server rejects the mapping without
// them. The `school_code` target is only required in district scope —
// see `assessmentTargetsFor()` below.
type TargetDef = { value: string; label: string; required: boolean };

const ASSESSMENT_TARGETS_BASE: TargetDef[] = [
  { value: "student_id", label: "Student ID (SIS number)", required: true },
  { value: "assessment_name", label: "Assessment name", required: true },
  { value: "administered_at", label: "Administered date", required: true },
  { value: "score", label: "Score (numeric)", required: false },
  { value: "score_level", label: "Score level / band", required: false },
  { value: "source", label: "Source / vendor", required: false },
];

const SCHOOL_CODE_TARGET: TargetDef = {
  value: "school_code",
  label: "School code (state code or school ID)",
  required: true,
};

function assessmentTargetsFor(scope: Scope): TargetDef[] {
  return scope === "district"
    ? [...ASSESSMENT_TARGETS_BASE, SCHOOL_CODE_TARGET]
    : ASSESSMENT_TARGETS_BASE;
}

// Rosters import targets — write to the students table. school_code isn't
// supported (rosters import is school-scope only).
const ROSTER_TARGETS: TargetDef[] = [
  { value: "student_id", label: "Student ID (SIS number)", required: true },
  { value: "first_name", label: "First name", required: true },
  { value: "last_name", label: "Last name", required: true },
  { value: "grade", label: "Grade (0-12, K accepted)", required: true },
  { value: "parent_name", label: "Parent / guardian name", required: false },
  { value: "parent_email", label: "Parent / guardian email", required: false },
  { value: "parent_phone", label: "Parent / guardian phone", required: false },
];

// Behavior import targets — write to the support_notes table.
const BEHAVIOR_TARGETS: TargetDef[] = [
  { value: "student_id", label: "Student ID (SIS number)", required: true },
  { value: "note_text", label: "Description / narrative", required: true },
  { value: "note_type", label: "Category (defaults to 'concern')", required: false },
  { value: "staff_name", label: "Reported by", required: false },
  { value: "created_at", label: "Date / timestamp", required: false },
];

// FAST scores import targets — write to the student_fast_scores table.
// Mirror of FAST_SCORES_CONFIG.validTargets in the route file. Composite
// key is (student_id, subject); PMs and prior-year are optional so a
// partial-quarter upload (just PM1) still works.
const FAST_SCORES_TARGETS: TargetDef[] = [
  { value: "student_id", label: "Student ID (SIS number)", required: true },
  { value: "subject", label: "Subject (ela/reading or math)", required: true },
  { value: "pm1", label: "PM1 / fall scale score", required: false },
  { value: "pm2", label: "PM2 / winter scale score", required: false },
  { value: "pm3", label: "PM3 / spring scale score", required: false },
  { value: "prior_year_score", label: "Prior-year final scale score", required: false },
  { value: "prior_year_bq", label: "Prior-year bottom-quartile flag", required: false },
];

// FAST prior-year-only import targets. Mirror of
// FAST_PRIOR_YEAR_CONFIG.validTargets — narrower than FAST_SCORES_TARGETS
// on purpose so the column-mapping dropdowns can't surface PM1/2/3 here.
// Composite key still (student_id, subject) so the importer upserts in
// place against the same row the FAST scores importer would create.
const FAST_PRIOR_YEAR_TARGETS: TargetDef[] = [
  { value: "student_id", label: "Student ID (SIS number)", required: true },
  { value: "subject", label: "Subject (ela/reading or math)", required: true },
  { value: "prior_year_score", label: "Prior-year final scale score (last year's PM3)", required: true },
  { value: "prior_year_bq", label: "Prior-year bottom-quartile flag", required: false },
];

// BQ / Lower-25 (L25) full-replace targets. Mirror of BQ_L25_CONFIG
// .validTargets. Only (student_id, subject) are required — the BQ flag
// column is optional (presence in the file == bottom-quartile). This is a
// FULL REPLACE per subject: any current-year student not listed for that
// subject gets un-flagged.
const BQ_L25_TARGETS: TargetDef[] = [
  { value: "student_id", label: "Student ID (SIS number)", required: true },
  { value: "subject", label: "Subject (ela/reading, math, algebra1, geometry)", required: true },
  { value: "prior_year_bq", label: "Bottom-quartile / L25 flag (Y/N — optional)", required: false },
];

// PBIS point-balance migration targets — match by local_sis_id (the only
// id a foreign PBIS vendor exports) and a current point balance. Resolved
// to the canonical student row server-side; FLEID never leaves the server.
const POINTS_MIGRATION_TARGETS: TargetDef[] = [
  { value: "local_sis_id", label: "Local SIS ID", required: true },
  { value: "points", label: "Point balance", required: true },
];

// Per-kind metadata. Each kind exposes a label, the targets dictionary
// (a function so assessments can vary by scope), a flag for whether
// district-scope is supported, and rich setup directions surfaced in
// the directions panel above the upload step.
type KindColumnDoc = {
  // Internal target key (matches the server's validTargets / TargetDef.value).
  target: string;
  // Human label as shown in the directions table.
  label: string;
  required: boolean;
  // Header names the auto-mapper will accept (matches headerSynonyms in
  // the server config). Surfaced so admins can adjust their export
  // template once instead of fighting the UI mapping every upload.
  acceptedHeaders: string[];
  // Optional formatting hint (e.g. "integer 100-700", "Y/N").
  notes?: string;
};

type KindDef = {
  label: string;
  targetsFor: (scope: Scope) => TargetDef[];
  supportsDistrict: boolean;
  // One-line summary shown in the kind picker row.
  helpText: string;
  // Multi-line description rendered at the top of the directions panel.
  description: string;
  // Per-column documentation rendered as a table inside the directions
  // panel. Required columns are listed first; optional columns follow.
  columns: KindColumnDoc[];
  // A short, copy-pasteable CSV (header row + 1-2 data rows) that the
  // admin can use as a template. Rendered inside a <pre>.
  sampleCsv: string;
  // Free-form list of caveats / behavior notes shown below the table.
  notes: string[];
};

const KIND_DEFS: Record<Kind, KindDef> = {
  assessments: {
    label: "Assessments",
    targetsFor: assessmentTargetsFor,
    supportsDistrict: true,
    helpText:
      "Per-assessment scores (FAST PM, iReady AP, SCI Benchmark, MAP, etc.). One row per (student, assessment, date).",
    description:
      "Generic assessment scores. Each row is one (student, assessment name, administered date). The starter file below shows the expected naming for FAST PM1/PM2/PM3, iReady AP1/AP2/AP3, and SCI Benchmark 1/2/3 — plus any other vendor (MAP, STAR, etc.) is supported as long as you put the assessment's full name in the assessment_name column. Re-uploading the same (student, test name, date) UPDATES the existing record in place rather than creating a duplicate — safe to re-run after corrections. Optional columns (score, score_level, source) left blank in a later upload PRESERVE the existing value rather than wiping it, so a partial follow-up upload can never erase data already recorded. NOTE: FAST PM scores can also be imported through the dedicated FAST Scores importer below, which wires PM1/PM2/PM3 directly into the heartbeat dashboard cut-score chart. Use that one for the headline-FAST scores; use this generic importer for iReady, SCI, MAP, and any other test (or for FAST scores you only want recorded as raw history).",
    columns: [
      {
        target: "student_id",
        label: "Student ID",
        required: true,
        acceptedHeaders: ["student_id", "student_number", "sis_id", "id", "studentid"],
        notes: "Must already exist in the roster.",
      },
      {
        target: "assessment_name",
        label: "Assessment name",
        required: true,
        acceptedHeaders: ["assessment_name", "assessment", "test", "test_name", "exam"],
        notes:
          "Use the vendor's actual period naming. Recognized examples: 'FAST ELA PM1', 'FAST ELA PM2', 'FAST ELA PM3', 'FAST Math PM1', 'FAST Math PM2', 'FAST Math PM3', 'iReady Reading AP1', 'iReady Reading AP2', 'iReady Reading AP3', 'iReady Math AP1', 'iReady Math AP2', 'iReady Math AP3', 'SCI Benchmark 1', 'SCI Benchmark 2', 'SCI Benchmark 3'. Any other test name (MAP, STAR, etc.) also imports — just write it out.",
      },
      {
        target: "administered_at",
        label: "Administered date",
        required: true,
        acceptedHeaders: ["administered_at", "date", "test_date", "administered_date", "taken_at"],
        notes: "ISO date or M/D/YYYY.",
      },
      {
        target: "score",
        label: "Score",
        required: false,
        acceptedHeaders: ["score", "scale_score", "raw_score", "result"],
        notes: "Integer or decimal.",
      },
      {
        target: "score_level",
        label: "Score level / band",
        required: false,
        acceptedHeaders: ["score_level", "level", "band", "tier", "performance_level"],
        notes: "e.g. 'Level 3', 'On Track', 'Below Benchmark'.",
      },
      {
        target: "source",
        label: "Source / vendor",
        required: false,
        acceptedHeaders: ["source", "vendor", "provider", "system"],
        notes: "e.g. 'FAST', 'iReady', 'District SCI'.",
      },
      {
        target: "school_code",
        label: "School code (district scope only)",
        required: false,
        acceptedHeaders: ["school_code", "school", "school_id", "site_code", "campus"],
        notes: "Required when uploading district-wide so each row routes to the right school.",
      },
    ],
    // Starter file: one row for each named period of each recognized
    // assessment family so admins can copy/paste into their own export
    // and trust the naming. Two students included so it also doubles as
    // a multi-row example.
    sampleCsv:
      "student_id,assessment_name,administered_at,score,score_level,source\n" +
      "10234,FAST ELA PM1,2025-09-15,305,Level 2,FAST\n" +
      "10234,FAST ELA PM2,2026-01-15,318,Level 3,FAST\n" +
      "10234,FAST ELA PM3,2026-04-15,330,Level 3,FAST\n" +
      "10234,FAST Math PM1,2025-09-16,290,Level 2,FAST\n" +
      "10234,FAST Math PM2,2026-01-16,302,Level 2,FAST\n" +
      "10234,FAST Math PM3,2026-04-16,315,Level 3,FAST\n" +
      "10234,iReady Reading AP1,2025-09-20,498,Level 2,iReady\n" +
      "10234,iReady Reading AP2,2026-01-20,512,Level 3,iReady\n" +
      "10234,iReady Reading AP3,2026-04-20,524,Level 3,iReady\n" +
      "10234,iReady Math AP1,2025-09-21,485,Level 2,iReady\n" +
      "10234,iReady Math AP2,2026-01-21,497,Level 2,iReady\n" +
      "10234,iReady Math AP3,2026-04-21,510,Level 3,iReady\n" +
      "10234,SCI Benchmark 1,2025-10-01,72,On Track,District SCI\n" +
      "10234,SCI Benchmark 2,2026-01-08,78,On Track,District SCI\n" +
      "10234,SCI Benchmark 3,2026-04-08,82,On Track,District SCI\n" +
      "10235,FAST ELA PM2,2026-01-15,295,Level 2,FAST\n" +
      "10235,iReady Reading AP2,2026-01-20,468,Level 1,iReady\n" +
      "10235,SCI Benchmark 2,2026-01-08,61,Approaching,District SCI\n",
    notes: [
      "True upsert: re-uploading the same (student, test name, date) row updates the existing record in place — safe to re-run after corrections.",
      "Optional columns (score, score_level, source) left blank in a re-upload preserve the existing value — partial follow-up uploads cannot wipe data already recorded.",
      "Rows with an unknown student_id are reported as errors and not committed.",
      "To remove a whole upload, use History → Roll back: it deletes every row whose latest update came from that import job.",
      "Recognized assessment families: FAST PM1/PM2/PM3 (ELA + Math), iReady AP1/AP2/AP3 (Reading + Math), SCI Benchmark 1/2/3. Other vendors (MAP, STAR, district-built tests) also import — use the vendor's official name for assessment_name and the importer keeps it intact.",
    ],
  },
  rosters: {
    label: "Rosters",
    targetsFor: () => ROSTER_TARGETS,
    supportsDistrict: false,
    helpText:
      "One row per student. Existing student IDs are skipped (counted as warnings) — the importer will not overwrite.",
    description:
      "One row per student. Use this to add new students to the school's roster. Students whose student_id already exists are skipped (you'll see them in the warnings list) — this importer never overwrites an existing roster row. To correct demographics on an existing student, use Settings → Students or the inline editor on the student profile.",
    columns: [
      {
        target: "student_id",
        label: "Student ID (SIS number)",
        required: true,
        acceptedHeaders: ["student_id", "student_number", "sis_id", "id", "studentid"],
        notes: "The school's permanent SIS identifier.",
      },
      {
        target: "first_name",
        label: "First name",
        required: true,
        acceptedHeaders: ["first_name", "firstname", "first", "given_name", "fname"],
      },
      {
        target: "last_name",
        label: "Last name",
        required: true,
        acceptedHeaders: ["last_name", "lastname", "last", "family_name", "surname", "lname"],
      },
      {
        target: "grade",
        label: "Grade",
        required: true,
        acceptedHeaders: ["grade", "grade_level", "gradelevel", "year", "yr"],
        notes: "0-12 ('K' is also accepted and stored as 0).",
      },
      {
        target: "parent_name",
        label: "Parent / guardian name",
        required: false,
        acceptedHeaders: ["parent_name", "guardian_name", "contact_name"],
      },
      {
        target: "parent_email",
        label: "Parent / guardian email",
        required: false,
        acceptedHeaders: ["parent_email", "guardian_email", "contact_email", "email"],
      },
      {
        target: "parent_phone",
        label: "Parent / guardian phone",
        required: false,
        acceptedHeaders: ["parent_phone", "guardian_phone", "contact_phone", "phone"],
      },
    ],
    sampleCsv:
      "student_id,first_name,last_name,grade,parent_email\n10234,Maya,Rivera,3,mrivera@example.com\n10235,Aiden,Chen,5,achen@example.com\n",
    notes: [
      "School-scope only — there's no district-wide rosters import.",
      "If a row's student_id already exists, the row is skipped and counted as a warning.",
      "Rows with the same student_id appearing twice in one file are treated as the same student.",
    ],
  },
  behavior: {
    label: "Behavior notes",
    targetsFor: () => BEHAVIOR_TARGETS,
    supportsDistrict: false,
    helpText:
      "One row per behavior log / counselor note. Always inserts (no de-duplication).",
    description:
      "One row per behavior log / counselor note. Each row creates a fresh support note record — there is no de-duplication, so re-uploading the same file will create duplicates. Use this for one-off backfills from prior systems, not for ongoing daily logging (use the in-app behavior tracker for that).",
    columns: [
      {
        target: "student_id",
        label: "Student ID",
        required: true,
        acceptedHeaders: ["student_id", "student_number", "sis_id", "id", "studentid"],
      },
      {
        target: "note_text",
        label: "Description / narrative",
        required: true,
        acceptedHeaders: ["note_text", "note", "description", "details", "incident", "narrative", "behavior", "comments"],
      },
      {
        target: "note_type",
        label: "Category",
        required: false,
        acceptedHeaders: ["note_type", "type", "category", "incident_type", "behavior_type", "infraction_type"],
        notes: "Defaults to 'concern' if blank.",
      },
      {
        target: "staff_name",
        label: "Reported by",
        required: false,
        acceptedHeaders: ["staff_name", "staff", "teacher", "teacher_name", "reported_by", "logged_by", "author"],
        notes: "Free text — does not need to match a staff record.",
      },
      {
        target: "created_at",
        label: "Date / timestamp",
        required: false,
        acceptedHeaders: ["created_at", "date", "incident_date", "logged_at", "occurred_at", "timestamp", "when"],
        notes: "Defaults to today if blank.",
      },
    ],
    sampleCsv:
      "student_id,note_type,note_text,staff_name,created_at\n10234,concern,Disrupted morning meeting twice,Ms. Patel,2026-04-12\n10235,positive,Helped a peer during math centers,Mr. Lee,2026-04-12\n",
    notes: [
      "School-scope only.",
      "Always inserts — uploading the same file twice doubles the rows. Use rollback from the History tab if you make a mistake.",
    ],
  },
  fast_scores: {
    label: "FAST scores",
    targetsFor: () => FAST_SCORES_TARGETS,
    supportsDistrict: false,
    helpText:
      "Florida FAST PM scale scores. One row per (student, subject). Re-importing updates instead of duplicating.",
    description:
      "Florida FAST PM scale scores. One row per (student, subject). PM1/PM2/PM3 and prior-year fields are all optional — partial-quarter uploads (e.g. just PM1 in October, then PM1+PM2 in February) are fully supported. Re-uploading the same (student, subject) updates the existing row in place; PM columns left blank in a later upload preserve their existing value rather than being cleared.",
    columns: [
      {
        target: "student_id",
        label: "Student ID",
        required: true,
        acceptedHeaders: ["student_id", "student_number", "sis_id", "id", "studentid"],
      },
      {
        target: "subject",
        label: "Subject",
        required: true,
        acceptedHeaders: ["subject", "test", "assessment", "area", "domain"],
        notes: "Accepts 'ela', 'ELA', 'Reading' (mapped to ela), 'math', 'Math', 'Mathematics'. Anything else is rejected.",
      },
      {
        target: "pm1",
        label: "PM1 (fall)",
        required: false,
        acceptedHeaders: ["pm1", "pm_1", "fall", "pm1_score", "fall_score"],
        notes: "Integer scale score.",
      },
      {
        target: "pm2",
        label: "PM2 (winter)",
        required: false,
        acceptedHeaders: ["pm2", "pm_2", "winter", "pm2_score", "winter_score"],
        notes: "Integer scale score.",
      },
      {
        target: "pm3",
        label: "PM3 (spring)",
        required: false,
        acceptedHeaders: ["pm3", "pm_3", "spring", "pm3_score", "spring_score"],
        notes: "Integer scale score.",
      },
      {
        target: "prior_year_score",
        label: "Prior-year final scale score",
        required: false,
        acceptedHeaders: ["prior_year_score", "prior_year", "py_score", "last_year", "last_year_score", "previous_year_score", "scale_score"],
        notes: "Integer. Used to render the trend line.",
      },
      {
        target: "prior_year_bq",
        label: "Prior-year bottom-quartile flag",
        required: false,
        acceptedHeaders: ["prior_year_bq", "bq", "bottom_quartile", "py_bq", "is_bq"],
        notes: "Y/N, Yes/No, true/false, or 1/0. Drives the 'Needs support' pill on the parent and staff dashboards.",
      },
    ],
    sampleCsv:
      "student_id,subject,pm1,pm2,pm3,prior_year_score,prior_year_bq\n10234,ELA,310,318,,305,Y\n10234,Math,295,302,,290,N\n10235,Reading,322,330,,318,N\n",
    notes: [
      "School-scope only — FAST scores are managed per school.",
      "Re-uploading the same (student, subject) updates the existing row. Blank PM columns preserve the prior value rather than clearing it, so you can upload PM1 in October and add PM2 in February without losing PM1.",
      "Subject 'Reading' is normalized to 'ela' to match Florida FAST exports.",
      "If your prior-year scores arrive in a separate file from your PM data, use the 'FAST scores — prior year only' importer instead. It writes to the same row but cannot touch PM columns, so a prior-year file can never wipe current-year scores.",
    ],
  },
  fast_prior_year: {
    label: "FAST scores — prior year only",
    targetsFor: () => FAST_PRIOR_YEAR_TARGETS,
    supportsDistrict: false,
    helpText:
      "Last year's final FAST scale score (functionally last year's PM3). Upserts the prior-year columns only — never touches PM1/PM2/PM3.",
    description:
      "A narrower importer for schools whose end-of-year state report arrives in a separate file from PM data. Writes to the same student_fast_scores row that the FAST scores importer uses (key: student_id + subject), but the upsert SET clause only touches prior_year_score and prior_year_bq — PM1/PM2/PM3 are intentionally left alone, so a prior-year file can never wipe current-year scores. If your data already lives in one combined file, just use the FAST scores importer above; this one is purely a convenience.",
    columns: [
      {
        target: "student_id",
        label: "Student ID",
        required: true,
        acceptedHeaders: ["student_id", "student_number", "sis_id", "id", "studentid"],
      },
      {
        target: "subject",
        label: "Subject",
        required: true,
        acceptedHeaders: ["subject", "test", "assessment", "area", "domain"],
        notes: "Accepts 'ela', 'ELA', 'Reading' (mapped to ela), 'math', 'Math', 'Mathematics'.",
      },
      {
        target: "prior_year_score",
        label: "Prior-year final scale score",
        required: true,
        acceptedHeaders: [
          "prior_year_score",
          "prior_year",
          "py_score",
          "last_year",
          "last_year_score",
          "previous_year_score",
          "scale_score",
          "pm3_prior_year",
          "prior_pm3",
          "py_pm3",
          "pm3_last_year",
        ],
        notes: "Integer scale score. This is the score that drives the prior-year line on the FAST trend chart.",
      },
      {
        target: "prior_year_bq",
        label: "Prior-year bottom-quartile flag",
        required: false,
        acceptedHeaders: ["prior_year_bq", "bq", "bottom_quartile", "py_bq", "is_bq"],
        notes: "Y/N, Yes/No, true/false, or 1/0. Drives the 'Needs support' pill. If you leave this column out, the existing BQ flag on file is preserved (it is NOT reset to false).",
      },
    ],
    sampleCsv:
      "student_id,subject,prior_year_score,prior_year_bq\n10234,ELA,305,Y\n10234,Math,290,N\n10235,Reading,318,N\n",
    notes: [
      "School-scope only.",
      "Re-uploading the same (student, subject) updates the prior-year columns in place. PM1/PM2/PM3 on the existing row are never touched.",
      "Brand-new (student, subject) rows created by this importer will have NULL PM1/PM2/PM3 until a FAST scores import fills them in.",
      "Subject 'Reading' is normalized to 'ela' to match Florida FAST exports.",
    ],
  },
  bq_l25: {
    label: "Bottom Quartile / Lower 25 (full replace)",
    targetsFor: () => BQ_L25_TARGETS,
    supportsDistrict: false,
    helpText:
      "Quick upload of this year's Bottom-Quartile (Lower 25) list. Flips ONLY the BQ flag on current-year rows — never touches scores. FULL REPLACE: students not in the file for a subject get un-flagged.",
    description:
      "The state sends the Bottom-Quartile / Lower-25 (L25) list separately from scale scores, and it changes as data is re-run. This importer is a repeatable quick upload that sets ONLY prior_year_bq on the current school-year student_fast_scores row (never PM1/PM2/PM3, never prior_year_score). It is a FULL REPLACE per subject present in the file: the current BQ set for that subject is cleared first, then the students you list are flagged — so a student who is no longer bottom-quartile drops off automatically. Each upload is a single restorable job (undo from the History tab restores the exact prior flags).",
    columns: [
      {
        target: "student_id",
        label: "Student ID",
        required: true,
        acceptedHeaders: ["student_id", "student_number", "sis_id", "id", "studentid"],
      },
      {
        target: "subject",
        label: "Subject",
        required: true,
        acceptedHeaders: ["subject", "test", "assessment", "area", "domain"],
        notes: "Accepts 'ela', 'ELA', 'Reading' (mapped to ela), 'math', 'algebra1', 'geometry'. Every subject in the file is FULL-REPLACED.",
      },
      {
        target: "prior_year_bq",
        label: "Bottom-quartile / L25 flag",
        required: false,
        acceptedHeaders: [
          "prior_year_bq",
          "bq",
          "bottom_quartile",
          "py_bq",
          "is_bq",
          "l25",
          "lower_25",
          "lowest_25",
          "lowest_quartile",
        ],
        notes: "Optional. Y/N, Yes/No, true/false, or 1/0. If you leave this column out entirely, every student in the file is treated as bottom-quartile (a pure L25 list).",
      },
    ],
    sampleCsv:
      "student_id,subject,bq\n10234,ELA,Y\n10235,ELA,Y\n10234,Math,Y\n10240,Math,Y\n",
    notes: [
      "School-scope only.",
      "FULL REPLACE per subject in the file: any current-year student NOT listed (or listed with N) for that subject has their BQ flag cleared.",
      "Only the Bottom-Quartile flag is touched — PM1/PM2/PM3 and prior-year scale scores are never changed.",
      "Undo from the History tab restores the exact set of BQ flags that existed before the upload.",
      "Subject 'Reading' is normalized to 'ela' to match Florida FAST exports.",
    ],
  },
  fast_florida: {
    label: "Florida FAST (state xlsx — ELA Reading + Math)",
    // This importer doesn't use the column-mapping flow — the xlsx layout
    // is known a priori. Empty targets means the mapping step is skipped.
    targetsFor: () => [],
    supportsDistrict: false,
    helpText:
      "Per-student xlsx export from the Florida FAST state portal. Captures scale score + every per-benchmark item response. Supports ELA Reading and Mathematics; Writing is not yet supported. Pick the school year to back-fill prior years.",
    description:
      "Drop in the state's per-student xlsx (the one with ~180 columns: demographics, scale score, achievement level, then 40 repeating Category / Benchmark / Points Earned / Points Possible quadruplets). No column mapping needed — the layout is fixed. The importer auto-detects the subject (ELA Reading or Mathematics) and the PM window (PM1/PM2/PM3) from the file itself. It stamps the school year you choose, lands the scale score in PM1/PM2/PM3 based on the file's Test Reason column, and records every benchmark response for the item-level heatmap. Re-uploading the same PM + school year DELETEs the prior item-response rows for those students before reinserting (idempotent). FAST Writing uses a rubric-scored layout that this importer doesn't yet handle — contact support if you need it prioritized.",
    columns: [],
    sampleCsv: "",
    notes: [
      "School-scope only. Supports ELA Reading and Mathematics (one subject per file, auto-detected from the scale-score column).",
      "Pick the school year on the upload step — the current year plus up to the five preceding years (back to 22-23, when FAST launched) are allowed for prior-year back-fill.",
      "Rollback DELETEs every benchmark response stamped with this import job, plus any scale-score row the same job created. PM values written by an earlier job survive.",
      "12 MB file limit. Split by grade if the state export exceeds it.",
    ],
  },
  gradebook: {
    label: "Gradebook (current grades — Live Grade Report xlsx)",
    // Fixed-layout xlsx, like fast_florida — no column-mapping step.
    targetsFor: () => [],
    supportsDistrict: false,
    helpText:
      "Per-student current course grades from your SIS 'Live Grade Report' xlsx. One row per student×course with Q1-Q4 + final. Pick which quarter the grades represent. Each upload fully replaces the school's current grades.",
    description:
      "Drop in the SIS 'Live Grade Report' xlsx — one row per student per course, with columns for Grade level, Other ID (the student's local SIS id), the course code, Section, Course Desc, Teacher, Length, Start/Stop Term, the four quarter grades (Q1-Q4) and a Final (FIN). No column mapping needed — the layout is fixed and auto-detected. On the upload step you pick which quarter these grades currently represent (Q1-Q4) and an effective date (defaults to today). Students are matched by Other ID against your roster's local SIS id; rows that don't match a student are skipped and listed on the preview. Each upload FULLY REPLACES the school's stored current grades, so always upload the complete report. Reversible from History → Roll back (which clears the grades; re-upload to restore).",
    columns: [],
    sampleCsv: "",
    notes: [
      "School-scope only. Matched by Other ID == local SIS id — import rosters first. Unmatched / ambiguous ids are reported and skipped, never guessed.",
      "Pick the quarter (Q1-Q4) these grades represent on the upload step. The current grade shown per course is that quarter's value, falling back to the latest populated quarter.",
      "Each upload FULLY REPLACES the school's current grades. Roll back deletes this upload's rows (the prior upload is already gone — re-upload the previous file to restore).",
      "GPA (when enabled in Settings) is an unweighted 4.0 average over the current semester's graded courses: 90-100=4, 80-89=3, 70-79=2, 60-69=1, below 60=0.",
      "12 MB file limit. .xlsx or .xls.",
    ],
  },
  points_migration: {
    label: "PBIS point balances (migrate from another app)",
    targetsFor: () => POINTS_MIGRATION_TARGETS,
    supportsDistrict: false,
    helpText:
      "Carry over each student's existing PBIS point balance when your school switches to PulseEDU from LiveSchool, ClassDojo, Kickboard, etc. One row per student.",
    description:
      "Moving to PulseEDU from another PBIS platform? Export each student's current point balance from your old app and drop the file here so their balance follows them. Match is by Local SIS ID (the same student number on your roster) — import the roster first if you haven't. Each row is one (student, balance). On the commit step you choose how the migrated points behave: 'Store balance only' makes them spendable in the School Store but keeps them OUT of house standings, leaderboards, and recognition counts (recommended — the points were earned on another system, so they shouldn't retroactively swing the house race); 'Count as earned' writes them as real PulseEDU recognitions so they DO count toward houses, leaderboards, and totals. Either way the import is fully reversible from History → Roll back, and redeeming points in the Store never reduces house totals.",
    columns: [
      {
        target: "local_sis_id",
        label: "Local SIS ID",
        required: true,
        acceptedHeaders: [
          "local_sis_id",
          "local_id",
          "sis_id",
          "student_id",
          "student_number",
          "studentnumber",
          "id",
          "studentid",
        ],
        notes:
          "Your local student number (NOT the state FLEID). Must already exist in the PulseEDU roster — import rosters first.",
      },
      {
        target: "points",
        label: "Point balance",
        required: true,
        acceptedHeaders: [
          "points",
          "balance",
          "point_balance",
          "points_balance",
          "current_balance",
          "available_points",
          "total_points",
        ],
        notes:
          "Whole number ≥ 0 (commas allowed, e.g. 1,250). This is the student's current spendable balance in your old app.",
      },
    ],
    sampleCsv:
      "local_sis_id,points\n" + "100245,320\n" + "100377,1,250\n" + "100412,0\n",
    notes: [
      "School-scope only. Match is by Local SIS ID — rows with no matching student (or a duplicate SIS ID) are reported and skipped, never guessed.",
      "Pick 'Store balance only' or 'Count as earned' on the commit step. Store-only is the default and never touches house standings or leaderboards.",
      "Reversible from History → Roll back. 'Store balance only' is idempotent: re-importing a corrected file just updates each student's balance to the new number (it never stacks). 'Count as earned' writes recognitions, so re-running it adds again — don't re-import the same file.",
      "Redeeming migrated points in the School Store never reduces house totals — spending and the house race are independent.",
    ],
  },
};

// Grouping for the "Choose data" step. Ordered by how often a school
// actually reaches for each importer (most-used first) — that is the
// order shown in the UI. FAST is bundled into ONE group so its three
// paths read as a single choice with a clear default, instead of three
// co-equal options that look like duplicates.
type KindGroup = {
  title: string;
  caption: string;
  kinds: Kind[];
  // The row shown by default; any others sit behind a "more ways"
  // disclosure. Only meaningful when the group has >1 visible kind.
  primary?: Kind;
};

const KIND_GROUPS: KindGroup[] = [
  {
    title: "Grades",
    caption: "Course grades from your SIS. The one you'll use most often.",
    kinds: ["gradebook"],
  },
  {
    title: "FAST scores",
    caption:
      "Florida FAST, imported after each PM window (about 4× a year). Most schools use the state portal file; a manual CSV is a fallback, and the Bottom-Quartile list is a quick repeatable upload.",
    kinds: ["fast_florida", "fast_scores", "bq_l25"],
    primary: "fast_florida",
  },
  {
    title: "Other test scores",
    caption: "iReady, SCI Benchmark, MAP, STAR, and any other vendor test.",
    kinds: ["assessments"],
  },
  {
    title: "Students",
    caption: "Add new students to your roster.",
    kinds: ["rosters"],
  },
  {
    title: "Behavior",
    caption:
      "A one-time backfill of behavior / counselor logs from a prior system.",
    kinds: ["behavior"],
  },
  {
    title: "Switching from another PBIS app",
    caption:
      "Least used — a one-time point-balance transfer when you move to PulseEDU.",
    kinds: ["points_migration"],
  },
];

// Inside the FAST group the heading already says "FAST", so each row
// shows just its METHOD (clearer than three near-identical "FAST…"
// labels). Elsewhere the row title falls back to the canonical label
// with any trailing parenthetical stripped.
const KIND_ROW_TITLE: Partial<Record<Kind, string>> = {
  fast_florida: "From the state portal file (.xlsx)",
  fast_scores: "Manual entry — build a CSV of scale scores",
  fast_prior_year: "Prior-year final scores only",
  bq_l25: "Bottom Quartile / Lower 25 list (full replace)",
};

// Small badge on the recommended/most-common row within a group.
const KIND_ROW_BADGE: Partial<Record<Kind, string>> = {
  gradebook: "Most used",
  fast_florida: "Recommended",
};

// Headers list "ignore" as a sentinel — when a CSV column isn't in the
// mapping at all, it's effectively ignored. We surface "ignore" as a
// menu option so the admin can explicitly drop a noisy column.
const IGNORE_VALUE = "__ignore__";

// FL FAST launched in the 22-23 school year (full start year 2022).
// Nothing older is a comparable FAST score, so it is never offered.
const FAST_LAUNCH_START_YEAR = 2022;

// Build the school-year dropdown options for the Florida xlsx
// importer: current year plus up to the five preceding years, clamped
// to the FAST launch year (22-23). Returns "YY-YY" strings (e.g.
// ["26-27", "25-26", "24-25", "23-24", "22-23"]). Five is the cap
// because the roster's multi-year history window
// (fast_history_years_visible) tops out at 5.
// School year transitions on Jul 1 to match schoolYearLabelFor on
// the server (Eastern timezone is acceptable for the client-side
// fallback — the server re-validates the picked year on submit).
function floridaSchoolYearOptions(): string[] {
  const now = new Date();
  const month = now.getMonth(); // 0-11
  const year = now.getFullYear();
  // Year starts in Jul. Before Jul → previous SY is "current".
  const startYear = month >= 6 ? year : year - 1;
  const pad = (n: number) => String(n % 100).padStart(2, "0");
  const out: string[] = [];
  for (let off = 0; off <= 5; off++) {
    const s = startYear - off;
    if (s < FAST_LAUNCH_START_YEAR) break; // don't offer pre-FAST years
    out.push(`${pad(s)}-${pad(s + 1)}`);
  }
  return out;
}

const dropZoneStyle: CSSProperties = {
  border: "2px dashed var(--border, #2a3447)",
  borderRadius: 12,
  padding: "2.5rem 1rem",
  textAlign: "center",
  cursor: "pointer",
  transition: "border-color 120ms, background 120ms",
};

const dropZoneActiveStyle: CSSProperties = {
  ...dropZoneStyle,
  borderColor: "var(--accent, #3b82f6)",
  background: "rgba(59, 130, 246, 0.08)",
};

// Tab buttons sit above a 1px bottom border on the parent container; the
// active tab paints its own bottom edge with the surface color so it
// reads as continuous with the panel below it (classic "tab merges into
// content" pattern). Inactive tabs are transparent so they recede.
const tabBtnStyle = (active: boolean): CSSProperties => ({
  padding: "0.55rem 1.1rem",
  border: "1px solid var(--border)",
  borderBottom: active
    ? "1px solid var(--surface)"
    : "1px solid var(--border)",
  borderRadius: "8px 8px 0 0",
  background: active ? "var(--surface)" : "transparent",
  color: active ? "var(--primary)" : "var(--text-muted)",
  font: "inherit",
  fontSize: 14,
  cursor: "pointer",
  fontWeight: active ? 700 : 500,
  marginBottom: -1,
});

const statusPillStyle = (status: string): CSSProperties => {
  const colors: Record<string, [string, string]> = {
    committed: ["#10b981", "#064e3b"],
    pending: ["#f59e0b", "#78350f"],
    failed: ["#ef4444", "#7f1d1d"],
    rolled_back: ["#94a3b8", "#334155"],
  };
  const [bg, fg] = colors[status] ?? ["#94a3b8", "#334155"];
  return {
    display: "inline-block",
    padding: "0.15rem 0.55rem",
    borderRadius: 999,
    background: bg,
    color: fg,
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  };
};

// Renders the per-kind directions: description, required + optional
// columns (with accepted header synonyms), a copy-pasteable sample CSV,
// and any caveats. Wrapped in <details open> so admins can collapse it
// after their first successful import without losing the affordance.
function DirectionsPanel({ kind, kindDef }: { kind: Kind; kindDef: KindDef }) {
  const required = kindDef.columns.filter((c) => c.required);
  const optional = kindDef.columns.filter((c) => !c.required);
  const [copied, setCopied] = useState(false);
  // Clear the "Copied!" badge when the user switches kinds — otherwise
  // the affirmation can briefly appear over a different sample CSV.
  useEffect(() => {
    setCopied(false);
  }, [kindDef]);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(kindDef.sampleCsv);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can fail in restricted contexts; silently no-op so
      // the user can still select the <pre> contents manually.
    }
  };

  // Save the sample CSV to disk as a starter file. The filename is
  // derived from the kind's machine name so admins know which importer
  // it lines up with (e.g. fast_scores_starter.csv). Using a Blob +
  // object URL keeps this fully client-side — no round trip needed.
  const onDownload = () => {
    const blob = new Blob([kindDef.sampleCsv], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${kind}_starter.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Release the blob URL on the next tick so the browser has time
    // to actually start the download before we revoke it.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const renderRows = (cols: KindColumnDoc[]) =>
    cols.map((c) => (
      <tr key={c.target} style={{ borderTop: "1px solid var(--border)" }}>
        <td
          style={{
            padding: "0.5rem 0.6rem",
            fontWeight: 600,
            verticalAlign: "top",
            color: "var(--text)",
          }}
        >
          {c.label}
          {c.required && (
            <span
              aria-label="required"
              title="Required column"
              style={{
                marginLeft: 4,
                color: "#dc2626",
                fontWeight: 700,
              }}
            >
              *
            </span>
          )}
        </td>
        <td
          style={{
            padding: "0.5rem 0.6rem",
            verticalAlign: "top",
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            fontSize: 12,
            color: "var(--text)",
          }}
        >
          {c.acceptedHeaders.join(", ")}
        </td>
        <td
          style={{
            padding: "0.5rem 0.6rem",
            verticalAlign: "top",
            fontSize: 13,
            color: "var(--text-muted)",
            lineHeight: 1.45,
          }}
        >
          {c.notes ?? "—"}
        </td>
      </tr>
    ));

  return (
    <details
      open
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        padding: "0.85rem 1.1rem",
        marginBottom: "1rem",
        color: "var(--text)",
        boxShadow: "0 1px 2px rgba(15, 23, 42, 0.04)",
      }}
    >
      <summary
        style={{
          cursor: "pointer",
          fontWeight: 600,
          fontSize: 14,
          color: "var(--text)",
          padding: "0.15rem 0",
          // Keep the native disclosure triangle so users know it's collapsible
          listStyle: "revert",
        }}
      >
        How to format your {kindDef.label} CSV
      </summary>
      <div
        style={{
          marginTop: "0.75rem",
          fontSize: 14,
          lineHeight: 1.55,
          color: "var(--text)",
        }}
      >
        {kindDef.description}
      </div>

      {required.length > 0 && (
        <div style={{ marginTop: "1rem" }}>
          <div
            style={{
              fontWeight: 600,
              marginBottom: "0.45rem",
              fontSize: 13,
              color: "var(--text)",
              textTransform: "uppercase",
              letterSpacing: "0.04em",
            }}
          >
            Required columns
          </div>
          <table className="pulse-table"
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 13,
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              overflow: "hidden",
            }}
          >
            <thead>
              <tr
                style={{
                  textAlign: "left",
                  color: "var(--text-muted)",
                  background: "var(--surface)",
                }}
              >
                <th style={{ padding: "0.45rem 0.6rem", width: "22%" }}>
                  Field
                </th>
                <th style={{ padding: "0.45rem 0.6rem", width: "38%" }}>
                  Accepted header names
                </th>
                <th style={{ padding: "0.45rem 0.6rem" }}>Notes</th>
              </tr>
            </thead>
            <tbody>{renderRows(required)}</tbody>
          </table>
        </div>
      )}

      {optional.length > 0 && (
        <div style={{ marginTop: "1rem" }}>
          <div
            style={{
              fontWeight: 600,
              marginBottom: "0.45rem",
              fontSize: 13,
              color: "var(--text)",
              textTransform: "uppercase",
              letterSpacing: "0.04em",
            }}
          >
            Optional columns
          </div>
          <table className="pulse-table"
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 13,
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              overflow: "hidden",
            }}
          >
            <thead>
              <tr
                style={{
                  textAlign: "left",
                  color: "var(--text-muted)",
                  background: "var(--surface)",
                }}
              >
                <th style={{ padding: "0.45rem 0.6rem", width: "22%" }}>
                  Field
                </th>
                <th style={{ padding: "0.45rem 0.6rem", width: "38%" }}>
                  Accepted header names
                </th>
                <th style={{ padding: "0.45rem 0.6rem" }}>Notes</th>
              </tr>
            </thead>
            <tbody>{renderRows(optional)}</tbody>
          </table>
        </div>
      )}

      <div style={{ marginTop: "1.1rem" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginBottom: "0.5rem",
            flexWrap: "wrap",
          }}
        >
          <span
            style={{
              fontWeight: 600,
              fontSize: 13,
              color: "var(--text)",
              textTransform: "uppercase",
              letterSpacing: "0.04em",
            }}
          >
            Sample CSV
          </span>
          {/* Primary action: download a ready-to-edit starter file. Filled
              with the brand primary so the user's eye lands here first. */}
          <button
            type="button"
            onClick={onDownload}
            title={`Download ${kind}_starter.csv with headers + example rows`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "0.35rem 0.75rem",
              border: "1px solid var(--primary)",
              borderRadius: 6,
              background: "var(--primary)",
              color: "#ffffff",
              cursor: "pointer",
              font: "inherit",
              fontSize: 12,
              fontWeight: 600,
              lineHeight: 1.2,
              boxShadow: "0 1px 2px rgba(15, 23, 42, 0.08)",
            }}
          >
            <span aria-hidden>↓</span>
            Download starter file
          </button>
          {/* Secondary action: copy the same content to clipboard. Outlined
              so it reads as the lighter-weight option. */}
          <button
            type="button"
            onClick={onCopy}
            title="Copy the sample CSV to your clipboard"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "0.35rem 0.75rem",
              border: "1px solid var(--border-strong)",
              borderRadius: 6,
              background: "var(--surface)",
              color: "var(--text)",
              cursor: "pointer",
              font: "inherit",
              fontSize: 12,
              fontWeight: 600,
              lineHeight: 1.2,
            }}
          >
            <span aria-hidden>{copied ? "✓" : "⧉"}</span>
            {copied ? "Copied" : "Copy CSV"}
          </button>
        </div>
        <pre
          style={{
            margin: 0,
            padding: "0.7rem 0.85rem",
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            fontSize: 12,
            color: "var(--text)",
            overflowX: "auto",
            whiteSpace: "pre",
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            lineHeight: 1.5,
          }}
        >
          {kindDef.sampleCsv}
        </pre>
      </div>

      {kindDef.notes.length > 0 && (
        <ul style={{ marginTop: "0.75rem", marginBottom: 0, paddingLeft: "1.25rem", fontSize: 13, color: "var(--text-subtle)" }}>
          {kindDef.notes.map((n, i) => (
            <li key={i} style={{ marginBottom: "0.2rem" }}>{n}</li>
          ))}
        </ul>
      )}
    </details>
  );
}

type DataImportsProps = {
  // Whether the signed-in user can act as a District Admin (DA or SU).
  // When false, the scope toggle is hidden and every request goes to the
  // school-scope endpoints.
  canActAsDistrict?: boolean;
  // When provided, restricts the wizard to just these import kinds — used
  // by delegated importers (staff granted only capImportGrades / Fast /
  // Iready) so they see ONLY the importer(s) they can run. Undefined = full
  // access (admins). The server enforces the same per-kind cap, so this is a
  // UX filter, not the security boundary.
  allowedKinds?: Kind[];
};

export default function DataImports({
  canActAsDistrict = false,
  allowedKinds,
}: DataImportsProps) {
  const visibleKinds = useMemo<Kind[]>(
    () =>
      (Object.keys(KIND_DEFS) as Kind[]).filter(
        (k) => !allowedKinds || allowedKinds.includes(k),
      ),
    [allowedKinds],
  );
  const [tab, setTab] = useState<"upload" | "history">("upload");
  const [kind, setKind] = useState<Kind>(
    () =>
      (visibleKinds.includes("gradebook") ? "gradebook" : visibleKinds[0]) ??
      "assessments",
  );
  // Whether the FAST group's secondary (CSV) importers are revealed. The
  // primary state-portal option is always shown; the two fallbacks sit
  // behind a "more ways" disclosure to keep the picker uncluttered.
  const [showFastAlt, setShowFastAlt] = useState(false);
  const [scope, setScope] = useState<Scope>("school");
  // points_migration only — how migrated points behave. Default false =
  // "Store balance only" (spendable, excluded from houses/leaderboards).
  const [pmCountsTowardHouses, setPmCountsTowardHouses] = useState(false);
  // Label stamped on the migrated rows (staffName on earned entries, source
  // on the ledger). Shown to staff in PBIS history; defaults if left blank.
  const [pmSource, setPmSource] = useState("Imported balance");
  const kindDef = KIND_DEFS[kind];
  // Effective scope: rosters/behavior don't support district mode, so
  // force-clamp to school regardless of what the radio says. The toggle
  // is also hidden when the kind doesn't support district.
  const effectiveScope: Scope = kindDef.supportsDistrict ? scope : "school";

  // Upload state
  const [filename, setFilename] = useState<string>("");
  const [csvText, setCsvText] = useState<string>("");
  // FAST Phase 1 Florida xlsx flow — holds the base64-encoded xlsx
  // bytes (empty for all other kinds). Separated from csvText so the
  // CSV path never accidentally sends binary data and vice versa.
  const [xlsxBase64, setXlsxBase64] = useState<string>("");
  // School-year label the operator picked for the Florida import.
  // "YY-YY" (e.g. "25-26"). Default fills in after the first /preview
  // response — the server tells us the current year so the dropdown
  // can render relative to today regardless of the client clock.
  // Default to the current school year so the first Florida preview
  // call after upload has a valid year — the server re-validates.
  // Phase-1 Historical FAST work: when true, the operator is
  // explicitly back-filling a prior school year. Server requires the
  // file be PM3-only and stamps is_historical=true on every row.
  const [isHistoricalImport, setIsHistoricalImport] = useState(false);
  const [selectedSchoolYear, setSelectedSchoolYear] = useState<string>(
    () => floridaSchoolYearOptions()[0] ?? "",
  );
  // Gradebook xlsx flow — which quarter the uploaded grades represent and
  // the effective date (defaults to today, school-local enough for a date).
  const [gradebookQuarter, setGradebookQuarter] = useState<
    "Q1" | "Q2" | "Q3" | "Q4"
  >("Q1");
  const [gradebookDate, setGradebookDate] = useState<string>(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
  const [dragActive, setDragActive] = useState(false);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [previewing, setPreviewing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string>("");
  const [commitResult, setCommitResult] = useState<{
    jobId: number;
    totalRows: number;
    successRows: number;
    errorRows: number;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Monotonically increasing token; only the most recent runPreview()
  // call is allowed to write to state. Prevents a stale response from
  // a prior scope/mapping from clobbering the current preview after a
  // fast scope toggle or rapid mapping edits.
  const previewTokenRef = useRef(0);

  // History state
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [rollbackId, setRollbackId] = useState<number | null>(null);

  // Templates state — saved column mappings the user can re-apply.
  const [templates, setTemplates] = useState<ImportTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);

  // 5-step wizard state. The step gates which UI block renders inside
  // the Upload tab; the existing data flow (preview → mapping → commit)
  // is unchanged. Steps:
  //   0 — Choose data type (cards; Roster card disabled when the
  //       per-school manualRosterUploadEnabled toggle is OFF)
  //   1 — Upload CSV (drop zone)
  //   2 — Map columns (target dictionary; required cols highlighted)
  //   3 — Preview (validRows / errorRows / sample / per-school)
  //   4 — Confirm: type the kind word in caps to enable Commit
  const [step, setStep] = useState<0 | 1 | 2 | 3 | 4>(0);
  const [confirmEcho, setConfirmEcho] = useState("");
  // Per-school gate for the Roster card. Fetched once on mount; the
  // server enforces the same toggle on /rosters/preview and /commit, so
  // this is purely a UX hint — a stale value can't cause a bad commit.
  const [rosterEnabled, setRosterEnabled] = useState<boolean | null>(null);
  // Defense-in-depth: if allowedKinds narrows at runtime (e.g. caps revoked
  // on re-auth) and the selected kind is no longer visible, clamp back to
  // the first allowed kind so the wizard never operates on a hidden kind.
  useEffect(() => {
    if (!visibleKinds.includes(kind) && visibleKinds.length > 0) {
      setKind(visibleKinds[0]);
    }
  }, [visibleKinds, kind]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await authFetch("/api/school-settings");
        if (!r.ok) {
          if (alive) setRosterEnabled(false);
          return;
        }
        const data = (await r.json()) as {
          manualRosterUploadEnabled?: boolean;
        };
        if (alive) setRosterEnabled(!!data.manualRosterUploadEnabled);
      } catch {
        if (alive) setRosterEnabled(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  // Each kind has a single-word "echo" the user must type to commit.
  // Capital so it's hard to fat-finger past. Mirrors NewCaseWizard's
  // confirm-step pattern.
  const KIND_ECHO_WORDS: Record<Kind, string> = {
    rosters: "ROSTER",
    assessments: "ASSESSMENTS",
    behavior: "BEHAVIOR",
    fast_scores: "FAST",
    fast_prior_year: "FAST",
    bq_l25: "FAST",
    fast_florida: "FLORIDA",
    gradebook: "GRADEBOOK",
    points_migration: "POINTS",
  };
  const echoWord = KIND_ECHO_WORDS[kind];

  // Endpoints + target dictionary depend on (kind, effectiveScope).
  // Memoized so the identity is stable across renders.
  const endpoints = useMemo(() => {
    if (effectiveScope === "district") {
      return {
        preview: `/api/data-imports/${kind}/preview-district`,
        commit: `/api/data-imports/${kind}/commit-district`,
      };
    }
    return {
      preview: `/api/data-imports/${kind}/preview`,
      commit: `/api/data-imports/${kind}/commit`,
    };
  }, [kind, effectiveScope]);
  const targets = useMemo(
    () => kindDef.targetsFor(effectiveScope),
    [kindDef, effectiveScope],
  );

  const loadJobs = async () => {
    setJobsLoading(true);
    try {
      const params = new URLSearchParams({ kind });
      if (scope === "district") params.set("scope", "district");
      const r = await authFetch(`/api/data-imports/jobs?${params.toString()}`);
      if (r.ok) setJobs(await r.json());
    } finally {
      setJobsLoading(false);
    }
  };

  useEffect(() => {
    if (tab === "history") void loadJobs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, scope, kind]);

  // Load templates whenever the user lands on the Upload tab in a given
  // scope. Cheap query (one school's worth of rows at most), so always
  // re-fetching keeps the dropdown current after a save/delete elsewhere.
  const loadTemplates = async () => {
    setTemplatesLoading(true);
    try {
      const params = new URLSearchParams({ kind });
      if (scope === "district") params.set("scope", "district");
      const r = await authFetch(
        `/api/data-imports/templates?${params.toString()}`,
      );
      if (r.ok) setTemplates(await r.json());
    } finally {
      setTemplatesLoading(false);
    }
  };

  useEffect(() => {
    if (tab === "upload") void loadTemplates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, scope, kind]);

  // Apply a template's mapping to the current preview. We only keep the
  // pairs whose CSV column actually exists in this file (the user might
  // be uploading a file from a different vendor than the template was
  // built for) — every kept pair is also re-validated by the server when
  // we re-run preview, so there's no risk of saving a stale mapping.
  const applyTemplate = (tplId: number) => {
    if (!preview || !csvText) return;
    const tpl = templates.find((t) => t.id === tplId);
    if (!tpl) return;
    const headerSet = new Set(preview.headers);
    const next: Record<string, string> = {};
    for (const [csvCol, target] of Object.entries(tpl.mapping)) {
      if (headerSet.has(csvCol)) next[csvCol] = target;
    }
    setMapping(next);
    void runPreview(csvText, next);
  };

  const handleSaveTemplate = async () => {
    if (!preview || Object.keys(mapping).length === 0) return;
    const name = window.prompt(
      "Save this mapping as a template. Use the vendor name (e.g. 'FAST', 'iReady'):",
    );
    if (!name || !name.trim()) return;
    setSavingTemplate(true);
    try {
      const body = {
        kind,
        name: name.trim(),
        mapping,
        scope,
      };
      const r = await authFetch("/api/data-imports/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert(j.error ?? `Save failed (HTTP ${r.status})`);
        return;
      }
      await loadTemplates();
    } finally {
      setSavingTemplate(false);
    }
  };

  const handleDeleteTemplate = async (tplId: number, tplName: string) => {
    if (
      !window.confirm(
        `Delete the "${tplName}" template? Anyone using it will need to re-map their next upload.`,
      )
    )
      return;
    const r = await authFetch(`/api/data-imports/templates/${tplId}`, {
      method: "DELETE",
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      alert(j.error ?? `Delete failed (HTTP ${r.status})`);
      return;
    }
    await loadTemplates();
  };

  const resetUpload = () => {
    // Bumping the token also cancels any in-flight preview from before
    // the reset (its response will be ignored on arrival).
    previewTokenRef.current++;
    setFilename("");
    setCsvText("");
    setXlsxBase64("");
    setPreview(null);
    setMapping({});
    setError("");
    setCommitResult(null);
    setPreviewing(false);
    setStep(0);
    setConfirmEcho("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleFile = async (file: File) => {
    setError("");
    setCommitResult(null);
    const isXlsx = /\.xlsx$/i.test(file.name);
    const isXls = /\.xls$/i.test(file.name);
    const isCsv = /\.csv$/i.test(file.name);
    if (kind === "fast_florida" || kind === "gradebook") {
      if (!isXlsx && !isXls) {
        setError(
          kind === "gradebook"
            ? "Please choose a .xlsx or .xls Live Grade Report file."
            : "Please choose a .xlsx or .xls file exported from the Florida FAST portal.",
        );
        return;
      }
      if (file.size > 12 * 1024 * 1024) {
        setError("File exceeds the 12 MB limit. Split by grade and try again.");
        return;
      }
      // Server-side parser is exceljs which only reads .xlsx (OOXML).
      // For .xls (legacy BIFF) we convert client-side to .xlsx bytes
      // using SheetJS before uploading. Genuine .xlsx files pass
      // through untouched so we don't risk losing fidelity.
      let bytes: Uint8Array;
      if (isXlsx) {
        bytes = new Uint8Array(await file.arrayBuffer());
      } else {
        try {
          const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
          const out = XLSX.write(wb, { type: "array", bookType: "xlsx" });
          bytes = new Uint8Array(out as ArrayBuffer);
        } catch (e) {
          setError(
            `Could not convert .xls to .xlsx: ${(e as Error).message}. Re-save the file as .xlsx from Excel and try again.`,
          );
          return;
        }
      }
      // Base64 encode in chunks to avoid blowing the call stack on big
      // arrays (btoa is per-character).
      let binary = "";
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(
          null,
          Array.from(bytes.subarray(i, i + CHUNK)),
        );
      }
      const b64 = btoa(binary);
      setFilename(file.name);
      setXlsxBase64(b64);
      setCsvText(""); // not used in this flow but keep it clean
      await runPreview("", {}, { xlsxBase64: b64 });
      return;
    }
    // Generic importers (assessments / roster / behavior / fast):
    // accept .csv OR .xlsx/.xls. For Excel formats we parse the first
    // sheet client-side via SheetJS and convert to CSV text so the
    // rest of the existing preview/mapping/commit pipeline keeps
    // working unchanged. Server stays CSV-only.
    if (!isCsv && !isXlsx && !isXls) {
      setError("Please choose a .csv, .xlsx, or .xls file.");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError("File exceeds the 10 MB limit. Split the file and try again.");
      return;
    }
    let text: string;
    if (isCsv) {
      text = await file.text();
    } else {
      try {
        const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
        const firstSheetName = wb.SheetNames[0];
        if (!firstSheetName) {
          setError("The spreadsheet has no sheets.");
          return;
        }
        const sheet = wb.Sheets[firstSheetName];
        // FS:"," forces a comma delimiter; blankrows:false drops empty
        // trailing rows; RS:"\n" keeps line endings predictable so the
        // server's CSV parser doesn't trip on \r\r\n.
        text = XLSX.utils.sheet_to_csv(sheet, { FS: ",", RS: "\n", blankrows: false });
      } catch (e) {
        setError(
          `Could not read spreadsheet: ${(e as Error).message}. Try saving as CSV and uploading again.`,
        );
        return;
      }
    }
    setFilename(file.name);
    setCsvText(text);
    await runPreview(text, {});
  };

  const runPreview = async (
    text: string,
    overrideMapping: Record<string, string>,
    floridaOverride?: {
      xlsxBase64?: string;
      schoolYear?: string;
      quarter?: "Q1" | "Q2" | "Q3" | "Q4";
      effectiveDate?: string;
    },
  ) => {
    // Callers that have just called setXlsxBase64 / setSelectedSchoolYear
    // can pass the fresh values via `floridaOverride` to avoid a stale-
    // state race (React batches setState so the next read in this tick
    // returns the *previous* value).
    const floridaXlsx = floridaOverride?.xlsxBase64 ?? xlsxBase64;
    const floridaYear = floridaOverride?.schoolYear ?? selectedSchoolYear;
    const gbQuarter = floridaOverride?.quarter ?? gradebookQuarter;
    const gbDate = floridaOverride?.effectiveDate ?? gradebookDate;
    // Snapshot the token + scope at call time. After the network round
    // trip we only commit state if (a) no newer preview has been kicked
    // off and (b) the scope hasn't been toggled in flight — otherwise a
    // school-scope response could repopulate a now-district session.
    const myToken = ++previewTokenRef.current;
    const callScope = scope;
    setPreviewing(true);
    setError("");
    try {
      // FAST Florida path — different body shape, different response
      // shape. We adapt the response onto the PreviewResponse the wizard
      // expects (just enough so step 3 can render counts + samples).
      if (kind === "fast_florida") {
        const r = await authFetch(endpoints.preview, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            xlsxBase64: floridaXlsx,
            schoolYear: floridaYear || undefined,
            filename,
          }),
        });
        if (previewTokenRef.current !== myToken || callScope !== scope) return;
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          setError(j.error ?? `Preview failed (HTTP ${r.status})`);
          setPreview(null);
          return;
        }
        const data = await r.json();
        // Adapt — totalRows = #students, validRows = same (each row is
        // already validated by the parser). sampleRows mirrors the
        // generic shape minimally.
        const adapted: PreviewResponse = {
          headers: [
            "student_id",
            "window",
            "scale_score",
            "achievement_level",
          ],
          autoMapping: {},
          suggestedMapping: {},
          unmappedCsvColumns: [],
          totalRows: data.totalStudents ?? 0,
          validRows: data.totalStudents ?? 0,
          errorRows: 0,
          totalItems: data.totalItems ?? 0,
          sampleRows: (data.sampleStudents ?? []).map(
            (s: {
              studentId: string;
              window: string;
              scaleScore: number | null;
              achievementLevel: string | null;
            }) => ({
              studentId: s.studentId,
              assessmentName:
                `Florida FAST ${
                  data.subject === "math" ? "Math" : "ELA"
                } ${s.window.toUpperCase()}` +
                (data.gradeLabel ? ` · Grade ${data.gradeLabel}` : ""),
              score: s.scaleScore,
              scoreLevel: s.achievementLevel,
              administeredAt: "",
              source: "FL FAST",
            }),
          ),
          errors: (data.warnings ?? []).map(
            (w: { row: number; message: string }) => ({
              row: w.row,
              message: w.message,
            }),
          ),
          readyToCommit: !!data.readyToCommit,
        };
        setPreview(adapted);
        setMapping({});
        return;
      }
      // Gradebook xlsx path — dedicated endpoint, matched-by-local-SIS-id
      // response. Adapt onto PreviewResponse so step 3 renders counts +
      // sample courses, and surface unmatched/ambiguous ids as "errors".
      if (kind === "gradebook") {
        const r = await authFetch(endpoints.preview, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            xlsxBase64: floridaXlsx,
            quarter: gbQuarter,
            effectiveDate: gbDate,
            filename,
          }),
        });
        if (previewTokenRef.current !== myToken || callScope !== scope) return;
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          setError(j.error ?? `Preview failed (HTTP ${r.status})`);
          setPreview(null);
          return;
        }
        const data = await r.json();
        const qKey = (gbQuarter.toLowerCase() as "q1" | "q2" | "q3" | "q4");
        const adapted: PreviewResponse = {
          headers: ["local_sis_id", "course", "teacher", "grade"],
          autoMapping: {},
          suggestedMapping: {},
          unmappedCsvColumns: [],
          totalRows: data.totalRows ?? 0,
          validRows: data.matchedRows ?? 0,
          errorRows: data.unmatchedRows ?? 0,
          sampleRows: (data.sampleRows ?? []).map(
            (s: {
              localSisId: string;
              courseCode: string;
              courseDesc: string | null;
              teacherName: string | null;
              q1: number | null;
              q2: number | null;
              q3: number | null;
              q4: number | null;
              fin: number | null;
            }) => {
              const cur =
                s[qKey] ?? s.q4 ?? s.q3 ?? s.q2 ?? s.q1 ?? null;
              return {
                studentId: s.localSisId,
                assessmentName:
                  `${s.courseCode}` +
                  (s.courseDesc ? ` · ${s.courseDesc}` : "") +
                  (s.teacherName ? ` · ${s.teacherName}` : ""),
                score: cur,
                scoreLevel: gradebookQuarter,
                administeredAt: "",
                source: "Gradebook",
              };
            },
          ),
          errors: [
            ...(data.warnings ?? []).map(
              (w: { row: number; message: string }) => ({
                row: w.row,
                message: w.message,
              }),
            ),
            ...(data.unmatchedSisIds ?? []).map((id: string) => ({
              row: 0,
              message: `No student matched Other ID "${id}" — skipped.`,
            })),
            ...(data.ambiguousSisIds ?? []).map((id: string) => ({
              row: 0,
              message: `Other ID "${id}" matched more than one student — skipped.`,
            })),
          ],
          readyToCommit: !!data.readyToCommit,
        };
        setPreview(adapted);
        setMapping({});
        return;
      }
      const r = await authFetch(endpoints.preview, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv: text, mapping: overrideMapping }),
      });
      if (previewTokenRef.current !== myToken || callScope !== scope) return;
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setError(j.error ?? `Preview failed (HTTP ${r.status})`);
        setPreview(null);
        return;
      }
      const data: PreviewResponse = await r.json();
      setPreview(data);
      setMapping(data.suggestedMapping);
    } catch (e) {
      if (previewTokenRef.current !== myToken || callScope !== scope) return;
      setError(`Preview failed: ${(e as Error).message}`);
    } finally {
      if (previewTokenRef.current === myToken) setPreviewing(false);
    }
  };

  const handleMappingChange = (csvCol: string, target: string) => {
    const next = { ...mapping };
    if (target === IGNORE_VALUE) {
      delete next[csvCol];
    } else {
      // Enforce uniqueness — if another csv column was already mapped to
      // this target, drop that mapping. Two CSV columns mapping to
      // student_id never makes sense.
      for (const k of Object.keys(next)) {
        if (next[k] === target && k !== csvCol) delete next[k];
      }
      next[csvCol] = target;
    }
    setMapping(next);
    void runPreview(csvText, next);
  };

  // Final "is this current or historical?" gate for fast_florida.
  // Fires AFTER the type-echo, BEFORE the network call. The checkbox
  // on the upload step is easy to miss, and a missed-historical
  // commit lands as current-year FAST data — silently corrupting
  // dashboards. This modal forces an explicit pick every single time.
  const [historicalGate, setHistoricalGate] = useState<null | "ask">(null);

  const handleCommit = async () => {
    if (!preview) return;
    if (kind !== "fast_florida" && kind !== "gradebook" && !csvText) return;
    if ((kind === "fast_florida" || kind === "gradebook") && !xlsxBase64)
      return;
    // For fast_florida, intercept the first click and require an
    // explicit current-vs-historical pick. doCommit() below is what
    // actually performs the upload after the modal resolves.
    if (kind === "fast_florida") {
      setHistoricalGate("ask");
      return;
    }
    await doCommit(isHistoricalImport);
  };

  const doCommit = async (historical: boolean) => {
    if (!preview) return;
    setHistoricalGate(null);
    setIsHistoricalImport(historical);
    setCommitting(true);
    setError("");
    try {
      const r = await authFetch(endpoints.commit, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body:
          kind === "fast_florida"
            ? JSON.stringify({
                xlsxBase64,
                schoolYear: selectedSchoolYear || undefined,
                filename,
                isHistorical: historical,
              })
            : kind === "gradebook"
            ? JSON.stringify({
                xlsxBase64,
                quarter: gradebookQuarter,
                effectiveDate: gradebookDate,
                filename,
              })
            : kind === "points_migration"
              ? JSON.stringify({
                  csv: csvText,
                  filename,
                  mapping,
                  options: {
                    countsTowardHouses: pmCountsTowardHouses,
                    source: pmSource.trim() || undefined,
                  },
                })
              : JSON.stringify({ csv: csvText, filename, mapping }),
      });
      const j = await r.json();
      if (!r.ok) {
        setError(j.error ?? `Commit failed (HTTP ${r.status})`);
        return;
      }
      setCommitResult(j);
    } catch (e) {
      setError(`Commit failed: ${(e as Error).message}`);
    } finally {
      setCommitting(false);
    }
  };

  const handleRollback = async (id: number) => {
    if (
      !window.confirm(
        "Roll back this import? Every row it added will be deleted.",
      )
    )
      return;
    setRollbackId(id);
    try {
      const r = await authFetch(`/api/data-imports/jobs/${id}/rollback`, {
        method: "POST",
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert(j.error ?? `Rollback failed (HTTP ${r.status})`);
        return;
      }
      await loadJobs();
    } finally {
      setRollbackId(null);
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  };

  const requiredTargets = useMemo(
    () => targets.filter((t) => t.required).map((t) => t.value),
    [targets],
  );
  const missingRequired = useMemo(() => {
    if (!preview) return [];
    const have = new Set(Object.values(mapping));
    return requiredTargets.filter((t) => !have.has(t));
  }, [preview, mapping, requiredTargets]);

  // Switching scopes mid-flow would leave a stale preview / mapping
  // pointing at the wrong endpoint, so wipe upload state on toggle. The
  // History tab re-fetches via its own useEffect when scope changes.
  const handleScopeChange = (next: Scope) => {
    if (next === scope) return;
    setScope(next);
    resetUpload();
  };

  // Switching kind invalidates the current preview / mapping (different
  // target schema, different endpoints), so wipe upload state. We also
  // reset scope to "school" for kinds that don't support district —
  // avoids the radio looking active while being silently overridden.
  const handleKindChange = (next: Kind) => {
    if (next === kind) return;
    setKind(next);
    if (!KIND_DEFS[next].supportsDistrict) setScope("school");
    resetUpload();
  };

  // Wizard navigation guards. canAdvance() decides whether the Next
  // button is clickable from the current step.
  //   0 → 1: kind picked (always; the radio enforces the
  //          rosterEnabled gate so we can't land on a disabled kind)
  //   1 → 2: a file has been parsed (preview != null)
  //   2 → 3: every required column is mapped
  //   3 → 4: at least one row will import
  //   4    : commit button takes over (no Next)
  const canAdvance = (): boolean => {
    if (step === 0) {
      if (kind === "rosters" && rosterEnabled === false) return false;
      return true;
    }
    if (step === 1) {
      if (kind === "fast_florida") {
        // Need both a parsed preview and a chosen school year.
        return preview !== null && !!selectedSchoolYear;
      }
      if (kind === "gradebook") {
        return preview !== null && !!gradebookQuarter && !!gradebookDate;
      }
      return preview !== null;
    }
    if (step === 2) {
      // Florida / gradebook xlsx skip column mapping entirely.
      if (kind === "fast_florida" || kind === "gradebook") return true;
      if (!preview) return false;
      if (missingRequired.length > 0) return false;
      // Defense against an all-Ignore mapping — at least one column
      // has to actually map to something.
      return Object.keys(mapping).length > 0;
    }
    if (step === 3) {
      return !!preview && preview.validRows > 0;
    }
    return false;
  };
  const goNext = () => {
    if (!canAdvance()) return;
    setStep((s) => {
      // FAST Florida / gradebook skip the mapping step (1 → 3 directly).
      if ((kind === "fast_florida" || kind === "gradebook") && s === 1)
        return 3;
      return (Math.min(4, s + 1) as 0 | 1 | 2 | 3 | 4);
    });
  };
  const goBack = () => {
    setStep((s) => {
      // Mirror goNext: FAST Florida / gradebook back from preview → upload.
      if ((kind === "fast_florida" || kind === "gradebook") && s === 3)
        return 1;
      return (Math.max(0, s - 1) as 0 | 1 | 2 | 3 | 4);
    });
  };

  const STEP_LABELS = [
    "Choose data",
    "Upload",
    "Map columns",
    "Preview",
    "Confirm",
  ];

  // One selectable row in the step-0 "Choose data" picker. Shared by the
  // primary group rows and the FAST fallback rows so styling can't drift.
  const renderKindRow = (k: Kind, opts?: { indented?: boolean }) => {
    const def = KIND_DEFS[k];
    const isRoster = k === "rosters";
    const disabled = isRoster && rosterEnabled === false;
    const selected = kind === k;
    const title =
      KIND_ROW_TITLE[k] ?? def.label.replace(/\s*\(.*?\)\s*$/, "").trim();
    const badge = KIND_ROW_BADGE[k];
    return (
      <button
        key={k}
        type="button"
        onClick={() => {
          if (disabled) return;
          handleKindChange(k);
        }}
        disabled={disabled}
        role="radio"
        aria-checked={selected}
        style={{
          textAlign: "left",
          width: "100%",
          display: "block",
          padding: "0.7rem 0.85rem",
          borderRadius: 8,
          border: selected
            ? "2px solid var(--accent, #3b82f6)"
            : "1px solid var(--border, #2a3447)",
          background: selected
            ? "rgba(59, 130, 246, 0.08)"
            : "var(--surface)",
          color: "inherit",
          font: "inherit",
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.45 : 1,
          marginLeft: opts?.indented ? 18 : 0,
        }}
        title={
          disabled
            ? "Manual roster uploads are disabled for this school."
            : undefined
        }
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            aria-hidden="true"
            style={{
              width: 15,
              height: 15,
              borderRadius: "50%",
              flexShrink: 0,
              boxSizing: "border-box",
              border: selected
                ? "5px solid var(--accent, #3b82f6)"
                : "2px solid var(--text-subtle, #64748b)",
            }}
          />
          <span style={{ fontWeight: 700, fontSize: 14 }}>{title}</span>
          {badge && !disabled && (
            <span
              style={{
                marginLeft: 2,
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.05em",
                textTransform: "uppercase",
                padding: "0.05rem 0.4rem",
                borderRadius: 999,
                background: "rgba(59, 130, 246, 0.16)",
                color: "var(--accent, #3b82f6)",
              }}
            >
              {badge}
            </span>
          )}
          {disabled && (
            <span
              style={{
                marginLeft: 2,
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.05em",
                textTransform: "uppercase",
                padding: "0.05rem 0.4rem",
                borderRadius: 999,
                background: "rgba(148, 163, 184, 0.2)",
                color: "var(--text-subtle)",
              }}
            >
              Off
            </span>
          )}
        </div>
        <div
          style={{
            fontSize: 12,
            color: "var(--text-subtle)",
            lineHeight: 1.4,
            marginTop: 4,
            marginLeft: 23,
          }}
        >
          {def.helpText}
        </div>
        {selected && !disabled && (
          <div
            style={{
              marginTop: "0.55rem",
              marginLeft: 23,
              paddingTop: "0.55rem",
              borderTop: "1px solid var(--border, #2a3447)",
              fontSize: 12.5,
              color: "var(--text)",
              lineHeight: 1.5,
            }}
          >
            {def.description}
          </div>
        )}
      </button>
    );
  };

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <h2 style={{ marginTop: 0 }}>Data Imports</h2>
      <p style={{ color: "var(--text-subtle)", marginTop: 0 }}>
        Upload roster, assessment, and behavior data from any CSV. The
        importer auto-detects column names — review the mapping, commit,
        and roll back from History if anything looks wrong.
      </p>
      <HowToUseHelp title="How to use Data Imports">
        <HowToSection title="The four-step import">
          <ul style={howtoListStyle}>
            <li><strong>Choose data type</strong> — assessment, roster, or behavior.</li>
            <li><strong>Drop the CSV</strong> — column names are auto-detected.</li>
            <li><strong>Preview</strong> — fix any column mappings; rows that won't import are flagged.</li>
            <li><strong>Commit</strong> — writes the rows. Every commit gets a History entry you can roll back.</li>
          </ul>
        </HowToSection>
        <HowToSection title="Common issues">
          <ul style={howtoListStyle}>
            <li><strong>Student-ID format</strong> — must match what the SIS export uses (most often the state-issued number).</li>
            <li><strong>Date columns</strong> — accepts ISO (YYYY-MM-DD) or US (MM/DD/YYYY); mixed formats fail per-row.</li>
            <li><strong>Empty cells</strong> — kept as null, not zero. Important for FAST scores.</li>
          </ul>
        </HowToSection>
        <RoleSection for={["admin", "coreTeam"]} title="Rollback safety">
          Every commit is reversible from the History tab. Roll back
          if the file was wrong — don't try to fix in place. A fresh
          import is always cleaner than a manual patch.
        </RoleSection>
      </HowToUseHelp>

      {canActAsDistrict && kindDef.supportsDistrict && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.75rem",
            marginTop: "0.75rem",
            padding: "0.6rem 0.75rem",
            background: "rgba(59, 130, 246, 0.06)",
            border: "1px solid var(--border, #2a3447)",
            borderRadius: 8,
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600 }}>Scope:</span>
          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            <input
              type="radio"
              name="data-imports-scope"
              checked={scope === "school"}
              onChange={() => handleScopeChange("school")}
            />
            My school only
          </label>
          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            <input
              type="radio"
              name="data-imports-scope"
              checked={scope === "district"}
              onChange={() => handleScopeChange("district")}
            />
            District-wide (rows routed by school code)
          </label>
          {scope === "district" && (
            <span
              style={{
                fontSize: 12,
                color: "var(--text-subtle)",
                marginLeft: "auto",
              }}
            >
              CSV must include a school_code column matching each school's
              state code or ID.
            </span>
          )}
        </div>
      )}

      <div
        style={{
          display: "flex",
          gap: 4,
          borderBottom: "1px solid var(--border, #2a3447)",
          marginTop: "1rem",
        }}
      >
        <button
          type="button"
          style={tabBtnStyle(tab === "upload")}
          onClick={() => setTab("upload")}
        >
          Upload
        </button>
        <button
          type="button"
          style={tabBtnStyle(tab === "history")}
          onClick={() => setTab("history")}
        >
          History
        </button>
      </div>

      {tab === "upload" && (
        <div style={{ marginTop: "1rem" }}>
          {/* File directions are kind-specific, so only show them once a
              data type has been chosen (step > 0). On the "Choose data"
              step they'd appear ABOVE the picker and users start reading
              upload instructions for a type they haven't selected yet. */}
          {step > 0 && <DirectionsPanel kind={kind} kindDef={kindDef} />}
          {commitResult ? (
            <div
              style={{
                padding: "1rem",
                background: "rgba(16, 185, 129, 0.1)",
                border: "1px solid #10b981",
                borderRadius: 8,
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: "0.5rem" }}>
                Import #{commitResult.jobId} committed.
              </div>
              <div style={{ fontSize: 14, color: "var(--text-subtle)" }}>
                {commitResult.successRows} of {commitResult.totalRows} rows
                inserted.
                {commitResult.errorRows > 0 && (
                  <>
                    {" "}
                    {commitResult.errorRows} skipped — see History for the
                    error log.
                  </>
                )}
              </div>
              <div
                style={{
                  marginTop: "0.75rem",
                  display: "flex",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                <button
                  type="button"
                  onClick={resetUpload}
                  style={{
                    padding: "0.5rem 1rem",
                    border: "1px solid var(--border, #2a3447)",
                    borderRadius: 6,
                    background: "var(--accent, #3b82f6)",
                    color: "white",
                    cursor: "pointer",
                    font: "inherit",
                  }}
                >
                  Upload another
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setTab("history");
                    resetUpload();
                  }}
                  style={{
                    padding: "0.5rem 1rem",
                    border: "1px solid var(--border, #2a3447)",
                    borderRadius: 6,
                    background: "transparent",
                    color: "inherit",
                    cursor: "pointer",
                    font: "inherit",
                  }}
                >
                  View history
                </button>
                {/* Universal undo — every committed job (including FAST,
                    now that import_job_id is tagged) supports rollback.
                    Same handler as the History tab; the confirm prompt
                    inside handleRollback prevents accidental clicks. */}
                <button
                  type="button"
                  onClick={() => handleRollback(commitResult.jobId)}
                  disabled={rollbackId === commitResult.jobId}
                  style={{
                    padding: "0.5rem 1rem",
                    border: "1px solid #ef4444",
                    borderRadius: 6,
                    background: "transparent",
                    color: "#ef4444",
                    cursor:
                      rollbackId === commitResult.jobId
                        ? "not-allowed"
                        : "pointer",
                    font: "inherit",
                    fontWeight: 600,
                    opacity: rollbackId === commitResult.jobId ? 0.5 : 1,
                    marginLeft: "auto",
                  }}
                  title="Roll back this import — every row it added or changed will be reverted."
                >
                  {rollbackId === commitResult.jobId
                    ? "Rolling back…"
                    : "Undo this import"}
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* Stepper bar — five chips mirroring NewCaseWizard.
                  Read-only; nav is via Back/Next buttons at the bottom
                  so the user can't skip past required gates. */}
              <div
                role="tablist"
                aria-label="Import wizard steps"
                style={{
                  display: "flex",
                  gap: 6,
                  flexWrap: "wrap",
                  alignItems: "center",
                  padding: "0.5rem 0.65rem",
                  border: "1px solid var(--border, #2a3447)",
                  borderRadius: 8,
                  background: "rgba(59, 130, 246, 0.04)",
                  marginBottom: "0.85rem",
                }}
              >
                {STEP_LABELS.map((label, i) => {
                  const active = step === i;
                  const done = step > i;
                  return (
                    <div
                      key={label}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "0.25rem 0.6rem",
                        borderRadius: 999,
                        background: active
                          ? "var(--accent, #3b82f6)"
                          : done
                            ? "rgba(16, 185, 129, 0.15)"
                            : "transparent",
                        color: active
                          ? "white"
                          : done
                            ? "#10b981"
                            : "var(--text-subtle)",
                        border:
                          active || done
                            ? "1px solid transparent"
                            : "1px solid var(--border, #2a3447)",
                        fontSize: 12,
                        fontWeight: active ? 700 : 500,
                      }}
                    >
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          width: 18,
                          height: 18,
                          borderRadius: "50%",
                          background: active
                            ? "rgba(255, 255, 255, 0.25)"
                            : done
                              ? "#10b981"
                              : "var(--border, #2a3447)",
                          color: active || done ? "white" : "inherit",
                          fontSize: 11,
                          fontWeight: 700,
                        }}
                      >
                        {done ? "✓" : i + 1}
                      </span>
                      <span>{label}</span>
                    </div>
                  );
                })}
              </div>

              {/* Step 0 — Choose data type. A single-column list: each row
                  is name + one-line summary; the selected row expands to
                  show the full definition inline. One picker only (the old
                  persistent "Data type" row above the wizard was removed)
                  so the choice is never made twice. The Roster row shows a
                  disabled "Off" affordance when the per-school toggle is
                  OFF, with an inline explainer below. */}
              {step === 0 && (
                <div>
                  <div
                    role="radiogroup"
                    aria-label="Data type"
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "1.15rem",
                      marginBottom: "0.85rem",
                    }}
                  >
                    {KIND_GROUPS.map((group) => {
                      const groupKinds = group.kinds.filter((k) =>
                        visibleKinds.includes(k),
                      );
                      if (groupKinds.length === 0) return null;
                      const primary =
                        group.primary && groupKinds.includes(group.primary)
                          ? group.primary
                          : groupKinds[0];
                      const rest = groupKinds.filter((k) => k !== primary);
                      // A fallback being selected forces the disclosure open
                      // so the current choice is always visible.
                      const restSelected = rest.includes(kind);
                      const altOpen = restSelected || showFastAlt;
                      return (
                        <div key={group.title}>
                          <div
                            style={{
                              fontSize: 11,
                              fontWeight: 700,
                              letterSpacing: "0.05em",
                              textTransform: "uppercase",
                              color: "var(--text-subtle)",
                              marginBottom: 2,
                            }}
                          >
                            {group.title}
                          </div>
                          <div
                            style={{
                              fontSize: 12,
                              color: "var(--text-subtle)",
                              lineHeight: 1.4,
                              marginBottom: 8,
                              opacity: 0.9,
                            }}
                          >
                            {group.caption}
                          </div>
                          <div
                            style={{
                              display: "flex",
                              flexDirection: "column",
                              gap: "0.5rem",
                            }}
                          >
                            {renderKindRow(primary)}
                            {rest.length > 0 && altOpen &&
                              rest.map((k) =>
                                renderKindRow(k, { indented: true }),
                              )}
                            {rest.length > 0 && !restSelected && (
                              <button
                                type="button"
                                onClick={() =>
                                  setShowFastAlt((v) => !v)
                                }
                                style={{
                                  alignSelf: "flex-start",
                                  marginLeft: 18,
                                  background: "transparent",
                                  border: "none",
                                  padding: "0.15rem 0",
                                  fontSize: 12.5,
                                  fontWeight: 600,
                                  color: "var(--accent, #3b82f6)",
                                  cursor: "pointer",
                                }}
                              >
                                {showFastAlt
                                  ? "Show fewer options"
                                  : `Other ways to import FAST (${rest.length}) ▾`}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {kind === "rosters" && rosterEnabled === false && (
                    <div
                      style={{
                        padding: "0.75rem",
                        background: "rgba(245, 158, 11, 0.1)",
                        border: "1px solid #f59e0b",
                        borderRadius: 6,
                        fontSize: 13,
                        marginBottom: "0.85rem",
                      }}
                    >
                      Manual roster uploads are disabled for this school.
                      Most schools sync their roster from Classlink or
                      Clever (OneRoster) so this stays off by default. An
                      admin can enable it in <strong>School Settings →
                      Data &amp; Integrations</strong>.
                    </div>
                  )}
                  {canActAsDistrict && kindDef.supportsDistrict && (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.75rem",
                        padding: "0.6rem 0.75rem",
                        background: "rgba(59, 130, 246, 0.06)",
                        border: "1px solid var(--border, #2a3447)",
                        borderRadius: 8,
                        flexWrap: "wrap",
                      }}
                    >
                      <span style={{ fontSize: 13, fontWeight: 600 }}>
                        Scope:
                      </span>
                      <label
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                          fontSize: 13,
                          cursor: "pointer",
                        }}
                      >
                        <input
                          type="radio"
                          name="data-imports-scope-step0"
                          checked={scope === "school"}
                          onChange={() => handleScopeChange("school")}
                        />
                        My school only
                      </label>
                      <label
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                          fontSize: 13,
                          cursor: "pointer",
                        }}
                      >
                        <input
                          type="radio"
                          name="data-imports-scope-step0"
                          checked={scope === "district"}
                          onChange={() => handleScopeChange("district")}
                        />
                        District-wide (rows routed by school code)
                      </label>
                      {scope === "district" && (
                        <span
                          style={{
                            fontSize: 12,
                            color: "var(--text-subtle)",
                            marginLeft: "auto",
                          }}
                        >
                          CSV must include a school_code column matching
                          each school's state code or ID.
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Step 1 — Upload CSV. Drop zone if no file yet, filename
                  pill + cancel if a file is already loaded. A small
                  "Download sample CSV" link sits above the drop zone so
                  a first-time user can grab a known-good template,
                  replace the single seeded row with their real data,
                  and re-upload. */}
              {step === 1 && (
                <div>
                  {(() => {
                    const SAMPLES: Record<Kind, { file: string; label: string }> = {
                      assessments: {
                        file: "pulseedu-assessments-sample.csv",
                        label: "Sample assessments CSV",
                      },
                      rosters: {
                        file: "pulseedu-roster-sample.csv",
                        label: "Sample roster CSV",
                      },
                      behavior: {
                        file: "pulseedu-behavior-sample.csv",
                        label: "Sample behavior notes CSV",
                      },
                      fast_scores: {
                        file: "pulseedu-fast-sample.csv",
                        label: "Sample FAST scores CSV",
                      },
                      fast_prior_year: {
                        file: "pulseedu-fast-prior-year-sample.csv",
                        label: "Sample FAST prior-year CSV",
                      },
                      bq_l25: {
                        file: "pulseedu-bq-l25-sample.csv",
                        label: "Sample Bottom-Quartile / L25 CSV",
                      },
                      // Florida xlsx has no sample we can ship — admins
                      // supply their own state-portal export. The
                      // download bar below is conditionally hidden for
                      // this kind via the `sample` null-check.
                      fast_florida: null as unknown as {
                        file: string;
                        label: string;
                      },
                      // Points migration files are exports from another PBIS
                      // platform (LiveSchool/ClassDojo/etc.) — admins supply
                      // their own, so there is no sample to ship.
                      points_migration: null as unknown as {
                        file: string;
                        label: string;
                      },
                      // Gradebook is a fixed-layout SIS xlsx export —
                      // admins supply their own Live Grade Report, so
                      // there is no sample to ship.
                      gradebook: null as unknown as {
                        file: string;
                        label: string;
                      },
                    };
                    const sample = SAMPLES[kind];
                    if (!sample) return null;
                    return (
                      <div
                        style={{
                          marginBottom: "0.75rem",
                          padding: "0.6rem 0.8rem",
                          border: "1px dashed var(--border, #2a3447)",
                          borderRadius: 8,
                          display: "flex",
                          alignItems: "center",
                          gap: "0.6rem",
                          fontSize: 13,
                          color: "var(--text-subtle)",
                        }}
                      >
                        <span style={{ fontSize: 16 }}>📄</span>
                        <div style={{ flex: 1 }}>
                          New here? Download the {sample.label}, replace
                          the example row with your own data, save, and
                          drop it back in below.
                        </div>
                        <a
                          href={`${import.meta.env.BASE_URL}samples/${sample.file}`}
                          download={sample.file}
                          style={{
                            padding: "0.35rem 0.7rem",
                            border: "1px solid var(--border, #2a3447)",
                            borderRadius: 6,
                            textDecoration: "none",
                            color: "inherit",
                            fontSize: 13,
                            whiteSpace: "nowrap",
                          }}
                        >
                          Download sample
                        </a>
                      </div>
                    );
                  })()}
                  {preview ? (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.75rem",
                        padding: "0.75rem",
                        border: "1px solid #10b981",
                        borderRadius: 8,
                        background: "rgba(16, 185, 129, 0.05)",
                      }}
                    >
                      <span style={{ fontSize: 22 }}>✓</span>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600 }}>{filename}</div>
                        <div
                          style={{
                            color: "var(--text-subtle)",
                            fontSize: 13,
                          }}
                        >
                          {preview.totalRows} rows parsed. Click Next to
                          map columns.
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={resetUpload}
                        style={{
                          padding: "0.35rem 0.75rem",
                          border: "1px solid var(--border, #2a3447)",
                          borderRadius: 6,
                          background: "transparent",
                          color: "inherit",
                          cursor: "pointer",
                          font: "inherit",
                          fontSize: 13,
                        }}
                      >
                        Choose a different file
                      </button>
                    </div>
                  ) : (
                    <div
                      style={dragActive ? dropZoneActiveStyle : dropZoneStyle}
                      onDragOver={(e) => {
                        e.preventDefault();
                        setDragActive(true);
                      }}
                      onDragLeave={() => setDragActive(false)}
                      onDrop={onDrop}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <div style={{ fontSize: 32, marginBottom: "0.5rem" }}>
                        📥
                      </div>
                      <div style={{ fontWeight: 600 }}>
                        Drop a CSV file here, or click to choose
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          color: "var(--text-subtle)",
                          marginTop: "0.5rem",
                        }}
                      >
                        Up to 10 MB. First row should be column headers.
                      </div>
                      {previewing && (
                        <div style={{ marginTop: "0.75rem", fontSize: 14 }}>
                          Parsing…
                        </div>
                      )}
                    </div>
                  )}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={
                      kind === "fast_florida" || kind === "gradebook"
                        ? ".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                        : ".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                    }
                    style={{ display: "none" }}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void handleFile(f);
                    }}
                  />
                  {/* Florida xlsx school-year picker. Sits below the
                      drop zone so it's visible whether or not a file
                      is already loaded. The current year plus three
                      prior years are accepted (mirrors the server
                      validateSchoolYearLabel). */}
                  {kind === "fast_florida" && (
                    <div
                      style={{
                        marginTop: "0.75rem",
                        padding: "0.75rem",
                        border: "1px solid var(--border, #2a3447)",
                        borderRadius: 8,
                        display: "flex",
                        alignItems: "center",
                        gap: "0.75rem",
                        fontSize: 13,
                      }}
                    >
                      <label
                        htmlFor="fast-florida-school-year"
                        style={{ fontWeight: 600 }}
                      >
                        School year:
                      </label>
                      <select
                        id="fast-florida-school-year"
                        value={selectedSchoolYear}
                        onChange={(e) => {
                          const nextYear = e.target.value;
                          setSelectedSchoolYear(nextYear);
                          // Re-preview against the new year — the server
                          // re-validates the label and the operator
                          // sees row counts before committing.
                          if (xlsxBase64)
                            void runPreview("", {}, {
                              xlsxBase64,
                              schoolYear: nextYear,
                            });
                        }}
                        style={{
                          padding: "0.4rem 0.6rem",
                          border: "1px solid var(--border, #2a3447)",
                          borderRadius: 6,
                          background: "var(--surface)",
                          color: "inherit",
                          font: "inherit",
                          fontSize: 13,
                        }}
                      >
                        <option value="">— pick a year —</option>
                        {floridaSchoolYearOptions().map((y) => (
                          <option key={y} value={y}>
                            20{y.slice(0, 2)}–20{y.slice(3, 5)}
                          </option>
                        ))}
                      </select>
                      <span style={{ color: "var(--text-subtle)" }}>
                        Pick the year these scores belong to. Use the
                        current year for a fresh PM; pick a prior year
                        to back-fill.
                      </span>
                      {/* Historical back-fill toggle. PM3-only is
                          enforced server-side; the helper text below
                          explains why. */}
                      <label
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          marginLeft: "auto",
                          fontSize: 12,
                          color: "var(--text-subtle)",
                        }}
                        title="Tag this import as historical back-fill. File must contain PM3 scores only. Used for multi-year FAST trajectory + Algebra I placement review."
                      >
                        <input
                          type="checkbox"
                          checked={isHistoricalImport}
                          onChange={(e) =>
                            setIsHistoricalImport(e.target.checked)
                          }
                        />
                        Import as historical (PM3-only back-fill)
                      </label>
                    </div>
                  )}
                  {/* Gradebook xlsx — quarter + effective-date pickers.
                      Mirrors the Florida year picker: sits below the drop
                      zone, re-previews on change so counts stay honest. */}
                  {kind === "gradebook" && (
                    <div
                      style={{
                        marginTop: "0.75rem",
                        padding: "0.75rem",
                        border: "1px solid var(--border, #2a3447)",
                        borderRadius: 8,
                        display: "flex",
                        alignItems: "center",
                        flexWrap: "wrap",
                        gap: "0.75rem",
                        fontSize: 13,
                      }}
                    >
                      <label
                        htmlFor="gradebook-quarter"
                        style={{ fontWeight: 600 }}
                      >
                        Quarter:
                      </label>
                      <select
                        id="gradebook-quarter"
                        value={gradebookQuarter}
                        onChange={(e) => {
                          const q = e.target.value as
                            | "Q1"
                            | "Q2"
                            | "Q3"
                            | "Q4";
                          setGradebookQuarter(q);
                          if (xlsxBase64)
                            void runPreview("", {}, {
                              xlsxBase64,
                              quarter: q,
                              effectiveDate: gradebookDate,
                            });
                        }}
                        style={{
                          padding: "0.4rem 0.6rem",
                          border: "1px solid var(--border, #2a3447)",
                          borderRadius: 6,
                          background: "var(--surface)",
                          color: "inherit",
                          font: "inherit",
                          fontSize: 13,
                        }}
                      >
                        <option value="Q1">Q1</option>
                        <option value="Q2">Q2</option>
                        <option value="Q3">Q3</option>
                        <option value="Q4">Q4</option>
                      </select>
                      <label
                        htmlFor="gradebook-date"
                        style={{ fontWeight: 600 }}
                      >
                        Effective date:
                      </label>
                      <input
                        id="gradebook-date"
                        type="date"
                        value={gradebookDate}
                        onChange={(e) => {
                          const d = e.target.value;
                          setGradebookDate(d);
                          if (xlsxBase64)
                            void runPreview("", {}, {
                              xlsxBase64,
                              quarter: gradebookQuarter,
                              effectiveDate: d,
                            });
                        }}
                        style={{
                          padding: "0.4rem 0.6rem",
                          border: "1px solid var(--border, #2a3447)",
                          borderRadius: 6,
                          background: "var(--surface)",
                          color: "inherit",
                          font: "inherit",
                          fontSize: 13,
                        }}
                      />
                      <span style={{ color: "var(--text-subtle)" }}>
                        Which quarter these grades currently represent. The
                        current grade per course uses this quarter, falling
                        back to the latest populated quarter.
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* Step 2 — Map columns. Templates bar + per-header
                  dropdowns + missing-required warning. Gated on having
                  a preview from step 1. */}
              {step === 2 && preview && (
                <div>
                  <h3 style={{ marginTop: 0, marginBottom: "0.5rem" }}>
                    Column mapping
                  </h3>
                  <p
                    style={{
                      marginTop: 0,
                      fontSize: 13,
                      color: "var(--text-subtle)",
                    }}
                  >
                    We guessed how each CSV column maps to our fields.
                    Override any row, or set a column to "Ignore" to drop
                    it.
                  </p>

                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.5rem",
                      marginBottom: "0.75rem",
                      flexWrap: "wrap",
                    }}
                  >
                    <span style={{ fontSize: 13, fontWeight: 600 }}>
                      Templates:
                    </span>
                    <select
                      value=""
                      onChange={(e) => {
                        const v = parseInt(e.target.value, 10);
                        if (Number.isFinite(v) && v > 0) applyTemplate(v);
                      }}
                      disabled={
                        templatesLoading || templates.length === 0
                      }
                      style={{
                        padding: "0.3rem 0.5rem",
                        background: "var(--surface)",
                        color: "inherit",
                        border: "1px solid var(--border, #2a3447)",
                        borderRadius: 6,
                        font: "inherit",
                        fontSize: 13,
                        minWidth: 200,
                      }}
                    >
                      <option value="">
                        {templatesLoading
                          ? "Loading…"
                          : templates.length === 0
                            ? "No saved templates"
                            : "Apply a saved template…"}
                      </option>
                      {templates.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}{" "}
                          {t.scope === "district" ? "🏛 District" : ""}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={handleSaveTemplate}
                      disabled={
                        savingTemplate ||
                        Object.keys(mapping).length === 0
                      }
                      style={{
                        padding: "0.3rem 0.75rem",
                        border: "1px solid var(--border, #2a3447)",
                        borderRadius: 6,
                        background: "transparent",
                        color: "inherit",
                        cursor:
                          savingTemplate ||
                          Object.keys(mapping).length === 0
                            ? "not-allowed"
                            : "pointer",
                        font: "inherit",
                        fontSize: 13,
                        opacity:
                          savingTemplate ||
                          Object.keys(mapping).length === 0
                            ? 0.5
                            : 1,
                      }}
                      title={
                        scope === "district"
                          ? "Saved as a district-wide template (visible to every school in your district)"
                          : "Saved as a template for your school"
                      }
                    >
                      {savingTemplate
                        ? "Saving…"
                        : "Save current as template"}
                    </button>
                    {templates.length > 0 && (
                      <details style={{ marginLeft: "auto" }}>
                        <summary
                          style={{
                            cursor: "pointer",
                            fontSize: 12,
                            color: "var(--text-subtle)",
                          }}
                        >
                          Manage ({templates.length})
                        </summary>
                        <ul
                          style={{
                            marginTop: "0.4rem",
                            paddingLeft: "1.25rem",
                            fontSize: 13,
                          }}
                        >
                          {templates.map((t) => (
                            <li key={t.id} style={{ marginBottom: 4 }}>
                              {t.name}{" "}
                              <span
                                style={{
                                  color: "var(--text-subtle)",
                                  fontSize: 11,
                                }}
                              >
                                ({t.scope})
                              </span>{" "}
                              <button
                                type="button"
                                onClick={() =>
                                  handleDeleteTemplate(t.id, t.name)
                                }
                                style={{
                                  padding: "0.1rem 0.4rem",
                                  border: "1px solid #ef4444",
                                  background: "transparent",
                                  color: "#ef4444",
                                  borderRadius: 4,
                                  fontSize: 11,
                                  cursor: "pointer",
                                  marginLeft: 4,
                                }}
                              >
                                Delete
                              </button>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      gap: "0.5rem",
                      marginBottom: "1rem",
                    }}
                  >
                    {preview.headers.map((h) => (
                      <div
                        key={h}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "0.5rem",
                          padding: "0.5rem",
                          border: "1px solid var(--border, #2a3447)",
                          borderRadius: 6,
                        }}
                      >
                        <span
                          style={{
                            fontFamily: "monospace",
                            fontSize: 13,
                            flex: 1,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {h}
                        </span>
                        <span style={{ color: "var(--text-subtle)" }}>
                          →
                        </span>
                        <select
                          value={mapping[h] ?? IGNORE_VALUE}
                          onChange={(e) =>
                            handleMappingChange(h, e.target.value)
                          }
                          style={{
                            flex: 1,
                            padding: "0.25rem",
                            background: "var(--surface)",
                            color: "inherit",
                            border: "1px solid var(--border, #2a3447)",
                            borderRadius: 4,
                            font: "inherit",
                            fontSize: 13,
                          }}
                        >
                          <option value={IGNORE_VALUE}>Ignore</option>
                          {targets.map((t) => (
                            <option key={t.value} value={t.value}>
                              {t.label}
                              {t.required ? " *" : ""}
                            </option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>

                  {missingRequired.length > 0 && (
                    <div
                      style={{
                        padding: "0.75rem",
                        background: "rgba(245, 158, 11, 0.1)",
                        border: "1px solid #f59e0b",
                        borderRadius: 6,
                        fontSize: 14,
                        marginBottom: "1rem",
                      }}
                    >
                      Missing required fields: {missingRequired.join(", ")}.
                      Map at least one CSV column to each.
                    </div>
                  )}
                </div>
              )}

              {/* Step 3 — Preview counts + sample rows + skipped errors.
                  This is the last chance to read what's about to land
                  before the type-echo gate on step 4. */}
              {step === 3 && preview && (
                <div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.75rem",
                      marginBottom: "1rem",
                      flexWrap: "wrap",
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>{filename}</span>
                    <span
                      style={{
                        color: "var(--text-subtle)",
                        fontSize: 14,
                      }}
                    >
                      · {preview.totalRows} rows
                    </span>
                  </div>

                  <div
                    style={{
                      display: "flex",
                      gap: "1rem",
                      marginBottom: "1rem",
                      flexWrap: "wrap",
                    }}
                  >
                    <Stat label="Total" value={preview.totalRows} />
                    <Stat
                      label="Will import"
                      value={preview.validRows}
                      accent
                    />
                    <Stat label="Will skip" value={preview.errorRows} warn />
                    {kind === "fast_florida" &&
                      typeof preview.totalItems === "number" && (
                        <Stat
                          label="Will import items"
                          value={preview.totalItems}
                          accent
                        />
                      )}
                    {scope === "district" && preview.perSchool && (
                      <Stat
                        label="Schools matched"
                        value={preview.perSchool.length}
                      />
                    )}
                  </div>

                  {/* Roster-only: non-blocking warning when one or more
                      house_name cells didn't match a configured house.
                      Those rows still commit (smallest-house fallback in
                      insertChunk), but admins deserve a heads-up so they
                      can fix typos before the data lands rebalanced. */}
                  {kind === "rosters" && preview.unrecognizedHouseNames && (
                    <div
                      style={{
                        padding: "0.6rem 0.75rem",
                        background: "rgba(245, 158, 11, 0.08)",
                        border: "1px solid #f59e0b",
                        borderRadius: 6,
                        fontSize: 13,
                        marginBottom: "1rem",
                      }}
                    >
                      <div style={{ marginBottom: 4 }}>
                        <strong>
                          {preview.unrecognizedHouseNames.rowCount} row
                          {preview.unrecognizedHouseNames.rowCount === 1
                            ? ""
                            : "s"}{" "}
                          had a house name we didn't recognize;
                        </strong>{" "}
                        {preview.unrecognizedHouseNames.policy === "strict"
                          ? "they will be skipped (strict house-name matching is on for this school)."
                          : "they will use the smallest-house default."}
                      </div>
                      <div style={{ color: "var(--text-subtle)" }}>
                        Unrecognized:{" "}
                        {preview.unrecognizedHouseNames.samples
                          .map((s) =>
                            s.suggestion
                              ? `"${s.value}" (did you mean "${s.suggestion}"?)`
                              : `"${s.value}"`,
                          )
                          .join(", ")}
                        {preview.unrecognizedHouseNames.distinctCount >
                          preview.unrecognizedHouseNames.samples.length && (
                          <>
                            {" "}
                            +{" "}
                            {preview.unrecognizedHouseNames.distinctCount -
                              preview.unrecognizedHouseNames.samples
                                .length}{" "}
                            more
                          </>
                        )}
                        . Check spelling, or add the house in PBIS Hub →
                        Houses before committing.
                      </div>
                    </div>
                  )}

                  {/* Roster-only reassurance: upsert semantics mean the
                      commit will only touch student_ids that appear in
                      the CSV. Every other row stays untouched. */}
                  {kind === "rosters" && (
                    <div
                      style={{
                        padding: "0.6rem 0.75rem",
                        background: "rgba(59, 130, 246, 0.06)",
                        border: "1px solid #3b82f6",
                        borderRadius: 6,
                        fontSize: 13,
                        marginBottom: "1rem",
                      }}
                    >
                      <strong>Heads up:</strong> Roster commits only touch
                      student IDs present in this CSV. Existing students
                      not mentioned will <strong>NOT</strong> be removed
                      or changed. Blank cells preserve current values
                      (COALESCE), so partial files are safe.
                    </div>
                  )}

                  {/* points_migration only: match summary + the per-import
                      behavior toggle (store-only vs count-as-earned) and a
                      source label. The toggle is the heart of this importer
                      — it decides whether migrated points stay out of the
                      house race or land as real recognitions. */}
                  {kind === "points_migration" && (
                    <>
                      {preview.pointsMigration && (
                        <div
                          style={{
                            display: "flex",
                            gap: "1rem",
                            marginBottom: "1rem",
                            flexWrap: "wrap",
                          }}
                        >
                          <Stat
                            label="Students matched"
                            value={preview.pointsMigration.matched}
                            accent
                          />
                          <Stat
                            label="No match (skip)"
                            value={preview.pointsMigration.unmatched}
                            warn
                          />
                          <Stat
                            label="Points to migrate"
                            value={preview.pointsMigration.totalPoints}
                          />
                        </div>
                      )}
                      <div
                        style={{
                          padding: "0.75rem 0.85rem",
                          background: "rgba(59, 130, 246, 0.06)",
                          border: "1px solid #3b82f6",
                          borderRadius: 6,
                          marginBottom: "1rem",
                        }}
                      >
                        <div
                          style={{ fontWeight: 600, marginBottom: "0.5rem" }}
                        >
                          How should these points behave?
                        </div>
                        <label
                          style={{
                            display: "flex",
                            gap: "0.5rem",
                            alignItems: "flex-start",
                            marginBottom: "0.5rem",
                            cursor: "pointer",
                          }}
                        >
                          <input
                            type="radio"
                            name="pmBehavior"
                            checked={!pmCountsTowardHouses}
                            onChange={() => setPmCountsTowardHouses(false)}
                            style={{ marginTop: 3 }}
                          />
                          <span style={{ fontSize: 13 }}>
                            <strong>Store balance only</strong>{" "}
                            <span style={{ color: "var(--text-subtle)" }}>
                              (recommended)
                            </span>
                            <br />
                            Spendable in the School Store, but{" "}
                            <strong>excluded</strong> from house standings,
                            leaderboards, and recognition counts.
                          </span>
                        </label>
                        <label
                          style={{
                            display: "flex",
                            gap: "0.5rem",
                            alignItems: "flex-start",
                            cursor: "pointer",
                          }}
                        >
                          <input
                            type="radio"
                            name="pmBehavior"
                            checked={pmCountsTowardHouses}
                            onChange={() => setPmCountsTowardHouses(true)}
                            style={{ marginTop: 3 }}
                          />
                          <span style={{ fontSize: 13 }}>
                            <strong>Count as earned</strong>
                            <br />
                            Written as real PulseEDU recognitions — these{" "}
                            <strong>do</strong> count toward houses,
                            leaderboards, and totals.
                          </span>
                        </label>
                        <div
                          style={{
                            marginTop: "0.75rem",
                            display: "flex",
                            flexDirection: "column",
                            gap: "0.25rem",
                          }}
                        >
                          <label
                            htmlFor="pm-source"
                            style={{ fontSize: 13, fontWeight: 600 }}
                          >
                            Source label
                          </label>
                          <input
                            id="pm-source"
                            type="text"
                            value={pmSource}
                            onChange={(e) => setPmSource(e.target.value)}
                            placeholder="e.g. LiveSchool"
                            maxLength={80}
                            style={{
                              padding: "0.4rem 0.55rem",
                              borderRadius: 6,
                              border: "1px solid var(--border, #2a3447)",
                              background: "var(--surface, #0f1729)",
                              color: "var(--text)",
                              fontSize: 13,
                              maxWidth: 280,
                            }}
                          />
                          <span
                            style={{
                              fontSize: 12,
                              color: "var(--text-subtle)",
                            }}
                          >
                            Shown in PBIS history so staff know where the
                            balance came from.
                          </span>
                        </div>
                      </div>
                    </>
                  )}

                  {scope === "district" &&
                    preview.perSchool &&
                    preview.perSchool.length > 0 && (
                      <details style={{ marginBottom: "1rem" }}>
                        <summary
                          style={{ cursor: "pointer", fontWeight: 600 }}
                        >
                          Per-school breakdown — {preview.perSchool.length}{" "}
                          school
                          {preview.perSchool.length === 1 ? "" : "s"} matched
                          {typeof preview.districtSchoolCount ===
                            "number" && (
                            <span
                              style={{
                                color: "var(--text-subtle)",
                                fontWeight: 400,
                                marginLeft: 6,
                              }}
                            >
                              (of {preview.districtSchoolCount} in district)
                            </span>
                          )}
                        </summary>
                        <div
                          style={{
                            marginTop: "0.5rem",
                            overflowX: "auto",
                          }}
                        >
                          <table
                            className="pulse-table"
                            style={{
                              width: "100%",
                              borderCollapse: "collapse",
                              fontSize: 13,
                            }}
                          >
                            <thead>
                              <tr>
                                <th
                                  style={{
                                    textAlign: "left",
                                    padding: "0.35rem",
                                    borderBottom:
                                      "1px solid var(--border, #2a3447)",
                                  }}
                                >
                                  School
                                </th>
                                <th
                                  style={{
                                    textAlign: "right",
                                    padding: "0.35rem",
                                    borderBottom:
                                      "1px solid var(--border, #2a3447)",
                                  }}
                                >
                                  Rows
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {preview.perSchool.map((s) => (
                                <tr key={s.schoolId}>
                                  <td style={{ padding: "0.35rem" }}>
                                    {s.schoolName}
                                  </td>
                                  <td
                                    style={{
                                      padding: "0.35rem",
                                      textAlign: "right",
                                      fontVariantNumeric: "tabular-nums",
                                    }}
                                  >
                                    {s.rows.toLocaleString()}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </details>
                    )}

                  {preview.sampleRows.length > 0 && (
                    <details style={{ marginBottom: "1rem" }}>
                      <summary
                        style={{ cursor: "pointer", fontWeight: 600 }}
                      >
                        Preview first {preview.sampleRows.length} rows
                      </summary>
                      <div
                        style={{
                          marginTop: "0.5rem",
                          overflowX: "auto",
                        }}
                      >
                        <table
                          className="pulse-table"
                          style={{
                            width: "100%",
                            borderCollapse: "collapse",
                            fontSize: 13,
                          }}
                        >
                          <thead>
                            <tr>
                              {[
                                "Student",
                                "Assessment",
                                "Score",
                                "Level",
                                "Date",
                                "Source",
                              ].map((h) => (
                                <th
                                  key={h}
                                  style={{
                                    textAlign: "left",
                                    padding: "0.35rem",
                                    borderBottom:
                                      "1px solid var(--border, #2a3447)",
                                  }}
                                >
                                  {h}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {preview.sampleRows.map((r, i) => (
                              <tr key={i}>
                                <td style={{ padding: "0.35rem" }}>
                                  {r.studentId}
                                </td>
                                <td style={{ padding: "0.35rem" }}>
                                  {r.assessmentName}
                                </td>
                                <td style={{ padding: "0.35rem" }}>
                                  {r.score ?? "—"}
                                </td>
                                <td style={{ padding: "0.35rem" }}>
                                  {r.scoreLevel ?? "—"}
                                </td>
                                <td style={{ padding: "0.35rem" }}>
                                  {new Date(
                                    r.administeredAt,
                                  ).toLocaleDateString()}
                                </td>
                                <td style={{ padding: "0.35rem" }}>
                                  {r.source ?? "—"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </details>
                  )}

                  {preview.errors.length > 0 && (
                    <details style={{ marginBottom: "1rem" }}>
                      <summary
                        style={{
                          cursor: "pointer",
                          fontWeight: 600,
                          color: "#f59e0b",
                        }}
                      >
                        {preview.errorRows} skipped row
                        {preview.errorRows === 1 ? "" : "s"} — show errors
                      </summary>
                      <ul
                        style={{
                          marginTop: "0.5rem",
                          paddingLeft: "1.25rem",
                          fontSize: 13,
                        }}
                      >
                        {preview.errors.map((e, i) => (
                          <li key={i}>
                            Row {e.row}: {e.message}
                          </li>
                        ))}
                        {preview.errorRows > preview.errors.length && (
                          <li
                            style={{
                              color: "var(--text-subtle)",
                              listStyle: "none",
                            }}
                          >
                            … and{" "}
                            {preview.errorRows - preview.errors.length} more.
                          </li>
                        )}
                      </ul>
                    </details>
                  )}
                </div>
              )}

              {/* Step 4 — Confirm. Type-echo gate before commit, mirrors
                  NewCaseWizard. The echo word matches the kind family
                  ("FAST" covers both fast_scores and fast_prior_year). */}
              {step === 4 && preview && (
                <div>
                  <div
                    style={{
                      padding: "0.85rem",
                      border: "1px solid var(--border, #2a3447)",
                      borderRadius: 8,
                      marginBottom: "1rem",
                      background: "var(--surface)",
                    }}
                  >
                    <div
                      style={{
                        fontWeight: 700,
                        fontSize: 15,
                        marginBottom: 6,
                      }}
                    >
                      Ready to commit
                    </div>
                    <div
                      style={{
                        fontSize: 13,
                        color: "var(--text-subtle)",
                        lineHeight: 1.5,
                      }}
                    >
                      <strong>{kindDef.label}</strong> · {filename} ·{" "}
                      <strong>{preview.validRows}</strong> row
                      {preview.validRows === 1 ? "" : "s"} will import
                      {preview.errorRows > 0 && (
                        <>
                          ; <strong>{preview.errorRows}</strong> will be
                          skipped
                        </>
                      )}
                      .{" "}
                      {scope === "district"
                        ? "Rows will be routed to schools by school_code."
                        : "All rows will land in your school."}
                    </div>
                    <div
                      style={{
                        marginTop: 8,
                        fontSize: 12,
                        color: "var(--text-subtle)",
                      }}
                    >
                      Every commit gets a History entry with one-click
                      Undo, so a bad import is recoverable.
                    </div>
                  </div>

                  <label
                    style={{
                      display: "grid",
                      gap: 6,
                      marginBottom: "1rem",
                    }}
                  >
                    <span style={{ fontSize: 13, fontWeight: 600 }}>
                      Type{" "}
                      <code
                        style={{
                          padding: "0.05rem 0.4rem",
                          background: "rgba(59, 130, 246, 0.15)",
                          color: "#3b82f6",
                          borderRadius: 4,
                          fontFamily: "monospace",
                          fontSize: 13,
                        }}
                      >
                        {echoWord}
                      </code>{" "}
                      to confirm.
                    </span>
                    <input
                      type="text"
                      value={confirmEcho}
                      onChange={(e) => setConfirmEcho(e.target.value)}
                      placeholder={echoWord}
                      autoComplete="off"
                      spellCheck={false}
                      style={{
                        padding: "0.5rem 0.65rem",
                        background: "var(--surface)",
                        color: "inherit",
                        border: "1px solid var(--border, #2a3447)",
                        borderRadius: 6,
                        font: "inherit",
                        fontSize: 14,
                        fontFamily: "monospace",
                        letterSpacing: "0.05em",
                      }}
                    />
                  </label>

                  <button
                    type="button"
                    onClick={handleCommit}
                    disabled={
                      committing ||
                      !preview.readyToCommit ||
                      preview.validRows === 0 ||
                      confirmEcho.trim().toUpperCase() !== echoWord
                    }
                    style={{
                      padding: "0.65rem 1.25rem",
                      border: "1px solid var(--border, #2a3447)",
                      borderRadius: 6,
                      background:
                        committing ||
                        !preview.readyToCommit ||
                        confirmEcho.trim().toUpperCase() !== echoWord
                          ? "var(--border, #2a3447)"
                          : "var(--accent, #3b82f6)",
                      color: "white",
                      font: "inherit",
                      fontWeight: 600,
                      cursor:
                        committing ||
                        !preview.readyToCommit ||
                        confirmEcho.trim().toUpperCase() !== echoWord
                          ? "not-allowed"
                          : "pointer",
                      opacity:
                        committing ||
                        !preview.readyToCommit ||
                        confirmEcho.trim().toUpperCase() !== echoWord
                          ? 0.6
                          : 1,
                    }}
                  >
                    {committing
                      ? "Importing…"
                      : `Commit ${preview.validRows} row${preview.validRows === 1 ? "" : "s"}`}
                  </button>
                </div>
              )}

              {/* Inline error always visible at the bottom of any step
                  so failed previews / commits show up no matter where
                  the user is in the wizard. */}
              {error && (
                <div
                  style={{
                    marginTop: "1rem",
                    padding: "0.75rem",
                    background: "rgba(239, 68, 68, 0.1)",
                    border: "1px solid #ef4444",
                    borderRadius: 6,
                    fontSize: 14,
                  }}
                >
                  {error}
                </div>
              )}

              {/* Step nav. Step 4 has its own Commit button so we hide
                  Next there. Cancel-equivalent is the History tab plus
                  resetUpload — there's no destructive state to lose. */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginTop: "1.25rem",
                  paddingTop: "0.75rem",
                  borderTop: "1px solid var(--border, #2a3447)",
                }}
              >
                <button
                  type="button"
                  onClick={goBack}
                  disabled={step === 0}
                  style={{
                    padding: "0.5rem 1rem",
                    border: "1px solid var(--border, #2a3447)",
                    borderRadius: 6,
                    background: "transparent",
                    color: "inherit",
                    cursor: step === 0 ? "not-allowed" : "pointer",
                    font: "inherit",
                    opacity: step === 0 ? 0.4 : 1,
                  }}
                >
                  ← Back
                </button>
                <span
                  style={{
                    fontSize: 12,
                    color: "var(--text-subtle)",
                    marginLeft: "auto",
                  }}
                >
                  Step {step + 1} of {STEP_LABELS.length}
                </span>
                {step < 4 && (
                  <button
                    type="button"
                    onClick={goNext}
                    disabled={!canAdvance()}
                    style={{
                      padding: "0.5rem 1rem",
                      border: "1px solid var(--border, #2a3447)",
                      borderRadius: 6,
                      background: canAdvance()
                        ? "var(--accent, #3b82f6)"
                        : "var(--border, #2a3447)",
                      color: "white",
                      cursor: canAdvance() ? "pointer" : "not-allowed",
                      font: "inherit",
                      fontWeight: 600,
                      opacity: canAdvance() ? 1 : 0.6,
                    }}
                  >
                    Next →
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}


      {tab === "history" && (
        <div style={{ marginTop: "1rem" }}>
          {jobsLoading ? (
            <div style={{ color: "var(--text-subtle)" }}>Loading…</div>
          ) : jobs.length === 0 ? (
            <div
              style={{
                padding: "2rem",
                textAlign: "center",
                color: "var(--text-subtle)",
                border: "1px dashed var(--border, #2a3447)",
                borderRadius: 8,
              }}
            >
              No imports yet. Switch to the Upload tab to get started.
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="pulse-table"
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: 14,
                }}
              >
                <thead>
                  <tr>
                    {[
                      "Date",
                      "File",
                      "Kind",
                      "Status",
                      "Imported",
                      "Skipped",
                      "Actions",
                    ].map((h) => (
                      <th
                        key={h}
                        style={{
                          textAlign: "left",
                          padding: "0.5rem",
                          borderBottom: "1px solid var(--border, #2a3447)",
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((j) => (
                    <tr key={j.id}>
                      <td style={{ padding: "0.5rem" }}>
                        {new Date(j.uploadedAt).toLocaleString()}
                      </td>
                      <td
                        style={{
                          padding: "0.5rem",
                          fontFamily: "monospace",
                          fontSize: 13,
                        }}
                      >
                        {j.filename}
                        {j.districtId != null && j.schoolId == null && (
                          <span
                            style={{
                              display: "inline-block",
                              marginLeft: 6,
                              padding: "0.05rem 0.4rem",
                              fontSize: 10,
                              fontWeight: 700,
                              letterSpacing: "0.05em",
                              textTransform: "uppercase",
                              borderRadius: 999,
                              background: "rgba(59, 130, 246, 0.15)",
                              color: "#3b82f6",
                              border: "1px solid #3b82f6",
                              fontFamily: "inherit",
                            }}
                          >
                            District
                          </span>
                        )}
                      </td>
                      <td style={{ padding: "0.5rem" }}>
                        {j.kind}
                        {j.kind === "fast_florida" && j.mapping && (
                          <div
                            style={{
                              fontSize: 11,
                              color: "var(--text-subtle)",
                              marginTop: 2,
                            }}
                          >
                            {j.mapping.school_year && (
                              <span>SY {j.mapping.school_year}</span>
                            )}
                            {j.mapping.items_total && (
                              <span> · {j.mapping.items_total} items</span>
                            )}
                            {j.mapping.windows_seen && (
                              <span>
                                {" "}· {j.mapping.windows_seen.toUpperCase()}
                              </span>
                            )}
                          </div>
                        )}
                        {j.kind === "gradebook" && j.mapping && (
                          <div
                            style={{
                              fontSize: 11,
                              color: "var(--text-subtle)",
                              marginTop: 2,
                            }}
                          >
                            {j.mapping.quarter && (
                              <span>{j.mapping.quarter}</span>
                            )}
                            {j.mapping.effective_date && (
                              <span> · as of {j.mapping.effective_date}</span>
                            )}
                          </div>
                        )}
                      </td>
                      <td style={{ padding: "0.5rem" }}>
                        <span style={statusPillStyle(j.status)}>
                          {j.status.replace("_", " ")}
                        </span>
                      </td>
                      <td style={{ padding: "0.5rem" }}>{j.successRows}</td>
                      <td style={{ padding: "0.5rem" }}>
                        {j.errorRows > 0 ? (
                          <details>
                            <summary
                              style={{
                                cursor: "pointer",
                                color: "#f59e0b",
                              }}
                            >
                              {j.errorRows}
                            </summary>
                            {j.kind === "rosters" &&
                              renderSkippedHousesSection(j)}
                            <ul
                              style={{
                                margin: "0.25rem 0 0 1rem",
                                padding: 0,
                                fontSize: 12,
                              }}
                            >
                              {j.errorLog.slice(0, 10).map((e, i) => (
                                <li key={i}>
                                  Row {e.row}: {e.message}
                                </li>
                              ))}
                              {j.errorLog.length > 10 && (
                                <li style={{ listStyle: "none" }}>…</li>
                              )}
                            </ul>
                          </details>
                        ) : (
                          0
                        )}
                      </td>
                      <td style={{ padding: "0.5rem" }}>
                        {j.status === "committed" && (
                          <button
                            type="button"
                            onClick={() => handleRollback(j.id)}
                            disabled={rollbackId === j.id}
                            style={{
                              padding: "0.3rem 0.6rem",
                              border: "1px solid #ef4444",
                              borderRadius: 4,
                              background: "transparent",
                              color: "#ef4444",
                              cursor:
                                rollbackId === j.id
                                  ? "not-allowed"
                                  : "pointer",
                              font: "inherit",
                              fontSize: 13,
                              opacity: rollbackId === j.id ? 0.5 : 1,
                            }}
                          >
                            {rollbackId === j.id ? "…" : "Roll back"}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      {historicalGate === "ask" && kind === "fast_florida" && preview && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="historical-gate-title"
          onClick={(e) => {
            if (e.target === e.currentTarget) setHistoricalGate(null);
          }}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(2, 6, 23, 0.72)",
            backdropFilter: "blur(6px)",
            WebkitBackdropFilter: "blur(6px)",
            zIndex: 9999,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "1.5rem",
          }}
        >
          <div
            style={{
              maxWidth: 560,
              width: "100%",
              background: "var(--surface)",
              border: "1px solid var(--border, #2a3447)",
              borderRadius: 12,
              padding: "1.5rem",
              boxShadow: "0 25px 50px -12px rgba(0,0,0,0.6)",
            }}
          >
            <div
              id="historical-gate-title"
              style={{
                fontSize: 18,
                fontWeight: 700,
                marginBottom: 8,
              }}
            >
              Wait — is this current-year data or a prior-year backfill?
            </div>
            <div
              style={{
                fontSize: 13,
                color: "var(--text-subtle)",
                lineHeight: 1.5,
                marginBottom: 16,
              }}
            >
              You are about to commit{" "}
              <strong>{preview.validRows}</strong> FAST rows for school
              year <strong>{selectedSchoolYear || "(unknown)"}</strong> from{" "}
              <code>{filename}</code>. Picking the wrong option here
              silently corrupts dashboards, so we are asking explicitly.
            </div>
            <div
              style={{
                display: "grid",
                gap: 10,
                marginBottom: 14,
              }}
            >
              <button
                type="button"
                onClick={() => void doCommit(false)}
                disabled={committing}
                style={{
                  padding: "0.85rem 1rem",
                  border: "1px solid #3b82f6",
                  borderRadius: 8,
                  background: "rgba(59, 130, 246, 0.12)",
                  color: "inherit",
                  font: "inherit",
                  textAlign: "left",
                  cursor: "pointer",
                }}
              >
                <div style={{ fontWeight: 700, marginBottom: 4 }}>
                  Current-year data
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--text-subtle)",
                  }}
                >
                  Lands in PM1/PM2/PM3 dashboards and feeds Class
                  Composer + Insights for this school year.
                </div>
              </button>
              <button
                type="button"
                onClick={() => void doCommit(true)}
                disabled={committing}
                style={{
                  padding: "0.85rem 1rem",
                  border: "1px solid #f59e0b",
                  borderRadius: 8,
                  background: "rgba(245, 158, 11, 0.12)",
                  color: "inherit",
                  font: "inherit",
                  textAlign: "left",
                  cursor: "pointer",
                }}
              >
                <div style={{ fontWeight: 700, marginBottom: 4 }}>
                  Historical (prior-year backfill)
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--text-subtle)",
                  }}
                >
                  PM3-only. Stamped <code>is_historical=true</code>. Does
                  not appear in current-year charts; surfaces in the
                  multi-year FAST history chip.
                </div>
              </button>
            </div>
            <button
              type="button"
              onClick={() => setHistoricalGate(null)}
              disabled={committing}
              style={{
                padding: "0.5rem 0.9rem",
                border: "1px solid var(--border, #2a3447)",
                borderRadius: 6,
                background: "transparent",
                color: "var(--text-subtle)",
                font: "inherit",
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              Cancel — don't commit
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Renders the per-job "Skipped due to unrecognized house" panel under
// the History tab's errors cell. We group by distinct house name so an
// admin with 47 skipped rows across 3 typos sees "Hawks: 20", "Falconz:
// 15", "Phoenex: 12" instead of a flat row list, plus a CSV download
// that re-emits just those rows with the original headers for quick
// fix-and-reupload in their SIS.
// Download the skipped-houses CSV via authFetch + blob so the request
// carries the bearer token (a bare <a download> would 401 in
// token-only sessions). Filename hint comes from Content-Disposition
// the server already sets; we fall back to a deterministic name.
async function downloadSkippedHousesCsv(job: ImportJob): Promise<void> {
  try {
    const res = await authFetch(
      `/api/data-imports/jobs/${job.id}/skipped-houses.csv`,
    );
    if (!res.ok) {
      alert(`Download failed (${res.status})`);
      return;
    }
    const blob = await res.blob();
    const cd = res.headers.get("Content-Disposition") ?? "";
    const m = /filename="?([^"]+)"?/i.exec(cd);
    const filename = m?.[1] ?? `skipped-houses_job${job.id}.csv`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    alert(`Download failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function renderSkippedHousesSection(job: ImportJob): ReactNode {
  const skipped = job.errorLog.filter(
    (e) => e.code === "unrecognized_house" && e.raw,
  );
  if (skipped.length === 0) return null;
  // student_id lives under whatever CSV column the mapping aimed at
  // student_id. Fall back to common synonyms if the mapping isn't on
  // the job (shouldn't happen for fresh imports, but defensive).
  const studentIdCol =
    Object.entries(job.mapping ?? {}).find(([, t]) => t === "student_id")?.[0] ??
    null;
  const byHouse = new Map<
    string,
    Array<{ row: number; studentId: string }>
  >();
  for (const e of skipped) {
    const key = e.bucket ?? "(blank)";
    const sid = studentIdCol
      ? String(e.raw?.[studentIdCol] ?? "").trim()
      : "";
    const arr = byHouse.get(key) ?? [];
    arr.push({ row: e.row, studentId: sid });
    byHouse.set(key, arr);
  }
  const groups = Array.from(byHouse.entries()).sort(
    (a, b) => b[1].length - a[1].length,
  );
  return (
    <div
      style={{
        margin: "0.5rem 0",
        padding: "0.5rem 0.75rem",
        background: "rgba(245, 158, 11, 0.08)",
        border: "1px solid rgba(245, 158, 11, 0.4)",
        borderRadius: 4,
        fontSize: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          marginBottom: 6,
        }}
      >
        <strong style={{ color: "#b45309" }}>
          Skipped due to unrecognized house ({skipped.length})
        </strong>
        <button
          type="button"
          onClick={() => downloadSkippedHousesCsv(job)}
          style={{
            padding: "0.2rem 0.5rem",
            border: "1px solid #b45309",
            borderRadius: 4,
            color: "#b45309",
            background: "transparent",
            font: "inherit",
            fontSize: 11,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Download skipped rows as CSV
        </button>
      </div>
      {groups.map(([house, rows]) => (
        <details key={house} style={{ marginTop: 4 }}>
          <summary style={{ cursor: "pointer" }}>
            <code>{house}</code> — {rows.length} row
            {rows.length === 1 ? "" : "s"}
          </summary>
          <table
            style={{
              marginTop: 4,
              borderCollapse: "collapse",
              fontSize: 11,
              fontFamily: "monospace",
            }}
          >
            <thead>
              <tr style={{ textAlign: "left" }}>
                <th style={{ padding: "2px 8px 2px 0" }}>Row</th>
                <th style={{ padding: "2px 8px 2px 0" }}>student_id</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 50).map((r, i) => (
                <tr key={i}>
                  <td style={{ padding: "1px 8px 1px 0" }}>{r.row}</td>
                  <td style={{ padding: "1px 8px 1px 0" }}>
                    {r.studentId || "—"}
                  </td>
                </tr>
              ))}
              {rows.length > 50 && (
                <tr>
                  <td colSpan={2} style={{ padding: "2px 0", opacity: 0.7 }}>
                    + {rows.length - 50} more — download CSV for the full list
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </details>
      ))}
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
  warn,
}: {
  label: string;
  value: number;
  accent?: boolean;
  warn?: boolean;
}) {
  const color = warn ? "#f59e0b" : accent ? "#10b981" : "var(--text)";
  return (
    <div
      style={{
        padding: "0.5rem 0.85rem",
        border: "1px solid var(--border, #2a3447)",
        borderRadius: 6,
        minWidth: 90,
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: "var(--text-subtle)",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, color }}>{value}</div>
    </div>
  );
}

