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
  schoolsTable,
  importJobsTable,
  importTemplatesTable,
  assessmentsTable,
} from "@workspace/db";
import { eq, and, or, desc, sql, isNull } from "drizzle-orm";
import {
  requireSchool,
  canImportSchoolData,
  canImportDistrictData,
  canActAsDistrict,
  getDistrictIdForSchool,
} from "../lib/scope.js";
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

// Stricter gate for the district-scope importers (-district suffix). Only
// District Admin and SuperUser may upload a CSV that fans out across
// schools — School Admin tops out at their own school.
function requireDistrictImporter() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const staff = await loadStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    if (!canImportDistrictData(staff)) {
      res.status(403).json({ error: "District import access required" });
      return;
    }
    (req as Request & { staff: StaffRow }).staff = staff;
    next();
  };
}

// Resolve the actor's districtId via their home schoolId. Used by every
// district-scope handler to scope queries / inserts to the right silo.
// Returns null + writes the response on failure so the caller can early-exit.
async function requireActorDistrict(
  staff: StaffRow,
  res: Response,
): Promise<number | null> {
  const districtId = await getDistrictIdForSchool(staff.schoolId);
  if (districtId == null) {
    res.status(400).json({
      error: "Your account is not assigned to a district. Contact a SuperUser.",
    });
    return null;
  }
  return districtId;
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
  | "source"
  | "school_code";

const REQUIRED_FIELDS: AssessmentField[] = [
  "student_id",
  "assessment_name",
  "administered_at",
];

// District-scope adds school_code as a required field — that's the column
// that routes each row to the right school inside the actor's district.
const REQUIRED_FIELDS_DISTRICT: AssessmentField[] = [
  ...REQUIRED_FIELDS,
  "school_code",
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
  "school_code",
]);

