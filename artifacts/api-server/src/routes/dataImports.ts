// ---------------------------------------------------------------------------
// Data Imports route — Phase 3 of the eduCLIMBER-style Insights work.
// First importer: assessments (FAST, iReady, MAP, etc.). The pattern here
// is intentionally generic so adding a second importer (rosters, behavior
// history, attendance) is mostly route handlers + a target table.
//
// Endpoints:
//   POST /api/data-imports/assessments/preview  — parse + validate, no write
//   POST /api/data-imports/assessments/commit   — insert rows + history
//   GET  /api/data-imports/jobs                  — recent imports for school
//   POST /api/data-imports/jobs/:id/rollback    — undo a committed import
//
// Permission model: every handler runs canImportSchoolData() which lets
// School Admin, District Admin, and SuperUser through. Everyone else
// gets a 403 — even teachers/deans who happen to have other capabilities.
// ---------------------------------------------------------------------------
import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  db,
  staffTable,
  importJobsTable,
  assessmentsTable,
} from "@workspace/db";
import { eq, and, desc, sql } from "drizzle-orm";
import { requireSchool, canImportSchoolData } from "../lib/scope.js";
import Papa from "papaparse";

const router: IRouter = Router();
type StaffRow = typeof staffTable.$inferSelect;

async function loadStaff(req: Request): Promise<StaffRow | null> {
  const id = req.staffId;
  if (!id) return null;
  const [s] = await db.select().from(staffTable).where(eq(staffTable.id, id));
  return s && s.active ? s : null;
}

// Gate every importer on the same predicate so we can't accidentally drift
// between routes. Mirrors the requireAdmin() shape used elsewhere.
function requireImporter() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const staff = await loadStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    if (!canImportSchoolData(staff)) {
      res.status(403).json({ error: "Data import access required" });
      return;
    }
    (req as Request & { staff: StaffRow }).staff = staff;
    next();
  };
}

// ---------------------------------------------------------------------------
// Mapping helpers. The CSV vendor uses whatever column names they want
// ("STUDENT_NUM", "Test Name", "Date Administered", ...). We normalize the
// header row to lowercase snake_case and try to auto-map onto our target
// fields. The frontend can override any column with a manual mapping.
// ---------------------------------------------------------------------------
type AssessmentField =
  | "student_id"
  | "assessment_name"
  | "score"
  | "score_level"
  | "administered_at"
  | "source";

const REQUIRED_FIELDS: AssessmentField[] = [
  "student_id",
  "assessment_name",
  "administered_at",
];

// Hard cap on rows per import. Anything bigger should be split into
// smaller files — keeps a runaway upload from filling assessments and
// the error_log jsonb. Adjustable later if real district feeds need it.
const MAX_ROWS_PER_IMPORT = 50000;

const VALID_TARGETS = new Set<string>([
  "student_id",
  "assessment_name",
  "score",
  "score_level",
  "administered_at",
  "source",
]);

// Server-side mapping validator. Catches malformed mappings that bypass
// the frontend's uniqueness check or reference columns / targets that
// don't exist. Returns null on success or an error message on rejection.
function validateMapping(
  mapping: Record<string, string>,
  csvHeaders: string[],
): string | null {
  const headerSet = new Set(csvHeaders);
  const seenTargets = new Set<string>();
  for (const [csvCol, target] of Object.entries(mapping)) {
    if (!headerSet.has(csvCol)) {
      return `Mapping references unknown CSV column: "${csvCol}"`;
    }
    if (!VALID_TARGETS.has(target)) {
      return `Mapping references unknown target field: "${target}"`;
    }
    if (seenTargets.has(target)) {
      return `Two CSV columns map to the same target: "${target}"`;
    }
    seenTargets.add(target);
  }
  for (const req of REQUIRED_FIELDS) {
    if (!seenTargets.has(req)) {
      return `Mapping missing required field: "${req}"`;
    }
  }
  return null;
}

// Synonym table — every entry must already be in normalized form
// (lowercased, non-alphanumeric → "_"). Order matters: first match wins.
const HEADER_SYNONYMS: Record<AssessmentField, string[]> = {
  student_id: [
    "student_id",
    "student_number",
    "student_num",
    "studentnumber",
    "sis_id",
    "sis_number",
    "id",
    "studentid",
  ],
  assessment_name: [
    "assessment_name",
    "assessment",
    "test_name",
    "test",
    "exam_name",
    "subject",
    "measure",
  ],
  score: [
    "score",
    "scale_score",
    "scaled_score",
    "ss",
    "raw_score",
    "points",
    "value",
  ],
  score_level: [
    "score_level",
    "level",
    "achievement_level",
    "performance_level",
    "band",
    "tier",
  ],
  administered_at: [
    "administered_at",
    "administered",
    "date",
    "test_date",
    "given_at",
    "given_date",
    "assessment_date",
  ],
  source: [
    "source",
    "vendor",
    "publisher",
    "provider",
    "system",
  ],
};