// Server-side mapping validator. Catches malformed mappings that bypass
// the frontend's uniqueness check or reference columns / targets that
// don't exist. Returns null on success or an error message on rejection.
function validateMapping(
  mapping: Record<string, string>,
  csvHeaders: string[],
  required: AssessmentField[] = REQUIRED_FIELDS,
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
  for (const req of required) {
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
  school_code: [
    "school_code",
    "school",
    "school_id",
    "school_number",
    "school_num",
    "schoolnumber",
    "state_school_code",
    "state_school_id",
    "site_code",
    "site_id",
    "campus_code",
    "campus_id",
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

// District variant: same as parseRow but also extracts school_code and
// resolves it to a schoolId via the supplied lookup map. Rows whose code
// doesn't match a school in the actor's district are rejected with a
// per-row error (NOT a hard 400) so a 5,000-row CSV with one bad code
// still imports the other 4,999.
type ParsedDistrictAssessment = ParsedAssessment & {
  schoolId: number;
  schoolCode: string;
};

function parseRowDistrict(
  row: Record<string, string>,
  mapping: Record<string, string>,
  schoolCodeToId: Map<string, number>,
):
  | { ok: true; value: ParsedDistrictAssessment }
  | { ok: false; message: string } {
  const base = parseRow(row, mapping);
  if (!base.ok) return base;
  // Find the CSV column that holds school_code. Already validated by
  // validateMapping at the route layer, so we can assume it exists.
  let schoolCodeCol: string | null = null;
  for (const [csvCol, tgt] of Object.entries(mapping)) {
    if (tgt === "school_code") {
      schoolCodeCol = csvCol;
      break;
    }
  }
  if (!schoolCodeCol) {
    return { ok: false, message: "Missing required column: school_code" };
  }
  const codeRaw = (row[schoolCodeCol] ?? "").toString().trim();
  if (!codeRaw) {
    return { ok: false, message: "Empty value for school_code" };
  }
  // Resolution is namespaced (state code first, numeric id second) so a
  // value like "123" can't silently route to school#123 when school A
  // also has stateSchoolCode "123". See buildDistrictSchoolLookup.
  const sid = resolveSchoolCode(codeRaw, schoolCodeToId);
  if (sid == null) {
    return {
      ok: false,
      message: `Unknown school_code "${codeRaw}" — not in your district`,
    };
  }
  return {
    ok: true,
    value: { ...base.value, schoolId: sid, schoolCode: codeRaw },
  };
}

// Build a normalized lookup of school_code → schoolId for every active
// school in the actor's district. Each school exposes both its
// stateSchoolCode AND its numeric id as valid codes — districts vary on
// which they put in their feeds. The two keyspaces are NAMESPACED with
// "code:" / "id:" prefixes so a numeric stateSchoolCode can never silently
// collide with a different school's primary-key id. Returns the map plus
// an array of {id, name, code} for the per-school preview breakdown.
async function buildDistrictSchoolLookup(districtId: number): Promise<{
  codeToId: Map<string, number>;
  schools: Array<{ id: number; name: string; stateSchoolCode: string | null }>;
}> {
  const rows = await db
    .select({
      id: schoolsTable.id,
      name: schoolsTable.name,
      stateSchoolCode: schoolsTable.stateSchoolCode,
    })
    .from(schoolsTable)
    .where(
      and(eq(schoolsTable.districtId, districtId), eq(schoolsTable.active, true)),
    );
  const codeToId = new Map<string, number>();
  for (const s of rows) {
    if (s.stateSchoolCode) {
      codeToId.set(`code:${s.stateSchoolCode.toLowerCase()}`, s.id);
    }
    // Fallback for codeless feeds / power-user uploads. Stored under the
    // "id:" namespace so it can't collide with a different school's
    // stateSchoolCode that happens to be numeric.
    codeToId.set(`id:${String(s.id).toLowerCase()}`, s.id);
  }
  return { codeToId, schools: rows };
}

// Resolve a raw school_code value to a schoolId using the namespaced
// lookup map. stateSchoolCode is preferred ("code:" namespace wins over
// "id:") so a district that issues codes always routes by them first;
// numeric id is an explicit fallback.
function resolveSchoolCode(
  raw: string,
  codeToId: Map<string, number>,
): number | null {
  const norm = raw.toLowerCase();
  const byCode = codeToId.get(`code:${norm}`);
  if (byCode != null) return byCode;
  const byId = codeToId.get(`id:${norm}`);
  if (byId != null) return byId;
  return null;
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
// POST /api/data-imports/assessments/preview-district
//   District-scope preview. Caller must be DA or SU. Each CSV row must
//   carry a school_code that resolves to a school in the actor's district;
//   rows with unknown codes show up in the per-row error log just like
//   any other validation failure.
// ---------------------------------------------------------------------------
router.post(
  "/data-imports/assessments/preview-district",
  requireDistrictImporter(),
  async (req, res) => {
    const staff = (req as Request & { staff: StaffRow }).staff;
    const districtId = await requireActorDistrict(staff, res);
    if (districtId == null) return;
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
    const supplied =
      req.body?.mapping && typeof req.body.mapping === "object"
        ? (req.body.mapping as Record<string, string>)
        : {};
    const mapping: Record<string, string> = { ...auto.mapping };
    for (const [csvCol, tgtRaw] of Object.entries(supplied)) {
      const tgt = String(tgtRaw);
      if (!headers.includes(csvCol)) continue;
      if (!VALID_TARGETS.has(tgt)) continue;
      for (const k of Object.keys(mapping)) {
        if (mapping[k] === tgt && k !== csvCol) delete mapping[k];
      }
      mapping[csvCol] = tgt;
    }
    const { codeToId, schools } = await buildDistrictSchoolLookup(districtId);
    const errors: Array<{ row: number; message: string }> = [];
    let valid = 0;
    const sample: ParsedDistrictAssessment[] = [];
    // Per-school count for the preview breakdown ("3,420 rows for Pasco
    // High; 1,210 for Land O' Lakes; …").
    const perSchool = new Map<number, number>();
    // Only run row-by-row validation if the mapping is well-formed; if
    // it isn't, we still return the auto-mapping suggestion so the UI
    // can render the editor.
    const mappingOk =
      validateMapping(mapping, headers, REQUIRED_FIELDS_DISTRICT) === null;
    if (mappingOk) {
      for (let i = 0; i < rows.length; i++) {
        const parsed = parseRowDistrict(rows[i], mapping, codeToId);
        if (parsed.ok) {
          valid++;
          perSchool.set(
            parsed.value.schoolId,
            (perSchool.get(parsed.value.schoolId) ?? 0) + 1,
          );
          if (sample.length < 10) sample.push(parsed.value);
        } else if (errors.length < 50) {
          errors.push({ row: i + 2, message: parsed.message });
        }
      }
    }
    const schoolNameById = new Map(schools.map((s) => [s.id, s.name]));
    const perSchoolBreakdown = Array.from(perSchool.entries())
      .map(([sid, n]) => ({
        schoolId: sid,
        schoolName: schoolNameById.get(sid) ?? `School #${sid}`,
        rows: n,
      }))
      .sort((a, b) => b.rows - a.rows);
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
      perSchool: perSchoolBreakdown,
      districtSchoolCount: schools.length,
      readyToCommit:
        rows.length > 0 &&
        REQUIRED_FIELDS_DISTRICT.every((f) =>
          Object.values(mapping).includes(f),
        ),
    });
  },
);

// ---------------------------------------------------------------------------
// POST /api/data-imports/assessments/commit-district
//   District-scope commit. Creates ONE import_jobs row with districtId
//   set + schoolId null, then inserts the assessment rows tagged with
//   their resolved per-row schoolId. Rollback uses the same flow as
//   school-scope (DELETE WHERE import_job_id = X) — no per-school fan-out
//   needed because every assessment row already carries its schoolId.
// ---------------------------------------------------------------------------
router.post(
  "/data-imports/assessments/commit-district",
  requireDistrictImporter(),
  async (req, res) => {
    const staff = (req as Request & { staff: StaffRow }).staff;
    const districtId = await requireActorDistrict(staff, res);
    if (districtId == null) return;
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
    const mappingError = validateMapping(
      mapping,
      headers,
      REQUIRED_FIELDS_DISTRICT,
    );
    if (mappingError) {
      res.status(400).json({ error: mappingError });
      return;
    }
    const { codeToId } = await buildDistrictSchoolLookup(districtId);
    const valid: ParsedDistrictAssessment[] = [];
    const errors: Array<{
      row: number;
      message: string;
      raw?: Record<string, string>;
    }> = [];
    for (let i = 0; i < rows.length; i++) {
      const parsed = parseRowDistrict(rows[i], mapping, codeToId);
      if (parsed.ok) {
        valid.push(parsed.value);
      } else if (errors.length < 500) {
        errors.push({ row: i + 2, message: parsed.message, raw: rows[i] });
      }
    }
    const result = await db.transaction(async (tx) => {
      const [job] = await tx
        .insert(importJobsTable)
        .values({
          // District scope: schoolId is null, districtId is set. Both-set
          // would be invalid; this enforces the schema invariant.
          schoolId: null,
          districtId,
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
        const chunkSize = 500;
        for (let i = 0; i < valid.length; i += chunkSize) {
          const chunk = valid.slice(i, i + chunkSize);
          await tx.insert(assessmentsTable).values(
            chunk.map((v) => ({
              schoolId: v.schoolId,
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
// GET /api/data-imports/jobs?kind=assessments&limit=50&scope=school|district
//   scope=school (default): jobs for the current school (req.schoolId).
//   scope=district: jobs whose districtId matches the actor's district AND
//     schoolId is null. Gated on canActAsDistrict — School Admins get a 403
//     if they ask for district scope.
//   The error log is truncated to 50 entries per row to keep the payload
//   small; the detail endpoint (Phase 3 step 2) will return the full log.
// ---------------------------------------------------------------------------
router.get("/data-imports/jobs", requireImporter(), async (req, res) => {
  const staff = (req as Request & { staff: StaffRow }).staff;
  const scope = req.query.scope === "district" ? "district" : "school";
  const kind =
    typeof req.query.kind === "string" && req.query.kind.trim()
      ? req.query.kind.trim()
      : null;
  const limit = Math.min(
    Math.max(parseInt(String(req.query.limit ?? "50"), 10) || 50, 1),
    200,
  );

  let scopePredicate;
  if (scope === "district") {
    if (!canActAsDistrict(staff)) {
      res.status(403).json({ error: "District access required" });
      return;
    }
    const districtId = await requireActorDistrict(staff, res);
    if (districtId == null) return;
    scopePredicate = and(
      eq(importJobsTable.districtId, districtId),
      isNull(importJobsTable.schoolId),
    );
  } else {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    scopePredicate = eq(importJobsTable.schoolId, schoolId);
  }

  const where = kind
    ? and(scopePredicate, eq(importJobsTable.kind, kind))
    : scopePredicate;
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
    const staff = (req as Request & { staff: StaffRow }).staff;
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: "Invalid job id" });
      return;
    }
    const [job] = await db
      .select()
      .from(importJobsTable)
      .where(eq(importJobsTable.id, id));
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    // Authorize based on the job's scope. School-scope jobs require the
    // caller to be on the same school; district-scope jobs require DA/SU
    // on the same district.
    if (job.districtId != null && job.schoolId == null) {
      if (!canActAsDistrict(staff)) {
        res.status(403).json({ error: "District access required" });
        return;
      }
      const actorDistrictId = await requireActorDistrict(staff, res);
      if (actorDistrictId == null) return;
      if (job.districtId !== actorDistrictId) {
        res.status(404).json({ error: "Job not found" });
        return;
      }
    } else if (job.schoolId != null) {
      const schoolId = requireSchool(req, res);
      if (!schoolId) return;
      if (job.schoolId !== schoolId) {
        res.status(404).json({ error: "Job not found" });
        return;
      }
    } else {
      // Malformed job row (neither scope set) — refuse to touch it.
      res.status(409).json({ error: "Job has no scope" });
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
        if (job.districtId != null && job.schoolId == null) {
          // District-scope rollback: rows span multiple schools. We
          // intentionally DELETE by importJobId alone — re-deriving the
          // school list from the current district mapping creates a
          // TOCTOU bug: if a school is moved out of the district between
          // commit and rollback, its rows would be excluded from the
          // delete and silently orphaned. The actor was already
          // authorized as DA/SU on this job's district above, so by-job
          // deletion is safe and complete.
          const r = await tx
            .delete(assessmentsTable)
            .where(eq(assessmentsTable.importJobId, id));
          count =
            (r as unknown as { rowCount?: number }).rowCount ?? job.successRows;
        } else if (job.schoolId != null) {
          // School-scope rollback: we know exactly one schoolId. Defense
          // in depth: AND on schoolId so a malformed job row can never
          // cross-school nuke.
          const r = await tx
            .delete(assessmentsTable)
            .where(
              and(
                eq(assessmentsTable.importJobId, id),
                eq(assessmentsTable.schoolId, job.schoolId),
              ),
            );
          count =
            (r as unknown as { rowCount?: number }).rowCount ?? job.successRows;
        }
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

// ---------------------------------------------------------------------------
// Mapping templates. Once a school admin has correctly mapped a vendor's
// CSV (FAST, iReady, MAP, …) they can save the mapping as a named
// template so the next quarter's upload pre-fills every column.
//
// Visibility model:
//   - school-scope template (schoolId set, districtId null) → visible to
//     that school only (creator + anyone else uploading at that school).
//   - district-scope template (districtId set, schoolId null) → visible
//     to every school in the district as a read-only suggestion AND to
//     the district itself.
//
// Listing rules for a caller:
//   - school mode: their school's templates + their district's templates
//     (if they have a district).
//   - district mode: their district's templates only.
// ---------------------------------------------------------------------------

// Validate a mapping payload before saving as a template. Same rules as
// the importer's validateMapping but WITHOUT the required-fields check —
// templates are allowed to be partial (the user fills in the gaps later
// when they hit the importer).
function validateTemplateMapping(
  mapping: Record<string, string>,
): string | null {
  if (
    !mapping ||
    typeof mapping !== "object" ||
    Array.isArray(mapping) ||
    Object.keys(mapping).length === 0
  ) {
    return "Template mapping must have at least one column";
  }
  const seenTargets = new Set<string>();
  for (const [csvCol, target] of Object.entries(mapping)) {
    if (typeof csvCol !== "string" || !csvCol.trim()) {
      return "Template has an empty CSV column name";
    }
    if (typeof target !== "string" || !VALID_TARGETS.has(target)) {
      return `Template references unknown target field: "${target}"`;
    }
    if (seenTargets.has(target)) {
      return `Two CSV columns map to the same target: "${target}"`;
    }
    seenTargets.add(target);
  }
  return null;
}

// ---------------------------------------------------------------------------
// GET /api/data-imports/templates?kind=assessments&scope=school|district
//   Returns templates visible to the actor in the requested scope.
//   - school (default): own school + own district's templates
//   - district: own district's templates only (gated on canActAsDistrict)
//   Each row carries a `scope` discriminator the UI uses to render a
//   chip and to enforce edit/delete rules.
// ---------------------------------------------------------------------------
router.get(
  "/data-imports/templates",
  requireImporter(),
  async (req, res) => {
    const staff = (req as Request & { staff: StaffRow }).staff;
    const scope = req.query.scope === "district" ? "district" : "school";
    const kind =
      typeof req.query.kind === "string" && req.query.kind.trim()
        ? req.query.kind.trim()
        : null;
    if (!kind) {
      res.status(400).json({ error: "kind is required" });
      return;
    }

    let scopePredicate;
    if (scope === "district") {
      if (!canActAsDistrict(staff)) {
        res.status(403).json({ error: "District access required" });
        return;
      }
      const districtId = await requireActorDistrict(staff, res);
      if (districtId == null) return;
      scopePredicate = and(
        eq(importTemplatesTable.districtId, districtId),
        isNull(importTemplatesTable.schoolId),
      );
    } else {
      const schoolId = requireSchool(req, res);
      if (!schoolId) return;
      // School-mode list = own school templates + own district templates
      // (if any). Falls through gracefully when the school isn't in a
      // district yet — only school-scope templates show up.
      const districtId = await getDistrictIdForSchool(staff.schoolId);
      const ownSchool = and(
        eq(importTemplatesTable.schoolId, schoolId),
        isNull(importTemplatesTable.districtId),
      );
      scopePredicate =
        districtId != null
          ? or(
              ownSchool,
              and(
                eq(importTemplatesTable.districtId, districtId),
                isNull(importTemplatesTable.schoolId),
              ),
            )
          : ownSchool;
    }

    const where = and(scopePredicate, eq(importTemplatesTable.kind, kind));
    const rows = await db
      .select()
      .from(importTemplatesTable)
      .where(where)
      .orderBy(desc(importTemplatesTable.createdAt));
    // Decorate with a scope label so the UI doesn't have to reconstruct
    // it from schoolId/districtId.
    const decorated = rows.map((r) => ({
      ...r,
      scope:
        r.districtId != null && r.schoolId == null
          ? ("district" as const)
          : ("school" as const),
    }));
    res.json(decorated);
  },
);

// ---------------------------------------------------------------------------
// POST /api/data-imports/templates
//   Body: { kind, name, mapping, scope?: "school"|"district" }
//   Saves the supplied mapping as a named template. School scope is the
//   default and works for any importer; district scope requires
//   canActAsDistrict. Names are de-duplicated within (scope, kind) — if
//   a template with the same name already exists, this UPDATES it
//   (upsert by name) so users can iterate without piling up dupes.
// ---------------------------------------------------------------------------
router.post(
  "/data-imports/templates",
  requireImporter(),
  async (req, res) => {
    const staff = (req as Request & { staff: StaffRow }).staff;
    const kind =
      typeof req.body?.kind === "string" && req.body.kind.trim()
        ? req.body.kind.trim()
        : null;
    const name =
      typeof req.body?.name === "string" && req.body.name.trim()
        ? req.body.name.trim().slice(0, 100)
        : null;
    const mapping = req.body?.mapping;
    const scope = req.body?.scope === "district" ? "district" : "school";
    if (!kind) {
      res.status(400).json({ error: "kind is required" });
      return;
    }
    if (!name) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    const mappingError = validateTemplateMapping(mapping);
    if (mappingError) {
      res.status(400).json({ error: mappingError });
      return;
    }

    let schoolIdCol: number | null = null;
    let districtIdCol: number | null = null;
    if (scope === "district") {
      if (!canActAsDistrict(staff)) {
        res.status(403).json({ error: "District template requires DA/SU" });
        return;
      }
      const d = await requireActorDistrict(staff, res);
      if (d == null) return;
      districtIdCol = d;
    } else {
      const schoolId = requireSchool(req, res);
      if (!schoolId) return;
      schoolIdCol = schoolId;
    }

    // Upsert by (scope, kind, name). Two templates called "FAST" at the
    // same school+kind would be confusing in the dropdown, so we just
    // overwrite the existing one with the new mapping.
    const ownerWhere =
      scope === "district"
        ? and(
            eq(importTemplatesTable.districtId, districtIdCol!),
            isNull(importTemplatesTable.schoolId),
          )
        : and(
            eq(importTemplatesTable.schoolId, schoolIdCol!),
            isNull(importTemplatesTable.districtId),
          );
    const [existing] = await db
      .select()
      .from(importTemplatesTable)
      .where(
        and(
          ownerWhere,
          eq(importTemplatesTable.kind, kind),
          eq(importTemplatesTable.name, name),
        ),
      );
    if (existing) {
      await db
        .update(importTemplatesTable)
        .set({ mapping, createdBy: staff.id, createdAt: new Date() })
        .where(eq(importTemplatesTable.id, existing.id));
      res.json({ id: existing.id, updated: true });
      return;
    }
    const [row] = await db
      .insert(importTemplatesTable)
      .values({
        schoolId: schoolIdCol,
        districtId: districtIdCol,
        kind,
        name,
        mapping,
        createdBy: staff.id,
      })
      .returning({ id: importTemplatesTable.id });
    res.json({ id: row.id, updated: false });
  },
);

// ---------------------------------------------------------------------------
// DELETE /api/data-imports/templates/:id
//   Permission rules:
//     - school template: any importer at that school may delete (so a
//       team member can clean up after a colleague leaves).
//     - district template: only DA/SU on the same district may delete.
// ---------------------------------------------------------------------------
router.delete(
  "/data-imports/templates/:id",
  requireImporter(),
  async (req, res) => {
    const staff = (req as Request & { staff: StaffRow }).staff;
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: "Invalid template id" });
      return;
    }
    const [tpl] = await db
      .select()
      .from(importTemplatesTable)
      .where(eq(importTemplatesTable.id, id));
    if (!tpl) {
      res.status(404).json({ error: "Template not found" });
      return;
    }
    if (tpl.districtId != null && tpl.schoolId == null) {
      if (!canActAsDistrict(staff)) {
        res.status(403).json({ error: "District template requires DA/SU" });
        return;
      }
      const actorDistrictId = await requireActorDistrict(staff, res);
      if (actorDistrictId == null) return;
      if (tpl.districtId !== actorDistrictId) {
        res.status(404).json({ error: "Template not found" });
        return;
      }
    } else if (tpl.schoolId != null) {
      const schoolId = requireSchool(req, res);
      if (!schoolId) return;
      if (tpl.schoolId !== schoolId) {
        res.status(404).json({ error: "Template not found" });
        return;
      }
    } else {
      // Neither scope set — refuse to touch a malformed row.
      res.status(409).json({ error: "Template has no scope" });
      return;
    }
    await db
      .delete(importTemplatesTable)
      .where(eq(importTemplatesTable.id, id));
    res.json({ ok: true });
  },
);

export default router;