function normalizeHeader(h: string): string {
  return h.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

// Returns { mapping: csvHeader → target, unmappedCsv: csvHeader[] }
function autoMapHeaders(csvHeaders: string[]): {
  mapping: Record<string, string>;
  unmappedCsv: string[];
} {
  const taken = new Set<AssessmentField>();
  const mapping: Record<string, string> = {};
  const normToOriginal = new Map<string, string>();
  for (const h of csvHeaders) {
    if (!normToOriginal.has(normalizeHeader(h))) {
      normToOriginal.set(normalizeHeader(h), h);
    }
  }
  for (const target of Object.keys(HEADER_SYNONYMS) as AssessmentField[]) {
    if (taken.has(target)) continue;
    for (const syn of HEADER_SYNONYMS[target]) {
      const original = normToOriginal.get(syn);
      if (original && !mapping[original]) {
        mapping[original] = target;
        taken.add(target);
        break;
      }
    }
  }
  const unmappedCsv = csvHeaders.filter((h) => !mapping[h]);
  return { mapping, unmappedCsv };
}

// Parse a single CSV row (already keyed by csv-header) into an assessment
// candidate using the supplied mapping (csvHeader → target field). Returns
// either { ok: true, value } or { ok: false, message } so the caller can
// route the row into the success bucket or the error log.
type ParsedAssessment = {
  studentId: string;
  assessmentName: string;
  score: number | null;
  scoreLevel: string | null;
  administeredAt: Date;
  source: string | null;
};

function parseRow(
  row: Record<string, string>,
  mapping: Record<string, string>,
):
  | { ok: true; value: ParsedAssessment }
  | { ok: false; message: string } {
  // Invert the mapping so we can ask "what CSV column holds student_id?"
  const target: Partial<Record<AssessmentField, string>> = {};
  for (const [csvCol, tgt] of Object.entries(mapping)) {
    target[tgt as AssessmentField] = csvCol;
  }
  for (const req of REQUIRED_FIELDS) {
    const csvCol = target[req];
    if (!csvCol) {
      return { ok: false, message: `Missing required column: ${req}` };
    }
    const raw = (row[csvCol] ?? "").toString().trim();
    if (!raw) {
      return { ok: false, message: `Empty value for ${req}` };
    }
  }
  const studentId = row[target.student_id!].toString().trim();
  const assessmentName = row[target.assessment_name!].toString().trim();
  const dateRaw = row[target.administered_at!].toString().trim();
  const dateParsed = new Date(dateRaw);
  if (isNaN(dateParsed.getTime())) {
    return { ok: false, message: `Invalid date: "${dateRaw}"` };
  }
  let score: number | null = null;
  if (target.score) {
    const sRaw = (row[target.score] ?? "").toString().trim();
    if (sRaw) {
      const n = Number(sRaw);
      if (!isNaN(n)) score = n;
    }
  }
  let scoreLevel: string | null = null;
  if (target.score_level) {
    const lRaw = (row[target.score_level] ?? "").toString().trim();
    if (lRaw) scoreLevel = lRaw;
  }
  if (score === null && scoreLevel === null) {
    return { ok: false, message: "Row has neither score nor score_level" };
  }
  let source: string | null = null;
  if (target.source) {
    const srcRaw = (row[target.source] ?? "").toString().trim();
    if (srcRaw) source = srcRaw;
  }
  return {
    ok: true,
    value: {
      studentId,
      assessmentName,
      score,
      scoreLevel,
      administeredAt: dateParsed,
      source,
    },
  };
}

// Parse the supplied CSV text into rows + header. Wrapped so the preview
// and commit endpoints share the exact same parser configuration.
function parseCsv(csv: string): {
  headers: string[];
  rows: Array<Record<string, string>>;
  parseError?: string;
} {
  const trimmed = csv.replace(/^\uFEFF/, ""); // strip BOM
  const result = Papa.parse<Record<string, string>>(trimmed, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim(),
  });
  if (result.errors.length > 0) {
    const first = result.errors[0];
    return {
      headers: result.meta.fields ?? [],
      rows: [],
      parseError: `Row ${first.row}: ${first.message}`,
    };
  }
  return {
    headers: result.meta.fields ?? [],
    rows: result.data,
  };
}

// ---------------------------------------------------------------------------
// POST /api/data-imports/assessments/preview
//   Body: { csv: string, filename?: string, mapping?: Record<string,string> }
//   Returns:
//     { headers, autoMapping, suggestedMapping, totalRows, sampleRows,
//       errors: [{ row, message }], readyToCommit: boolean }
// No DB writes — pure validation pass for the UI's preview step.
// ---------------------------------------------------------------------------
router.post(
  "/data-imports/assessments/preview",
  requireImporter(),
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const csv = typeof req.body?.csv === "string" ? req.body.csv : "";
    if (!csv.trim()) {
      res.status(400).json({ error: "CSV body is required" });
      return;
    }
    const { headers, rows, parseError } = parseCsv(csv);
    if (parseError) {
      res.status(400).json({ error: parseError, headers });
      return;
    }
    if (rows.length > MAX_ROWS_PER_IMPORT) {
      res.status(400).json({
        error: `CSV exceeds the ${MAX_ROWS_PER_IMPORT}-row limit (got ${rows.length}). Split the file and try again.`,
      });
      return;
    }
    const auto = autoMapHeaders(headers);
    // Caller can override any column. We trust the override but only for
    // headers that actually exist AND for known target fields. Duplicate
    // target assignments are dropped — last-write-wins per CSV column,
    // and we strip any earlier mapping that pointed at the same target.
    const supplied =
      req.body?.mapping && typeof req.body.mapping === "object"
        ? (req.body.mapping as Record<string, string>)
        : {};
    const mapping: Record<string, string> = { ...auto.mapping };
    for (const [csvCol, tgtRaw] of Object.entries(supplied)) {
      const tgt = String(tgtRaw);
      if (!headers.includes(csvCol)) continue;
      if (!VALID_TARGETS.has(tgt)) continue;
      // Strip any other csv column that was pointing at this target so
      // we never end up with duplicates.
      for (const k of Object.keys(mapping)) {
        if (mapping[k] === tgt && k !== csvCol) delete mapping[k];
      }
      mapping[csvCol] = tgt;
    }
    const errors: Array<{ row: number; message: string }> = [];
    let valid = 0;
    const sample: ParsedAssessment[] = [];
    for (let i = 0; i < rows.length; i++) {
      const parsed = parseRow(rows[i], mapping);
      if (parsed.ok) {
        valid++;
        if (sample.length < 10) sample.push(parsed.value);
      } else {
        if (errors.length < 50) {
          errors.push({ row: i + 2, message: parsed.message }); // +2 = 1-indexed + header row
        }
      }
    }
    res.json({
      headers,
      autoMapping: auto.mapping,
      suggestedMapping: mapping,
      unmappedCsvColumns: auto.unmappedCsv,
      totalRows: rows.length,
      validRows: valid,
      errorRows: rows.length - valid,
      sampleRows: sample,
      errors,
      readyToCommit:
        rows.length > 0 &&
        REQUIRED_FIELDS.every((f) =>
          Object.values(mapping).includes(f),
        ),
    });
  },
);

// ---------------------------------------------------------------------------
// POST /api/data-imports/assessments/commit
//   Body: { csv: string, filename: string, mapping: Record<string,string> }
//   Returns: { jobId, totalRows, successRows, errorRows }
// Writes one import_jobs row + N assessments rows in a transaction so a
// mid-flight failure doesn't leave a half-imported batch behind.
// ---------------------------------------------------------------------------
router.post(
  "/data-imports/assessments/commit",
  requireImporter(),
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const staff = (req as Request & { staff: StaffRow }).staff;
    const csv = typeof req.body?.csv === "string" ? req.body.csv : "";
    const filename =
      typeof req.body?.filename === "string" && req.body.filename.trim()
        ? req.body.filename.trim().slice(0, 200)
        : "upload.csv";
    const mapping =
      req.body?.mapping && typeof req.body.mapping === "object"
        ? (req.body.mapping as Record<string, string>)
        : {};
    if (!csv.trim()) {
      res.status(400).json({ error: "CSV body is required" });
      return;
    }
    const { headers, rows, parseError } = parseCsv(csv);
    if (parseError) {
      res.status(400).json({ error: parseError });
      return;
    }
    if (rows.length > MAX_ROWS_PER_IMPORT) {
      res.status(400).json({
        error: `CSV exceeds the ${MAX_ROWS_PER_IMPORT}-row limit (got ${rows.length}). Split the file and try again.`,
      });
      return;
    }
    const mappingError = validateMapping(mapping, headers);
    if (mappingError) {
      res.status(400).json({ error: mappingError });
      return;
    }
    const valid: ParsedAssessment[] = [];
    const errors: Array<{
      row: number;
      message: string;
      raw?: Record<string, string>;
    }> = [];
    for (let i = 0; i < rows.length; i++) {
      const parsed = parseRow(rows[i], mapping);
      if (parsed.ok) {
        valid.push(parsed.value);
      } else if (errors.length < 500) {
        errors.push({ row: i + 2, message: parsed.message, raw: rows[i] });
      }
    }
    // Commit inside a transaction so the job row + all assessment rows
    // either all land or none do.
    const result = await db.transaction(async (tx) => {
      const [job] = await tx
        .insert(importJobsTable)
        .values({
          schoolId,
          districtId: null,
          kind: "assessments",
          filename,
          uploadedBy: staff.id,
          status: "committed",
          totalRows: rows.length,
          successRows: valid.length,
          errorRows: rows.length - valid.length,
          errorLog: errors,
          mapping,
          committedAt: new Date(),
        })
        .returning({ id: importJobsTable.id });
      if (valid.length > 0) {
        // Chunked insert to keep parameter count under the pg limit
        // (~65k per query). 500 rows × ~8 cols = 4000 params, safe.
        const chunkSize = 500;
        for (let i = 0; i < valid.length; i += chunkSize) {
          const chunk = valid.slice(i, i + chunkSize);
          await tx.insert(assessmentsTable).values(
            chunk.map((v) => ({
              schoolId,
              studentId: v.studentId,
              assessmentName: v.assessmentName,
              score: v.score,
              scoreLevel: v.scoreLevel,
              administeredAt: v.administeredAt,
              source: v.source,
              importJobId: job.id,
            })),
          );
        }
      }
      return job.id;
    });
    res.json({
      jobId: result,
      totalRows: rows.length,
      successRows: valid.length,
      errorRows: rows.length - valid.length,
    });
  },
);

// ---------------------------------------------------------------------------
// GET /api/data-imports/jobs?kind=assessments&limit=50
//   Returns recent jobs for the current school, newest first. The error
//   log is truncated to 50 entries per row to keep the payload small;
//   the detail endpoint (added in Phase 3 step 2) will return the full log.
// ---------------------------------------------------------------------------
router.get("/data-imports/jobs", requireImporter(), async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const kind =
    typeof req.query.kind === "string" && req.query.kind.trim()
      ? req.query.kind.trim()
      : null;
  const limit = Math.min(
    Math.max(parseInt(String(req.query.limit ?? "50"), 10) || 50, 1),
    200,
  );
  const where = kind
    ? and(eq(importJobsTable.schoolId, schoolId), eq(importJobsTable.kind, kind))
    : eq(importJobsTable.schoolId, schoolId);
  const rows = await db
    .select()
    .from(importJobsTable)
    .where(where)
    .orderBy(desc(importJobsTable.uploadedAt))
    .limit(limit);
  // Truncate the error log per row before sending — the History tab only
  // needs the first handful for the summary; full log is on demand.
  const trimmed = rows.map((r) => ({
    ...r,
    errorLog: Array.isArray(r.errorLog) ? r.errorLog.slice(0, 50) : [],
  }));
  res.json(trimmed);
});

// ---------------------------------------------------------------------------
// POST /api/data-imports/jobs/:id/rollback
//   Deletes the rows this job inserted (assessments today; future
//   importers will need to add their own delete branch). Wrapped in a
//   transaction with the status flip so a partial undo can't strand the
//   job in a "kind of rolled back" state.
// ---------------------------------------------------------------------------
router.post(
  "/data-imports/jobs/:id/rollback",
  requireImporter(),
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: "Invalid job id" });
      return;
    }
    const [job] = await db
      .select()
      .from(importJobsTable)
      .where(eq(importJobsTable.id, id));
    if (!job || job.schoolId !== schoolId) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    if (job.status !== "committed") {
      res
        .status(409)
        .json({ error: `Cannot roll back a ${job.status} job` });
      return;
    }
    const deleted = await db.transaction(async (tx) => {
      let count = 0;
      if (job.kind === "assessments") {
        // Defense in depth: even though importJobId alone is enough to
        // identify the rows, we AND on schoolId so a malformed job row
        // can never DELETE rows belonging to another school.
        const r = await tx
          .delete(assessmentsTable)
          .where(
            and(
              eq(assessmentsTable.importJobId, id),
              eq(assessmentsTable.schoolId, schoolId),
            ),
          );
        // drizzle returns rowCount on the underlying result; fall back
        // to job.successRows if not available.
        count = (r as unknown as { rowCount?: number }).rowCount ?? job.successRows;
      }
      await tx
        .update(importJobsTable)
        .set({ status: "rolled_back", rolledBackAt: new Date() })
        .where(eq(importJobsTable.id, id));
      return count;
    });
    res.json({ ok: true, deleted });
  },
);

export default router;
