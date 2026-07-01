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
  classSectionsTable,
  sectionRosterTable,
  studentsTable,
  supportNotesTable,
  studentFastScoresTable,
  studentFastItemResponsesTable,
  studentCourseGradesTable,
  studentImportSnapshotsTable,
  schoolSettingsTable,
  housesTable,
  pbisEntriesTable,
  pbisPointMigrationsTable,
  pbisMilestonesTable,
  pbisMilestoneEmailsTable,
} from "@workspace/db";
import { recommendNextHouse } from "./houses.js";
import { eq, and, or, desc, sql, isNull, inArray, gte, lte, ilike, ne, not } from "drizzle-orm";
import {
  requireSchool,
  canImportSchoolData,
  canImportDistrictData,
  canActAsDistrict,
  getDistrictIdForSchool,
  hasAnySchoolImportCap,
  canImportKind,
  allowedSchoolImportKinds,
} from "../lib/scope.js";
import {
  DEFAULT_SCHOOL_TZ,
  getSchoolTimezone,
  schoolYearLabelFor,
} from "../lib/schoolYear.js";
import Papa from "papaparse";
import ExcelJS from "exceljs";

// Resolve the "YY-YY" school-year label for a given school, honoring the
// per-school IANA timezone column (falls back to DEFAULT_SCHOOL_TZ).
// Cached at the schoolYear module level so repeat calls inside one
// import are free.
async function currentSchoolYearLabelForSchool(
  schoolId: number,
): Promise<string> {
  const tz = await getSchoolTimezone(schoolId).catch(() => DEFAULT_SCHOOL_TZ);
  return schoolYearLabelFor(new Date(), tz);
}

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
    // Entry gate: admins (every importer) OR anyone holding at least one
    // delegated school-import cap. Per-kind authorization is enforced
    // separately by requireImportKind() / canImportKind() so a grades-only
    // clerk who passes here still can't touch FAST/roster routes.
    if (!hasAnySchoolImportCap(staff)) {
      res.status(403).json({ error: "Data import access required" });
      return;
    }
    (req as Request & { staff: StaffRow }).staff = staff;
    next();
  };
}

// Per-kind authorization for fixed-kind importer routes. Chains AFTER
// requireImporter() (which attaches req.staff). Admins bypass; a delegated
// clerk needs the cap mapped to this kind. Unmapped kinds (rosters / behavior
// / points_migration) reject every non-admin, preserving today's admin-only
// behavior for those importers.
function requireImportKind(kind: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const staff = (req as Request & { staff: StaffRow }).staff;
    if (!staff || !canImportKind(staff, kind)) {
      res.status(403).json({ error: "Data import access required" });
      return;
    }
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

// Hard caps for synchronous import requests. Larger district feeds should move
// to the future streaming/background-worker path instead of tying up the API
// process in one request.
const MAX_ROWS_PER_IMPORT = 15000;
const MAX_CSV_BYTES = 10 * 1024 * 1024;
const IMPORT_LOOP_YIELD_EVERY_ROWS = 1000;

const VALID_TARGETS = new Set<string>([
  "student_id",
  "assessment_name",
  "score",
  "score_level",
  "administered_at",
  "source",
  "school_code",
]);

function validateCsvPayload(csv: string, res: Response): boolean {
  if (!csv.trim()) {
    res.status(400).json({ error: "CSV body is required" });
    return false;
  }
  if (Buffer.byteLength(csv, "utf8") > MAX_CSV_BYTES) {
    res.status(413).json({
      error: `CSV exceeds the ${MAX_CSV_BYTES / 1024 / 1024}MB size limit. Split the file and try again.`,
    });
    return false;
  }
  return true;
}

function rejectTooManyRows(rowCount: number, res: Response): boolean {
  if (rowCount <= MAX_ROWS_PER_IMPORT) return false;
  res.status(400).json({
    error: `CSV exceeds the ${MAX_ROWS_PER_IMPORT}-row limit (got ${rowCount}). Split the file and try again.`,
  });
  return true;
}

async function yieldImportProcessing(index: number): Promise<void> {
  if (index > 0 && index % IMPORT_LOOP_YIELD_EVERY_ROWS === 0) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

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
  requireImportKind("assessments"),
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const csv = typeof req.body?.csv === "string" ? req.body.csv : "";
    if (!validateCsvPayload(csv, res)) return;
    const { headers, rows, parseError } = parseCsv(csv);
    if (parseError) {
      res.status(400).json({ error: parseError, headers });
      return;
    }
    if (rejectTooManyRows(rows.length, res)) return;
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
      await yieldImportProcessing(i);
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
  requireImportKind("assessments"),
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
    if (!validateCsvPayload(csv, res)) return;
    const { headers, rows, parseError } = parseCsv(csv);
    if (parseError) {
      res.status(400).json({ error: parseError });
      return;
    }
    if (rejectTooManyRows(rows.length, res)) return;
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
      await yieldImportProcessing(i);
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
        // Chunked upsert to keep parameter count under the pg limit
        // (~65k per query). 500 rows × ~8 cols = 4000 params, safe.
        // Conflict target = (school_id, student_id, assessment_name,
        // administered_at) — same as the unique index on the table.
        // SET clause uses COALESCE so blank columns in the CSV preserve
        // the existing value (matches the FAST importer's behavior:
        // partial uploads cannot wipe data already in the row).
        // importJobId is always set to the latest job so a rollback of
        // the most recent upload removes the row cleanly.
        const chunkSize = 500;
        for (let i = 0; i < valid.length; i += chunkSize) {
          const chunk = valid.slice(i, i + chunkSize);
          await tx
            .insert(assessmentsTable)
            .values(
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
            )
            .onConflictDoUpdate({
              target: [
                assessmentsTable.schoolId,
                assessmentsTable.studentId,
                assessmentsTable.assessmentName,
                assessmentsTable.administeredAt,
              ],
              set: {
                score: sql`COALESCE(EXCLUDED.score, ${assessmentsTable.score})`,
                scoreLevel: sql`COALESCE(EXCLUDED.score_level, ${assessmentsTable.scoreLevel})`,
                source: sql`COALESCE(EXCLUDED.source, ${assessmentsTable.source})`,
                importJobId: sql`EXCLUDED.import_job_id`,
              },
            });
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
    if (!validateCsvPayload(csv, res)) return;
    const { headers, rows, parseError } = parseCsv(csv);
    if (parseError) {
      res.status(400).json({ error: parseError, headers });
      return;
    }
    if (rejectTooManyRows(rows.length, res)) return;
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
        await yieldImportProcessing(i);
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
    if (!validateCsvPayload(csv, res)) return;
    const { headers, rows, parseError } = parseCsv(csv);
    if (parseError) {
      res.status(400).json({ error: parseError });
      return;
    }
    if (rejectTooManyRows(rows.length, res)) return;
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
      await yieldImportProcessing(i);
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
        // Same upsert pattern as the school-scope commit. District uploads
        // can route rows to many schools in a single job, so each row's
        // own schoolId is the conflict-target dimension — two schools'
        // identical (student, assessment, date) keys never collide.
        const chunkSize = 500;
        for (let i = 0; i < valid.length; i += chunkSize) {
          const chunk = valid.slice(i, i + chunkSize);
          await tx
            .insert(assessmentsTable)
            .values(
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
            )
            .onConflictDoUpdate({
              target: [
                assessmentsTable.schoolId,
                assessmentsTable.studentId,
                assessmentsTable.assessmentName,
                assessmentsTable.administeredAt,
              ],
              set: {
                score: sql`COALESCE(EXCLUDED.score, ${assessmentsTable.score})`,
                scoreLevel: sql`COALESCE(EXCLUDED.score_level, ${assessmentsTable.scoreLevel})`,
                source: sql`COALESCE(EXCLUDED.source, ${assessmentsTable.source})`,
                importJobId: sql`EXCLUDED.import_job_id`,
              },
            });
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

  // Delegated clerks (non-admins) only see jobs for the kinds they're allowed
  // to import. A specific ?kind request from such a clerk is rejected if it's
  // outside their grant; an unfiltered request is clamped to their allowed set.
  // Admins (canImportSchoolData) skip this and see everything in scope.
  let kindPredicate = kind ? eq(importJobsTable.kind, kind) : undefined;
  if (scope === "school" && !canImportSchoolData(staff)) {
    const allowed = allowedSchoolImportKinds(staff);
    if (kind) {
      if (!canImportKind(staff, kind)) {
        res.status(403).json({ error: "Data import access required" });
        return;
      }
    } else if (allowed.length === 0) {
      res.json([]);
      return;
    } else {
      kindPredicate = inArray(importJobsTable.kind, allowed);
    }
  }
  const where = kindPredicate
    ? and(scopePredicate, kindPredicate)
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
// GET /api/data-imports/export?kind=...&scope=school|district
//   Returns the school's CURRENT data for the requested kind as a CSV
//   the user can edit and re-upload. Column order matches the sample
//   CSVs served from /samples/, so a download → edit → upload round
//   trip uses the same headers the importer expects.
//
//   kind ∈ rosters | behavior | fast_scores | fast_prior_year | assessments
//
//   District scope is only honored for kinds that the importer itself
//   supports at district level (assessments today). Anything else
//   force-clamps to school scope.
//
//   Empty schools get a header-only CSV (still valid). Filenames
//   include kind + ISO date so re-downloads don't overwrite each other
//   in the user's Downloads folder.
// ---------------------------------------------------------------------------
router.get("/data-imports/export", requireImporter(), async (req, res) => {
  const staff = (req as Request & { staff: StaffRow }).staff;
  const kindRaw = typeof req.query.kind === "string" ? req.query.kind : "";
  const SUPPORTED = new Set([
    "rosters",
    "behavior",
    "fast_scores",
    "fast_prior_year",
    "assessments",
  ]);
  if (!SUPPORTED.has(kindRaw)) {
    res.status(400).json({ error: "Unknown kind" });
    return;
  }
  const scope =
    req.query.scope === "district" && kindRaw === "assessments"
      ? "district"
      : "school";
  // Delegated clerks may only export the kinds they can import (school scope).
  // Admins bypass via canImportKind. District scope is gated below by
  // canActAsDistrict, so this only matters for school-scope exports.
  if (scope === "school" && !canImportKind(staff, kindRaw)) {
    res.status(403).json({ error: "Data import access required" });
    return;
  }

  // ---- Optional row filters (kind-specific). All read off req.query
  // and silently ignored if the kind doesn't support them.
  // grades: comma-separated ints, e.g. "0,6,7" (0 = K). Used by every
  //   kind that can be joined back to studentsTable.
  // from / to: YYYY-MM-DD inclusive, used by behavior + assessments.
  // subject: "ela" | "math" | "algebra1" | "geometry" — FAST + EOC.
  // noteType: substring match (case-insensitive) — behavior only.
  // assessmentName: substring match (case-insensitive) — assessments only.
  // columns: comma-separated header names to keep in the output;
  //   omitted = include all. Required-by-importer columns are always
  //   re-injected at the end so the round-trip stays valid even if the
  //   user un-checks them in the UI.
  const parseGrades = (raw: unknown): number[] | null => {
    if (typeof raw !== "string" || !raw.trim()) return null;
    const out: number[] = [];
    for (const tok of raw.split(",")) {
      const t = tok.trim();
      if (!t) continue;
      // Accept both "K" and "0" as kindergarten.
      if (t.toUpperCase() === "K") {
        out.push(0);
        continue;
      }
      const n = Number(t);
      if (Number.isFinite(n) && n >= 0 && n <= 13) out.push(Math.floor(n));
    }
    return out.length > 0 ? Array.from(new Set(out)) : null;
  };
  const grades = parseGrades(req.query.grades);
  const fromYmd =
    typeof req.query.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from)
      ? req.query.from
      : null;
  const toYmd =
    typeof req.query.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to)
      ? req.query.to
      : null;
  const subjectFilter =
    req.query.subject === "ela" ||
    req.query.subject === "math" ||
    req.query.subject === "algebra1" ||
    req.query.subject === "geometry"
      ? (req.query.subject as "ela" | "math" | "algebra1" | "geometry")
      : null;
  // Escape LIKE/ILIKE wildcards so a user typing "%" doesn't bypass
  // substring matching and dump every row in their school. Backslash
  // first, then the two SQL wildcards. Postgres uses backslash as the
  // default LIKE escape char.
  const escapeLike = (s: string): string =>
    s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
  const noteTypeFilter =
    typeof req.query.noteType === "string" && req.query.noteType.trim()
      ? escapeLike(req.query.noteType.trim().toLowerCase())
      : null;
  const assessmentNameFilter =
    typeof req.query.assessmentName === "string" &&
    req.query.assessmentName.trim()
      ? escapeLike(req.query.assessmentName.trim().toLowerCase())
      : null;
  const columnsFilter =
    typeof req.query.columns === "string" && req.query.columns.trim()
      ? new Set(
          req.query.columns
            .split(",")
            .map((c) => c.trim())
            .filter(Boolean),
        )
      : null;
  // teacherStaffId / period: restrict the export to students enrolled in a
  // specific teacher's class and/or a specific class period. Both optional
  // and independent (teacher alone, period alone, or both). Applies to every
  // kind — each export is student-centric, so we intersect its student set
  // with the section_roster ⨝ class_sections enrollment set below.
  const teacherStaffId =
    typeof req.query.teacherStaffId === "string" &&
    /^\d+$/.test(req.query.teacherStaffId)
      ? Number(req.query.teacherStaffId)
      : null;
  const periodFilter =
    typeof req.query.period === "string" && /^\d+$/.test(req.query.period)
      ? Number(req.query.period)
      : null;

  let schoolIds: number[] = [];
  if (scope === "district") {
    if (!canActAsDistrict(staff)) {
      res.status(403).json({ error: "District access required" });
      return;
    }
    const districtId = await requireActorDistrict(staff, res);
    if (districtId == null) return;
    const ds = await db
      .select({ id: schoolsTable.id })
      .from(schoolsTable)
      .where(eq(schoolsTable.districtId, districtId));
    schoolIds = ds.map((s) => s.id);
    if (schoolIds.length === 0) {
      sendCsv(res, kindRaw, []);
      return;
    }
  } else {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    schoolIds = [schoolId];
  }
  // Section-enrollment subselect: the set of student_ids enrolled in a
  // section matching the teacher and/or period filters. Null when neither
  // filter is set. class_sections is school-scoped (teacher/period unique
  // per school) so this naturally narrows even a district-scope export to
  // the relevant school(s). Planning periods are excluded — they hold no
  // real roster. Reused at most once per request (one kind runs).
  const sectionStudentSub =
    teacherStaffId != null || periodFilter != null
      ? db
          .select({ sid: sectionRosterTable.studentId })
          .from(sectionRosterTable)
          .innerJoin(
            classSectionsTable,
            eq(sectionRosterTable.sectionId, classSectionsTable.id),
          )
          .where(
            and(
              // Explicit tenant predicates on BOTH joined tables — the
              // codebase invariant (student_id text is not globally unique)
              // requires school-scoping every tenant table, even though the
              // sectionId→class_sections PK join already narrows the section.
              inArray(sectionRosterTable.schoolId, schoolIds),
              inArray(classSectionsTable.schoolId, schoolIds),
              eq(classSectionsTable.isPlanning, false),
              ...(teacherStaffId != null
                ? [eq(classSectionsTable.teacherStaffId, teacherStaffId)]
                : []),
              ...(periodFilter != null
                ? [eq(classSectionsTable.period, periodFilter)]
                : []),
            )!,
          )
      : null;
  // Build (header, rows) per kind. Rows are arrays of strings/numbers
  // in the same order as the headers; Papa.unparse handles quoting and
  // newlines.
  let headers: string[] = [];
  let rows: (string | number | null)[][] = [];

  if (kindRaw === "rosters") {
    // Roster filter: grade + optional teacher/period (via section enrollment).
    const rosterConds = [inArray(studentsTable.schoolId, schoolIds)];
    if (grades) rosterConds.push(inArray(studentsTable.grade, grades));
    if (sectionStudentSub)
      rosterConds.push(inArray(studentsTable.studentId, sectionStudentSub));
    const rosterWhere = and(...rosterConds)!;
    const list = await db
      .select({
        studentId: studentsTable.studentId,
        firstName: studentsTable.firstName,
        lastName: studentsTable.lastName,
        grade: studentsTable.grade,
        parentName: studentsTable.parentName,
        parentEmail: studentsTable.parentEmail,
        parentPhone: studentsTable.parentPhone,
        gender: studentsTable.gender,
        ell: studentsTable.ell,
        ese: studentsTable.ese,
        is504: studentsTable.is504,
        // Pulled so the export round-trips the student's PBIS house
        // assignment. Maps to the optional `house_name` importer
        // column — blank/unknown names fall back to the smallest
        // house at insert time (recommendNextHouse).
        houseId: studentsTable.houseId,
      })
      .from(studentsTable)
      .where(rosterWhere)
      .orderBy(studentsTable.lastName, studentsTable.firstName);
    // House name lookup for the export. One query per export call,
    // bounded to the requested schools — cheap (≤ a few dozen rows
    // total even for a district-wide export).
    const houseList = await db
      .select({
        id: housesTable.id,
        name: housesTable.name,
      })
      .from(housesTable)
      .where(inArray(housesTable.schoolId, schoolIds));
    const houseNameById = new Map(houseList.map((h) => [h.id, h.name]));
    headers = [
      "student_id",
      "first_name",
      "last_name",
      "grade",
      "parent_name",
      "parent_email",
      "parent_phone",
      "gender",
      "ell",
      "ese",
      "is_504",
      // Optional on import. Blank cells get auto-assigned to the
      // smallest house at insert time; unknown names also fall back.
      "house_name",
    ];
    rows = list.map((r) => [
      r.studentId,
      r.firstName,
      r.lastName,
      // Grade 0 in the DB = Kindergarten; export as "K" so the round
      // trip preserves what staff actually expects to see.
      r.grade === 0 ? "K" : r.grade,
      r.parentName ?? "",
      r.parentEmail ?? "",
      r.parentPhone ?? "",
      r.gender ?? "",
      r.ell ? "Y" : "N",
      r.ese ? "Y" : "N",
      r.is504 ? "Y" : "N",
      r.houseId == null ? "" : (houseNameById.get(r.houseId) ?? ""),
    ]);
  } else if (kindRaw === "behavior") {
    // Build a grade-filter subselect once; reused below for FAST +
    // assessments. Returns the set of student_ids in the selected
    // schools that match the requested grades.
    const gradeSubselect = grades
      ? db
          .select({ sid: studentsTable.studentId })
          .from(studentsTable)
          .where(
            and(
              inArray(studentsTable.schoolId, schoolIds),
              inArray(studentsTable.grade, grades),
            )!,
          )
      : null;
    const conds = [inArray(supportNotesTable.schoolId, schoolIds)];
    if (gradeSubselect)
      conds.push(inArray(supportNotesTable.studentId, gradeSubselect));
    if (sectionStudentSub)
      conds.push(inArray(supportNotesTable.studentId, sectionStudentSub));
    if (fromYmd)
      conds.push(gte(supportNotesTable.createdAt, fromYmd));
    if (toYmd)
      conds.push(lte(supportNotesTable.createdAt, `${toYmd}T23:59:59`));
    if (noteTypeFilter)
      conds.push(ilike(supportNotesTable.noteType, `%${noteTypeFilter}%`));
    const list = await db
      .select({
        studentId: supportNotesTable.studentId,
        noteType: supportNotesTable.noteType,
        noteText: supportNotesTable.noteText,
        staffName: supportNotesTable.staffName,
        createdAt: supportNotesTable.createdAt,
      })
      .from(supportNotesTable)
      .where(and(...conds)!)
      .orderBy(desc(supportNotesTable.createdAt));
    headers = [
      "student_id",
      "note_type",
      "note_text",
      "staff_name",
      "created_at",
    ];
    rows = list.map((r) => [
      r.studentId,
      r.noteType ?? "",
      r.noteText ?? "",
      r.staffName ?? "",
      // createdAt is stored as text (legacy) — pass through verbatim.
      r.createdAt ?? "",
    ]);
  } else if (kindRaw === "fast_scores") {
    const fsGradeSub = grades
      ? db
          .select({ sid: studentsTable.studentId })
          .from(studentsTable)
          .where(
            and(
              inArray(studentsTable.schoolId, schoolIds),
              inArray(studentsTable.grade, grades),
            )!,
          )
      : null;
    const fsConds = [inArray(studentFastScoresTable.schoolId, schoolIds)];
    if (fsGradeSub)
      fsConds.push(inArray(studentFastScoresTable.studentId, fsGradeSub));
    if (sectionStudentSub)
      fsConds.push(inArray(studentFastScoresTable.studentId, sectionStudentSub));
    if (subjectFilter)
      fsConds.push(eq(studentFastScoresTable.subject, subjectFilter));
    const list = await db
      .select({
        studentId: studentFastScoresTable.studentId,
        subject: studentFastScoresTable.subject,
        pm1: studentFastScoresTable.pm1,
        pm2: studentFastScoresTable.pm2,
        pm3: studentFastScoresTable.pm3,
        priorYearScore: studentFastScoresTable.priorYearScore,
        priorYearBq: studentFastScoresTable.priorYearBq,
      })
      .from(studentFastScoresTable)
      .where(and(...fsConds)!)
      .orderBy(
        studentFastScoresTable.studentId,
        studentFastScoresTable.subject,
      );
    headers = [
      "student_id",
      "subject",
      "pm1",
      "pm2",
      "pm3",
      "prior_year_score",
      "prior_year_bq",
    ];
    rows = list.map((r) => [
      r.studentId,
      // Export the user-friendly label (ELA/Math) — the importer
      // accepts both that and the lowercase code on re-upload.
      r.subject === "ela" ? "ELA" : "Math",
      r.pm1 ?? "",
      r.pm2 ?? "",
      r.pm3 ?? "",
      r.priorYearScore ?? "",
      r.priorYearBq ? "Y" : "N",
    ]);
  } else if (kindRaw === "fast_prior_year") {
    const fpyGradeSub = grades
      ? db
          .select({ sid: studentsTable.studentId })
          .from(studentsTable)
          .where(
            and(
              inArray(studentsTable.schoolId, schoolIds),
              inArray(studentsTable.grade, grades),
            )!,
          )
      : null;
    const fpyConds = [inArray(studentFastScoresTable.schoolId, schoolIds)];
    if (fpyGradeSub)
      fpyConds.push(inArray(studentFastScoresTable.studentId, fpyGradeSub));
    if (sectionStudentSub)
      fpyConds.push(inArray(studentFastScoresTable.studentId, sectionStudentSub));
    if (subjectFilter)
      fpyConds.push(eq(studentFastScoresTable.subject, subjectFilter));
    const list = await db
      .select({
        studentId: studentFastScoresTable.studentId,
        subject: studentFastScoresTable.subject,
        priorYearScore: studentFastScoresTable.priorYearScore,
        priorYearBq: studentFastScoresTable.priorYearBq,
      })
      .from(studentFastScoresTable)
      .where(and(...fpyConds)!)
      .orderBy(
        studentFastScoresTable.studentId,
        studentFastScoresTable.subject,
      );
    headers = ["student_id", "subject", "prior_year_score", "prior_year_bq"];
    rows = list
      // Only include rows that actually have a prior-year score; this
      // is the prior-year-only export, so empty rows are noise.
      .filter((r) => r.priorYearScore != null)
      .map((r) => [
        r.studentId,
        r.subject === "ela" ? "ELA" : "Math",
        r.priorYearScore ?? "",
        r.priorYearBq ? "Y" : "N",
      ]);
  } else if (kindRaw === "assessments") {
    const aGradeSub = grades
      ? db
          .select({ sid: studentsTable.studentId })
          .from(studentsTable)
          .where(
            and(
              inArray(studentsTable.schoolId, schoolIds),
              inArray(studentsTable.grade, grades),
            )!,
          )
      : null;
    const aConds = [inArray(assessmentsTable.schoolId, schoolIds)];
    if (aGradeSub)
      aConds.push(inArray(assessmentsTable.studentId, aGradeSub));
    if (sectionStudentSub)
      aConds.push(inArray(assessmentsTable.studentId, sectionStudentSub));
    if (fromYmd)
      aConds.push(gte(assessmentsTable.administeredAt, new Date(fromYmd)));
    if (toYmd)
      aConds.push(
        lte(assessmentsTable.administeredAt, new Date(`${toYmd}T23:59:59`)),
      );
    if (assessmentNameFilter)
      aConds.push(
        ilike(assessmentsTable.assessmentName, `%${assessmentNameFilter}%`),
      );
    const list = await db
      .select({
        studentId: assessmentsTable.studentId,
        assessmentName: assessmentsTable.assessmentName,
        score: assessmentsTable.score,
        scoreLevel: assessmentsTable.scoreLevel,
        administeredAt: assessmentsTable.administeredAt,
        source: assessmentsTable.source,
        schoolId: assessmentsTable.schoolId,
      })
      .from(assessmentsTable)
      .where(and(...aConds)!)
      .orderBy(desc(assessmentsTable.administeredAt));
    // Build a school_code map so district exports can round-trip
    // back through the district importer (which routes by school_code).
    const codeMap = new Map<number, string>();
    if (scope === "district") {
      const ss = await db
        .select({
          id: schoolsTable.id,
          code: schoolsTable.stateSchoolCode,
        })
        .from(schoolsTable)
        .where(inArray(schoolsTable.id, schoolIds));
      for (const s of ss) codeMap.set(s.id, s.code ?? "");
    }
    headers = [
      "student_id",
      "assessment_name",
      "score",
      "score_level",
      "administered_at",
      "source",
      "school_code",
    ];
    rows = list.map((r) => [
      r.studentId,
      r.assessmentName,
      r.score ?? "",
      r.scoreLevel ?? "",
      // ISO date (YYYY-MM-DD) — easier to edit in Excel than full ISO.
      r.administeredAt instanceof Date
        ? r.administeredAt.toISOString().slice(0, 10)
        : String(r.administeredAt ?? "").slice(0, 10),
      r.source ?? "",
      scope === "district" ? codeMap.get(r.schoolId) ?? "" : "",
    ]);
  }

  // Column projection. We always force-keep the importer's required
  // columns even if the user un-checks them in the UI — otherwise the
  // CSV can't round-trip back through the importer. The required set
  // is intentionally hard-coded here (not pulled from the importer
  // config) because the export endpoint owns its own header order.
  if (columnsFilter && headers.length > 0) {
    const REQUIRED: Record<string, string[]> = {
      rosters: ["student_id", "first_name", "last_name", "grade"],
      behavior: ["student_id", "note_text"],
      fast_scores: ["student_id", "subject"],
      fast_prior_year: ["student_id", "subject", "prior_year_score"],
      assessments: ["student_id", "assessment_name", "administered_at"],
    };
    for (const r of REQUIRED[kindRaw] ?? []) columnsFilter.add(r);
    const keepIdx: number[] = [];
    headers.forEach((h, i) => {
      if (columnsFilter!.has(h)) keepIdx.push(i);
    });
    if (keepIdx.length > 0 && keepIdx.length < headers.length) {
      headers = keepIdx.map((i) => headers[i]!);
      rows = rows.map((r) => keepIdx.map((i) => r[i] ?? ""));
    }
  }
  sendCsv(res, kindRaw, [headers, ...rows]);
});

// ---------------------------------------------------------------------------
// GET /api/data-imports/export/section-filters
//   Populates the export panel's Teacher + Period pickers with exactly the
//   teachers and periods that have a real (non-planning) section this school
//   year, so a chosen filter never yields a surprise-empty export. School
//   scope only — teacher/period are school concepts. Gated by requireImporter
//   (same actors as the export itself). Distinct path from /export so no
//   route shadowing.
// ---------------------------------------------------------------------------
router.get(
  "/data-imports/export/section-filters",
  requireImporter(),
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const secs = await db
      .select({
        teacherStaffId: classSectionsTable.teacherStaffId,
        period: classSectionsTable.period,
      })
      .from(classSectionsTable)
      .where(
        and(
          eq(classSectionsTable.schoolId, schoolId),
          eq(classSectionsTable.isPlanning, false),
        )!,
      );
    const teacherIds = Array.from(new Set(secs.map((s) => s.teacherStaffId)));
    const periods = Array.from(new Set(secs.map((s) => s.period))).sort(
      (a, b) => a - b,
    );
    const staffRows = teacherIds.length
      ? await db
          .select({
            id: staffTable.id,
            displayName: staffTable.displayName,
          })
          .from(staffTable)
          .where(
            and(
              eq(staffTable.schoolId, schoolId),
              inArray(staffTable.id, teacherIds),
            )!,
          )
      : [];
    const nameById = new Map(staffRows.map((s) => [s.id, s.displayName]));
    const teachers = teacherIds
      .map((id) => ({ id, displayName: nameById.get(id) ?? null }))
      .filter((t) => t.displayName)
      .sort((a, b) =>
        (a.displayName ?? "").localeCompare(b.displayName ?? ""),
      );
    res.json({ teachers, periods });
  },
);

// CSV writer used by the export endpoint above. Pulled out so each
// kind branch stays focused on its query shape.
function sendCsv(
  res: Response,
  kind: string,
  rowsWithHeader: (string | number | null)[][],
): void {
  const csv = Papa.unparse(rowsWithHeader, { quotes: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `pulseedu-${kind.replace(/_/g, "-")}-${stamp}.csv`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}"`,
  );
  // Prepend BOM so Excel opens it as UTF-8 instead of Latin-1, which
  // would mangle accented names on the roster export.
  res.send("\uFEFF" + csv);
}

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
    const id = parseInt(String(req.params.id), 10);
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
      // A delegated clerk can only roll back the kinds they can import.
      // Admins bypass via canImportKind. (District jobs above never reach a
      // delegated clerk — they can't canActAsDistrict.)
      if (!canImportKind(staff, job.kind)) {
        res.status(403).json({ error: "Data import access required" });
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
    // Gradebook uses job-chaining with a TWO-generation retention window, so
    // only a SINGLE-STEP undo is restorable: rolling back the latest committed
    // gradebook job exposes the prior generation. Rolling back an OLDER job
    // would leave the latest pointing at a generation whose rows were already
    // pruned (empty grades), so we refuse it and require undoing newest-first.
    if (job.kind === "gradebook" && job.schoolId != null) {
      const [latest] = await db
        .select({ id: importJobsTable.id })
        .from(importJobsTable)
        .where(
          and(
            eq(importJobsTable.schoolId, job.schoolId),
            eq(importJobsTable.kind, "gradebook"),
            eq(importJobsTable.status, "committed"),
          ),
        )
        .orderBy(desc(importJobsTable.id))
        .limit(1);
      if (!latest || latest.id !== job.id) {
        res.status(409).json({
          error:
            "Only the most recent gradebook upload can be rolled back. Undo newer uploads first.",
        });
        return;
      }
    }
    // FAST score and FAST prior-year imports now carry an
    // `import_job_id` on every row written by the upsert path. Their
    // KindConfig.rollback() implementations DELETE WHERE
    // import_job_id = :id AND school_id = :id (defense-in-depth). Rows
    // written before this column existed have NULL import_job_id and
    // therefore survive any rollback — that's the desired behavior.
    const deleted = await db.transaction(async (tx) => {
      let count = 0;
      // Multi-kind kinds (rosters, behavior) live in the registry. They
      // only support school scope; the registry rollback() does the
      // schoolId-AND defense-in-depth itself.
      const cfg = KIND_CONFIGS[job.kind];
      if (cfg && job.schoolId != null) {
        count = await cfg.rollback(tx, id, job.schoolId);
      } else if (job.kind === "fast_florida" && job.schoolId != null) {
        // FAST Phase 1 — rolling back a Florida xlsx import deletes
        // every item_response row stamped with this jobId, then
        // deletes any student_fast_scores row whose import_job_id
        // matches (defense-in-depth on schoolId). Pre-existing PM
        // values written by an earlier job survive because their
        // import_job_id points at that earlier job.
        const itemRes = await tx
          .delete(studentFastItemResponsesTable)
          .where(
            and(
              eq(studentFastItemResponsesTable.importJobId, id),
              eq(studentFastItemResponsesTable.schoolId, job.schoolId),
            ),
          );
        const scoreRes = await tx
          .delete(studentFastScoresTable)
          .where(
            and(
              eq(studentFastScoresTable.importJobId, id),
              eq(studentFastScoresTable.schoolId, job.schoolId),
            ),
          );
        count =
          ((itemRes as unknown as { rowCount?: number }).rowCount ?? 0) +
          ((scoreRes as unknown as { rowCount?: number }).rowCount ?? 0);
      } else if (job.kind === "gradebook" && job.schoolId != null) {
        // Gradebook uses job-chaining: each upload keeps the prior generation's
        // rows, so deleting THIS job's rows + flipping its status to
        // rolled_back makes the previous committed gradebook job the latest
        // again — loadCurrentGrades then reads it, restoring the prior grades.
        const r = await tx
          .delete(studentCourseGradesTable)
          .where(
            and(
              eq(studentCourseGradesTable.importJobId, id),
              eq(studentCourseGradesTable.schoolId, job.schoolId),
            ),
          );
        count = (r as unknown as { rowCount?: number }).rowCount ?? 0;
      } else if (job.kind === "assessments") {
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
// GET /api/data-imports/jobs/:id/skipped-houses.csv
//   Re-emits the rows the roster importer rejected for strict
//   house-name matching as a CSV with the original CSV columns. The
//   admin can fix the bad house_name values in their SIS (or directly
//   in the file) and re-upload. Only roster jobs and only rejections
//   tagged code === "unrecognized_house" are included.
// ---------------------------------------------------------------------------
router.get(
  "/data-imports/jobs/:id/skipped-houses.csv",
  requireImporter(),
  async (req, res) => {
    const id = parseInt(String(req.params.id), 10);
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
    // Same scope check as rollback: school-scope jobs require same
    // school. Roster imports are school-only today, but mirror the
    // rollback shape so this stays correct if that ever changes.
    if (job.schoolId != null) {
      const schoolId = requireSchool(req, res);
      if (!schoolId) return;
      if (job.schoolId !== schoolId) {
        res.status(404).json({ error: "Job not found" });
        return;
      }
      const staff = (req as Request & { staff: StaffRow }).staff;
      if (!canImportKind(staff, job.kind)) {
        res.status(403).json({ error: "Data import access required" });
        return;
      }
    } else {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    if (job.kind !== "rosters") {
      res
        .status(400)
        .json({ error: "Skipped-house export is only available for roster imports" });
      return;
    }
    const log = Array.isArray(job.errorLog)
      ? (job.errorLog as Array<{
          row: number;
          message: string;
          raw?: Record<string, string>;
          code?: string;
          bucket?: string;
        }>)
      : [];
    const skipped = log.filter(
      (e) => e.code === "unrecognized_house" && e.raw && typeof e.raw === "object",
    );
    // Recover the original CSV header order from the union of raw row
    // keys. Papa.parse preserves insertion order per row, so iterating
    // entries in seen order gives us the original column order for the
    // first row, plus any columns that only appear in later rows.
    const headerOrder: string[] = [];
    const seenHeader = new Set<string>();
    for (const e of skipped) {
      for (const k of Object.keys(e.raw!)) {
        if (!seenHeader.has(k)) {
          seenHeader.add(k);
          headerOrder.push(k);
        }
      }
    }
    const rowsOut = skipped.map((e) => {
      const out: Record<string, string> = {};
      for (const h of headerOrder) out[h] = e.raw![h] ?? "";
      return out;
    });
    const csv =
      headerOrder.length === 0
        ? ""
        : Papa.unparse({ fields: headerOrder, data: rowsOut }, { quotes: true });
    const safeName = String(job.filename || "roster")
      .replace(/\.csv$/i, "")
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .slice(0, 80);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="skipped-houses_${safeName}_job${job.id}.csv"`,
    );
    res.send(csv);
  },
);

// ---------------------------------------------------------------------------
// ===========================================================================
// Multi-kind importer registry. Adds rosters + behavior on top of the
// existing assessments importer. Each kind plugs in its own targets,
// validators, parser, insert chunker, and rollback predicate; the route
// handlers below are kind-agnostic and just look the config up by name.
// School scope only for these kinds — district roster pushes and
// district-wide behavior feeds aren't a real-world workflow today.
// ===========================================================================

type KindParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

// Per-commit options carried in the request body for kinds that need a
// runtime switch the CSV itself can't express. Currently only the PBIS
// points-migration importer uses these (the "count as earned" toggle + a
// free-text source label). Optional + ignored by every other kind.
interface ImportCommitOptions {
  countsTowardHouses?: boolean;
  source?: string;
}

interface KindConfig<T = unknown> {
  validTargets: Set<string>;
  requiredFields: string[];
  headerSynonyms: Record<string, string[]>;
  parseRow: (
    row: Record<string, string>,
    mapping: Record<string, string>,
  ) => KindParseResult<T>;
  // Insert one chunk inside the caller's transaction. Returns the count
  // actually written (which may be < parsed.length for upsert-skip kinds
  // like rosters where duplicate student_ids are no-ops). `options` is the
  // optional per-commit switch payload (only the points-migration kind
  // reads it; all existing 4-arg implementations ignore the extra param).
  insertChunk: (
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    parsed: T[],
    schoolId: number,
    jobId: number,
    options?: ImportCommitOptions,
  ) => Promise<number>;
  // Rollback: delete every row this job inserted. Returns row count.
  rollback: (
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    jobId: number,
    schoolId: number,
  ) => Promise<number>;
  // Optional: augment the preview response with kind-specific extras.
  // Called after parsing once we know which rows are valid, so the hook
  // can inspect parsed values + cross-reference school-scoped state
  // (e.g. matching CSV house_name against houses.name). Must not mutate.
  previewExtras?: (
    parsedValues: T[],
    schoolId: number,
  ) => Promise<Record<string, unknown>>;
  // Optional: post-parse, pre-insert filter. Runs in the commit handler
  // after parseRow has rejected malformed rows but before insertChunk
  // touches the database. Used by kinds that need to enforce
  // school-scoped policy that parseRow can't see (e.g. the Roster
  // importer's strict house-name mode, which rejects rows whose
  // `house_name` doesn't match any configured house when the
  // `strictHouseNameMatch` school setting is on). Items keep their
  // 1-based CSV row number so rejections get the same `row` field
  // parseRow-produced errors do.
  precommitValidate?: (
    items: Array<{ rowIndex: number; value: T; raw: Record<string, string> }>,
    schoolId: number,
  ) => Promise<{
    kept: T[];
    rejected: Array<{
      row: number;
      message: string;
      raw?: Record<string, string>;
      // Machine-readable rejection reason. Lets the UI surface a
      // dedicated "skipped due to unrecognized house" section and a
      // fixup CSV download. Optional so other future rejection
      // categories can stay generic.
      code?: string;
      // Distinct value that triggered the rejection (e.g. the
      // unrecognized house name) — used for grouping in the UI.
      bucket?: string;
    }>;
  }>;
}

// Same shape as autoMapHeaders but reads its synonym table from the
// passed-in config so each kind can have its own field set.
function autoMapHeadersForConfig(
  csvHeaders: string[],
  config: KindConfig,
): { mapping: Record<string, string>; unmappedCsv: string[] } {
  const taken = new Set<string>();
  const mapping: Record<string, string> = {};
  const normToOriginal = new Map<string, string>();
  for (const h of csvHeaders) {
    if (!normToOriginal.has(normalizeHeader(h))) {
      normToOriginal.set(normalizeHeader(h), h);
    }
  }
  for (const target of Object.keys(config.headerSynonyms)) {
    if (taken.has(target)) continue;
    for (const syn of config.headerSynonyms[target]) {
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

// Same shape as validateMapping but kind-aware.
function validateMappingForConfig(
  mapping: Record<string, string>,
  csvHeaders: string[],
  config: KindConfig,
): string | null {
  const headerSet = new Set(csvHeaders);
  const seenTargets = new Set<string>();
  for (const [csvCol, target] of Object.entries(mapping)) {
    if (!headerSet.has(csvCol)) {
      return `Mapping references unknown CSV column: "${csvCol}"`;
    }
    if (!config.validTargets.has(target)) {
      return `Mapping references unknown target field: "${target}"`;
    }
    if (seenTargets.has(target)) {
      return `Two CSV columns map to the same target: "${target}"`;
    }
    seenTargets.add(target);
  }
  for (const req of config.requiredFields) {
    if (!seenTargets.has(req)) {
      return `Mapping missing required field: "${req}"`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rosters config — one row per student. Targets the students table.
// Behavior on conflict: skip (insert-only). The students table has a
// GLOBAL UNIQUE on student_id, so duplicates across all schools collide.
// We use onConflictDoNothing and report skipped rows in successRows
// counts so the school admin sees "98 imported, 12 skipped (already
// exist)" instead of a hard failure.
// ---------------------------------------------------------------------------
type ParsedRoster = {
  studentId: string;
  firstName: string;
  lastName: string;
  grade: number;
  parentName: string | null;
  parentEmail: string | null;
  parentPhone: string | null;
  gender: string | null;
  ell: boolean | undefined;
  ese: boolean | undefined;
  is504: boolean | undefined;
  // Optional PBIS house affiliation by display name (case-insensitive
  // match against houses.name for the importer's school). Resolved to
  // houses.id at insert time. Brand-new students whose row has no
  // house_name (or an unmatched value) fall back to the smallest-house
  // recommendation so rosters stay balanced as kids arrive through the
  // year.
  houseName: string | null;
};

// Boolean coercion for CSV columns. Accepts the conventions actual SIS
// exports use: Y/N, Yes/No, true/false, 1/0, T/F. Empty / whitespace /
// anything else → false (the safer default — flagging a non-ELL student as
// ELL is more harmful than the reverse). Returns false for nullish input
// so optional() can be wrapped around it.
function parseBoolFlag(raw: string | null | undefined): boolean {
  if (raw == null) return false;
  const v = raw.toString().trim().toLowerCase();
  if (!v) return false;
  return v === "y" || v === "yes" || v === "true" || v === "t" || v === "1";
}

// Levenshtein distance between two strings (iterative, O(n*m)). Used
// only to suggest the closest configured house name for an
// unrecognized CSV value (e.g. "Pheonix" → "Phoenix"); inputs are
// short school-house names, so the quadratic cost is irrelevant.
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost,
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

// Returns the closest configured house name to `value` if one is
// within a small edit distance, else undefined. Threshold scales with
// the input length so single-character names don't accept wild
// matches but typical 6–10 char names tolerate 2-character typos
// (the "Pheonix"/"Phoenix" case).
function suggestHouseName(
  value: string,
  knownNames: string[],
): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || knownNames.length === 0) return undefined;
  const lower = trimmed.toLowerCase();
  const threshold = Math.max(1, Math.min(3, Math.ceil(trimmed.length / 3)));
  let best: { name: string; dist: number } | undefined;
  for (const name of knownNames) {
    const d = levenshtein(lower, name.toLowerCase());
    if (d === 0) return name;
    if (d <= threshold && (!best || d < best.dist)) {
      best = { name, dist: d };
    }
  }
  return best?.name;
}

const ROSTERS_CONFIG: KindConfig<ParsedRoster> = {
  validTargets: new Set([
    "student_id",
    "first_name",
    "last_name",
    "grade",
    "parent_name",
    "parent_email",
    "parent_phone",
    // Insights v1 demographics. CT ELA / CT Math intentionally NOT in
    // the importer — those are MTSS-assigned via the UI only.
    "gender",
    "ell",
    "ese",
    "is_504",
    "house_name",
  ]),
  requiredFields: ["student_id", "first_name", "last_name", "grade"],
  headerSynonyms: {
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
    first_name: ["first_name", "firstname", "first", "given_name", "fname"],
    last_name: [
      "last_name",
      "lastname",
      "last",
      "family_name",
      "surname",
      "lname",
    ],
    grade: ["grade", "grade_level", "gradelevel", "year", "yr"],
    parent_name: [
      "parent_name",
      "parentname",
      "guardian_name",
      "guardianname",
      "contact_name",
    ],
    parent_email: [
      "parent_email",
      "parentemail",
      "guardian_email",
      "contact_email",
      "email",
    ],
    parent_phone: [
      "parent_phone",
      "parentphone",
      "guardian_phone",
      "contact_phone",
      "phone",
    ],
    gender: ["gender", "sex", "gender_identity"],
    ell: ["ell", "esol", "lep", "ell_flag", "english_learner", "el_status"],
    ese: ["ese", "sped", "swd", "iep", "ese_flag", "exceptional_student"],
    is_504: ["504", "is_504", "section_504", "504_plan", "fivezerofour"],
    house_name: ["house", "house_name", "housename", "pbis_house", "team"],
  },
  parseRow(row, mapping) {
    const target: Record<string, string> = {};
    for (const [csvCol, tgt] of Object.entries(mapping)) {
      target[tgt] = csvCol;
    }
    for (const req of this.requiredFields) {
      const csvCol = target[req];
      if (!csvCol) {
        return { ok: false, message: `Missing required column: ${req}` };
      }
      const raw = (row[csvCol] ?? "").toString().trim();
      if (!raw) {
        return { ok: false, message: `Empty value for ${req}` };
      }
    }
    const studentId = row[target.student_id].toString().trim();
    const firstName = row[target.first_name].toString().trim();
    const lastName = row[target.last_name].toString().trim();
    const gradeRaw = row[target.grade].toString().trim();
    // Accept "K", "k", "kindergarten" → 0 as a convenience.
    let grade: number;
    if (/^k(indergarten)?$/i.test(gradeRaw)) {
      grade = 0;
    } else {
      grade = parseInt(gradeRaw.replace(/[^0-9-]/g, ""), 10);
      if (!Number.isFinite(grade)) {
        return { ok: false, message: `Invalid grade: "${gradeRaw}"` };
      }
    }
    if (grade < 0 || grade > 12) {
      return {
        ok: false,
        message: `Grade out of range (0-12): "${gradeRaw}"`,
      };
    }
    const optional = (key: string): string | null => {
      const col = target[key];
      if (!col) return null;
      const v = (row[col] ?? "").toString().trim();
      return v || null;
    };
    // Optional flag — only sets the field if the column was mapped.
    // Unmapped flags fall through to the table default (false).
    const optionalFlag = (key: string): boolean | undefined => {
      const col = target[key];
      if (!col) return undefined;
      return parseBoolFlag(row[col]?.toString());
    };
    return {
      ok: true,
      value: {
        studentId,
        firstName,
        lastName,
        grade,
        parentName: optional("parent_name"),
        parentEmail: optional("parent_email"),
        parentPhone: optional("parent_phone"),
        gender: optional("gender"),
        ell: optionalFlag("ell"),
        ese: optionalFlag("ese"),
        is504: optionalFlag("is_504"),
        houseName: optional("house_name"),
      },
    };
  },
  // Roster preview surfaces house_name values the importer could not
  // match to one of this school's houses. These rows still commit (they
  // fall back to the smallest-house rotation in insertChunk), but the
  // banner gives admins a chance to fix typos like "Pheonix" vs
  // "Phoenix" before they silently land as rebalanced.
  async previewExtras(parsed, schoolId) {
    const withHouse = parsed.filter(
      (p): p is ParsedRoster & { houseName: string } =>
        typeof p.houseName === "string" && p.houseName.trim().length > 0,
    );
    if (withHouse.length === 0) return {};
    const [houseRows, settingsRow] = await Promise.all([
      db
        .select({ name: housesTable.name })
        .from(housesTable)
        .where(eq(housesTable.schoolId, schoolId)),
      db
        .select({
          strictHouseNameMatch: schoolSettingsTable.strictHouseNameMatch,
        })
        .from(schoolSettingsTable)
        .where(eq(schoolSettingsTable.schoolId, schoolId)),
    ]);
    const knownNames = houseRows.map((h) => h.name.trim());
    const known = new Set(knownNames.map((n) => n.toLowerCase()));
    let count = 0;
    const distinct = new Map<string, string>();
    for (const p of withHouse) {
      const trimmed = p.houseName.trim();
      if (known.has(trimmed.toLowerCase())) continue;
      count++;
      if (!distinct.has(trimmed.toLowerCase())) {
        distinct.set(trimmed.toLowerCase(), trimmed);
      }
    }
    if (count === 0) return {};
    const samples = Array.from(distinct.values())
      .slice(0, 10)
      .map((value) => {
        const suggestion = suggestHouseName(value, knownNames);
        return suggestion ? { value, suggestion } : { value };
      });
    // `policy` lets the client adapt the banner copy without having to
    // re-fetch school settings. 'strict' → rows will be skipped at
    // commit; 'fallback' → rows will commit with the smallest-house
    // default (the legacy behavior).
    const policy: "strict" | "fallback" =
      settingsRow[0]?.strictHouseNameMatch === true ? "strict" : "fallback";
    return {
      unrecognizedHouseNames: {
        rowCount: count,
        distinctCount: distinct.size,
        samples,
        policy,
      },
    };
  },
  async precommitValidate(items, schoolId) {
    // Strict mode (school_settings.strict_house_name_match = true):
    // reject any row whose `house_name` is set but doesn't match a
    // configured house. The default-off fallback path stays in
    // insertChunk so unchanged schools keep the smallest-house rotation.
    const [settingsRow] = await db
      .select({
        strictHouseNameMatch: schoolSettingsTable.strictHouseNameMatch,
      })
      .from(schoolSettingsTable)
      .where(eq(schoolSettingsTable.schoolId, schoolId));
    if (settingsRow?.strictHouseNameMatch !== true) {
      return { kept: items.map((i) => i.value), rejected: [] };
    }
    const houseRows = await db
      .select({ name: housesTable.name })
      .from(housesTable)
      .where(eq(housesTable.schoolId, schoolId));
    const knownNames = houseRows.map((h) => h.name.trim());
    const known = new Set(knownNames.map((n) => n.toLowerCase()));
    const kept: ParsedRoster[] = [];
    const rejected: Array<{
      row: number;
      message: string;
      raw?: Record<string, string>;
      code?: string;
      bucket?: string;
    }> = [];
    for (const { rowIndex, value, raw } of items) {
      const hn = value.houseName?.trim();
      if (hn && !known.has(hn.toLowerCase())) {
        const suggestion = suggestHouseName(hn, knownNames);
        const didYouMean = suggestion
          ? ` — did you mean "${suggestion}"?`
          : "";
        rejected.push({
          row: rowIndex,
          message: `Unrecognized house_name "${hn}"${didYouMean} (strict house-name matching is on). Fix the spelling or add the house in PBIS Hub → Houses.`,
          // Persist the original CSV row + a machine-readable code so the
          // History tab can group the skipped rows by house and offer a
          // "Download skipped rows as CSV" fixup export. Without `raw`
          // the admin would have to hand-rebuild each row in their SIS.
          raw,
          code: "unrecognized_house",
          bucket: hn,
        });
        continue;
      }
      kept.push(value);
    }
    return { kept, rejected };
  },
  async insertChunk(tx, parsed, schoolId, jobId) {
    if (parsed.length === 0) return 0;
    // Roster commits are now upsert-with-snapshot: brand-new students
    // are INSERTed; existing students are UPDATEd with a COALESCE-style
    // SET that preserves any field the CSV did not mention. Before
    // each existing-student update we snapshot the prior column values
    // into student_import_snapshots so rollback can restore them
    // verbatim. Brand-new inserts get a wasInsert=true snapshot row
    // (priorJson empty) so rollback can DELETE them by student_id.
    //
    // Per-row processing inside the transaction. The volume here is
    // bounded by the importer's chunk size (a few hundred rows), so
    // the round-trip cost is acceptable in exchange for clean semantics
    // and correct snapshots.

    // Pre-fetch existing rows for every student_id in this chunk, in a
    // single query. We need their prior values for the snapshot.
    const studentIds = parsed.map((p) => p.studentId);
    const existing = await tx
      .select()
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.schoolId, schoolId),
          inArray(studentsTable.studentId, studentIds),
        ),
      );
    const existingByStudentId = new Map(
      existing.map((s) => [s.studentId, s]),
    );

    // House placement (Phase 5: bulk house placement). For brand-new
    // inserts only: resolve the CSV's house_name to a houses.id, OR
    // pick the currently smallest house as the rotating default so
    // mid-year additions stay balanced. We do NOT touch the houseId
    // on existing students from the roster importer — that's reserved
    // for the admin "Change house" modal (audited) and the bulk sort
    // commit (snapshotted).
    const houseRows = await tx
      .select({
        id: housesTable.id,
        name: housesTable.name,
      })
      .from(housesTable)
      .where(eq(housesTable.schoolId, schoolId));
    const houseByName = new Map(
      houseRows.map((h) => [h.name.trim().toLowerCase(), h.id]),
    );
    // Delegate fallback house selection to the shared
    // recommendNextHouse helper from routes/houses.ts. We pass the
    // active transaction so each successive insert sees the
    // uncommitted row count and rotates through houses naturally —
    // the helper picks the smallest house, ties broken by id.
    const pickRecommendedHouseId = async (): Promise<number | null> => {
      if (houseRows.length === 0) return null;
      return await recommendNextHouse(schoolId, tx);
    };

    let touched = 0;
    for (const p of parsed) {
      const prior = existingByStudentId.get(p.studentId);
      if (!prior) {
        // Brand-new student — INSERT and snapshot as wasInsert=true.
        const insertRow: Record<string, unknown> = {
          schoolId,
          studentId: p.studentId,
          firstName: p.firstName,
          lastName: p.lastName,
          grade: p.grade,
          parentName: p.parentName,
          parentEmail: p.parentEmail,
          parentPhone: p.parentPhone,
          importJobId: jobId,
          gender: p.gender,
        };
        if (p.ell !== undefined) insertRow.ell = p.ell;
        if (p.ese !== undefined) insertRow.ese = p.ese;
        if (p.is504 !== undefined) insertRow.is504 = p.is504;
        // House placement: explicit CSV value wins; otherwise rotate
        // the smallest house. An unmatched house_name silently falls
        // back to the rotation rather than erroring the whole row —
        // an import is the wrong place to fail a child on misspelled
        // metadata, and the admin sort panel can fix anything stray.
        if (p.houseName) {
          const hid = houseByName.get(p.houseName.trim().toLowerCase());
          if (hid !== undefined) {
            insertRow.houseId = hid;
          } else {
            const fallback = await pickRecommendedHouseId();
            if (fallback !== null) insertRow.houseId = fallback;
          }
        } else {
          const fallback = await pickRecommendedHouseId();
          if (fallback !== null) insertRow.houseId = fallback;
        }
        // Race: another concurrent commit may have inserted this
        // student_id between our SELECT and INSERT. onConflictDoNothing
        // turns that race into a no-op rather than a hard failure;
        // when it skips we simply don't snapshot.
        const ins = await tx
          .insert(studentsTable)
          .values(insertRow as typeof studentsTable.$inferInsert)
          .onConflictDoNothing({ target: studentsTable.studentId })
          .returning({ id: studentsTable.id });
        if (ins.length > 0) {
          await tx.insert(studentImportSnapshotsTable).values({
            importJobId: jobId,
            schoolId,
            studentId: p.studentId,
            wasInsert: true,
            priorJson: {},
          });
          touched += 1;
        }
        continue;
      }
      // Existing student — only update the columns the CSV actually
      // provided AND only when the value is changing. Skip the snapshot
      // entirely if the row is a no-op (every CSV field already matches
      // the DB). This keeps the snapshot table from growing on
      // re-uploads of an unchanged file.
      const updates: Record<string, unknown> = {};
      const priorSnapshot: Record<string, unknown> = {};
      const maybe = (
        key: keyof typeof prior,
        next: string | number | boolean | null | undefined,
      ): void => {
        if (next === undefined) return; // CSV column unmapped → leave alone
        if (prior[key] === next) return; // no change
        updates[key as string] = next;
        priorSnapshot[key as string] = prior[key];
      };
      maybe("firstName", p.firstName);
      maybe("lastName", p.lastName);
      maybe("grade", p.grade);
      // Optional columns: when the CSV omits them parseRow returns
      // null (string optional()) — null DOES overwrite to clear the
      // field, which matches the CSV-author's intent. To preserve a
      // field, leave the column out of the mapping entirely.
      maybe("parentName", p.parentName);
      maybe("parentEmail", p.parentEmail);
      maybe("parentPhone", p.parentPhone);
      maybe("gender", p.gender);
      if (p.ell !== undefined) maybe("ell", p.ell);
      if (p.ese !== undefined) maybe("ese", p.ese);
      if (p.is504 !== undefined) maybe("is504", p.is504);
      if (Object.keys(updates).length === 0) continue;
      // Tag the row's importJobId too so the History tab can show
      // "last touched by" without joining the snapshot table.
      updates.importJobId = jobId;
      await tx
        .update(studentsTable)
        .set(updates as Partial<typeof studentsTable.$inferInsert>)
        .where(
          and(
            eq(studentsTable.schoolId, schoolId),
            eq(studentsTable.studentId, p.studentId),
          ),
        );
      await tx.insert(studentImportSnapshotsTable).values({
        importJobId: jobId,
        schoolId,
        studentId: p.studentId,
        wasInsert: false,
        priorJson: priorSnapshot,
      });
      touched += 1;
    }
    return touched;
  },
  async rollback(tx, jobId, schoolId) {
    // Two-phase rollback driven entirely by the snapshot table:
    //   1. wasInsert=true rows → DELETE the student (the row didn't
    //      exist before this job). Restricted to students whose
    //      importJobId still matches — if the student was later
    //      touched by a different job we leave them in place because
    //      a hard delete would lose newer data.
    //   2. wasInsert=false rows → restore each snapshotted column
    //      back onto the live student row.
    // After both phases run we delete the snapshots themselves so a
    // re-rollback (shouldn't happen, but) is a no-op.
    const snapshots = await tx
      .select()
      .from(studentImportSnapshotsTable)
      .where(
        and(
          eq(studentImportSnapshotsTable.importJobId, jobId),
          eq(studentImportSnapshotsTable.schoolId, schoolId),
        ),
      );
    let count = 0;
    for (const snap of snapshots) {
      if (snap.wasInsert) {
        const r = await tx
          .delete(studentsTable)
          .where(
            and(
              eq(studentsTable.schoolId, schoolId),
              eq(studentsTable.studentId, snap.studentId),
              eq(studentsTable.importJobId, jobId),
            ),
          );
        count += (r as unknown as { rowCount?: number }).rowCount ?? 0;
        continue;
      }
      // Restore prior columns. The snapshot only contains the columns
      // that were actually changed, so the SET payload is naturally
      // narrow — we won't accidentally overwrite a field the importer
      // never touched.
      //
      // OWNERSHIP GUARD: only restore when the row's importJobId still
      // matches this job. If a later job (Job B) has since touched the
      // same student, importJobId == B != jobId, the UPDATE skips it,
      // and Job B's newer values stay intact. Without this guard,
      // rolling back an old import would silently clobber whatever
      // changed afterward — exactly the kind of "undo deletes data"
      // surprise rollback is supposed to prevent.
      const restore = snap.priorJson as Record<string, unknown>;
      if (Object.keys(restore).length === 0) continue;
      const r = await tx
        .update(studentsTable)
        .set(restore as Partial<typeof studentsTable.$inferInsert>)
        .where(
          and(
            eq(studentsTable.schoolId, schoolId),
            eq(studentsTable.studentId, snap.studentId),
            eq(studentsTable.importJobId, jobId),
          ),
        );
      count += (r as unknown as { rowCount?: number }).rowCount ?? 0;
    }
    await tx
      .delete(studentImportSnapshotsTable)
      .where(
        and(
          eq(studentImportSnapshotsTable.importJobId, jobId),
          eq(studentImportSnapshotsTable.schoolId, schoolId),
        ),
      );
    return count;
  },
};

// ---------------------------------------------------------------------------
// Behavior config — one row per logged behavior incident / counselor
// note. Targets the support_notes table. Pure INSERT — no unique
// constraint, every CSV row creates a new note.
// ---------------------------------------------------------------------------
type ParsedBehavior = {
  studentId: string;
  noteType: string;
  noteText: string;
  staffName: string;
  createdAt: string;
};

const BEHAVIOR_CONFIG: KindConfig<ParsedBehavior> = {
  validTargets: new Set([
    "student_id",
    "note_type",
    "note_text",
    "staff_name",
    "created_at",
  ]),
  // staff_name and created_at are auto-filled when the column is missing
  // (CSV exports from the SIS often only have date/text), so they're
  // optional at the mapping level.
  requiredFields: ["student_id", "note_text"],
  headerSynonyms: {
    student_id: [
      "student_id",
      "student_number",
      "sis_id",
      "id",
      "studentid",
    ],
    note_type: [
      "note_type",
      "type",
      "category",
      "incident_type",
      "behavior_type",
      "infraction_type",
    ],
    note_text: [
      "note_text",
      "note",
      "description",
      "details",
      "incident",
      "narrative",
      "behavior",
      "comments",
    ],
    staff_name: [
      "staff_name",
      "staff",
      "teacher",
      "teacher_name",
      "reported_by",
      "logged_by",
      "author",
    ],
    created_at: [
      "created_at",
      "date",
      "incident_date",
      "logged_at",
      "occurred_at",
      "timestamp",
      "when",
    ],
  },
  parseRow(row, mapping) {
    const target: Record<string, string> = {};
    for (const [csvCol, tgt] of Object.entries(mapping)) {
      target[tgt] = csvCol;
    }
    for (const req of this.requiredFields) {
      const csvCol = target[req];
      if (!csvCol) {
        return { ok: false, message: `Missing required column: ${req}` };
      }
      const raw = (row[csvCol] ?? "").toString().trim();
      if (!raw) {
        return { ok: false, message: `Empty value for ${req}` };
      }
    }
    const studentId = row[target.student_id].toString().trim();
    const noteText = row[target.note_text].toString().trim();
    // Default note_type → "concern" (most CSVs that omit type are
    // discipline-style logs). Length-cap at 50 to keep the column tidy.
    const noteType = target.note_type
      ? (row[target.note_type] ?? "").toString().trim().slice(0, 50) ||
        "concern"
      : "concern";
    const staffName = target.staff_name
      ? (row[target.staff_name] ?? "").toString().trim().slice(0, 100) ||
        "CSV Import"
      : "CSV Import";
    // created_at is stored as text in support_notes (legacy choice). If
    // the CSV provides one we parse-and-normalize to ISO; otherwise we
    // stamp upload time.
    let createdAt = new Date().toISOString();
    if (target.created_at) {
      const dRaw = (row[target.created_at] ?? "").toString().trim();
      if (dRaw) {
        const parsed = new Date(dRaw);
        if (isNaN(parsed.getTime())) {
          return { ok: false, message: `Invalid date: "${dRaw}"` };
        }
        createdAt = parsed.toISOString();
      }
    }
    return {
      ok: true,
      value: { studentId, noteType, noteText, staffName, createdAt },
    };
  },
  async insertChunk(tx, parsed, schoolId, jobId) {
    if (parsed.length === 0) return 0;
    await tx.insert(supportNotesTable).values(
      parsed.map((p) => ({
        schoolId,
        studentId: p.studentId,
        noteType: p.noteType,
        noteText: p.noteText,
        staffName: p.staffName,
        createdAt: p.createdAt,
        importJobId: jobId,
      })),
    );
    return parsed.length;
  },
  async rollback(tx, jobId, schoolId) {
    const r = await tx
      .delete(supportNotesTable)
      .where(
        and(
          eq(supportNotesTable.importJobId, jobId),
          eq(supportNotesTable.schoolId, schoolId),
        ),
      );
    return (r as unknown as { rowCount?: number }).rowCount ?? 0;
  },
};

// ---------------------------------------------------------------------------
// FAST scores — one row per (school, student, subject). The CSV path is an
// upsert against the unique index `student_fast_scores_student_subject_unique`,
// so re-uploading the same student updates the row in place rather than
// creating duplicates. Note: this table has no `import_job_id` column —
// rollback is therefore a no-op (an upsert can't be safely undone without
// snapshotting the prior values, which we do not capture here).
// ---------------------------------------------------------------------------
type ParsedFastScore = {
  studentId: string;
  subject: "ela" | "math" | "algebra1" | "geometry";
  pm1: number | null;
  pm2: number | null;
  pm3: number | null;
  priorYearScore: number | null;
  // null sentinel = the CSV did not include a prior_year_bq column for
  // this row, so we must preserve the existing DB value on conflict
  // rather than overwriting with a default `false`. Boolean = the CSV
  // explicitly stated true/false; that wins on conflict.
  priorYearBq: boolean | null;
};

// Coerce a CSV cell to an integer or null. Empty → null. Decimal values
// are accepted and rounded (FAST scale scores are always whole numbers
// in practice but exports occasionally render them with ".0"). Returns
// `undefined` to signal a parse error so the caller can fail the row.
function parseOptionalInt(raw: unknown): number | null | undefined {
  if (raw == null) return null;
  const v = raw.toString().trim();
  if (!v) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.round(n);
}

const FAST_SCORES_CONFIG: KindConfig<ParsedFastScore> = {
  validTargets: new Set([
    "student_id",
    "subject",
    "pm1",
    "pm2",
    "pm3",
    "prior_year_score",
    "prior_year_bq",
  ]),
  // student_id and subject are the composite key; PMs / prior-year are
  // optional so partial-quarter uploads (just PM1) still work.
  requiredFields: ["student_id", "subject"],
  headerSynonyms: {
    student_id: [
      "student_id",
      "student_number",
      "sis_id",
      "id",
      "studentid",
    ],
    subject: ["subject", "test", "assessment", "area", "domain"],
    pm1: ["pm1", "pm_1", "fall", "pm1_score", "fall_score"],
    pm2: ["pm2", "pm_2", "winter", "pm2_score", "winter_score"],
    pm3: ["pm3", "pm_3", "spring", "pm3_score", "spring_score"],
    prior_year_score: [
      "prior_year_score",
      "prior_year",
      "py_score",
      "last_year",
      "last_year_score",
      "previous_year_score",
      "scale_score",
    ],
    prior_year_bq: [
      "prior_year_bq",
      "bq",
      "bottom_quartile",
      "py_bq",
      "is_bq",
    ],
  },
  parseRow(row, mapping) {
    const target: Record<string, string> = {};
    for (const [csvCol, tgt] of Object.entries(mapping)) {
      target[tgt] = csvCol;
    }
    for (const req of this.requiredFields) {
      const csvCol = target[req];
      if (!csvCol) {
        return { ok: false, message: `Missing required column: ${req}` };
      }
      const raw = (row[csvCol] ?? "").toString().trim();
      if (!raw) {
        return { ok: false, message: `Empty value for ${req}` };
      }
    }
    const studentId = row[target.student_id].toString().trim();
    // Subject normalization. "Reading" maps to ela because Florida FAST
    // ELA Reading exports use that label. EOC subjects (Algebra 1,
    // Geometry) accept their common SIS export aliases too. Anything
    // unrecognized is rejected.
    const subjectRaw = row[target.subject].toString().trim().toLowerCase();
    let subject: "ela" | "math" | "algebra1" | "geometry";
    if (subjectRaw === "ela" || subjectRaw === "reading") {
      subject = "ela";
    } else if (subjectRaw === "math" || subjectRaw === "mathematics") {
      subject = "math";
    } else if (
      subjectRaw === "algebra1" ||
      subjectRaw === "algebra 1" ||
      subjectRaw === "alg1" ||
      subjectRaw === "algebra_1"
    ) {
      subject = "algebra1";
    } else if (subjectRaw === "geometry" || subjectRaw === "geo") {
      subject = "geometry";
    } else {
      return {
        ok: false,
        message: `Unsupported subject "${subjectRaw}" (expected ela, math, algebra1, or geometry)`,
      };
    }
    const pm1 = target.pm1 !== undefined
      ? parseOptionalInt(row[target.pm1])
      : null;
    if (pm1 === undefined) return { ok: false, message: "Invalid pm1" };
    const pm2 = target.pm2 !== undefined
      ? parseOptionalInt(row[target.pm2])
      : null;
    if (pm2 === undefined) return { ok: false, message: "Invalid pm2" };
    const pm3 = target.pm3 !== undefined
      ? parseOptionalInt(row[target.pm3])
      : null;
    if (pm3 === undefined) return { ok: false, message: "Invalid pm3" };
    const priorYearScore = target.prior_year_score !== undefined
      ? parseOptionalInt(row[target.prior_year_score])
      : null;
    if (priorYearScore === undefined) {
      return { ok: false, message: "Invalid prior_year_score" };
    }
    // BQ flag uses the same forgiving Y/N/true/false parser as rosters
    // when the column is mapped. When the CSV does NOT include a BQ
    // column we use a `null` sentinel so insertChunk can preserve any
    // existing value on conflict instead of clobbering it with `false`.
    const priorYearBq: boolean | null = target.prior_year_bq !== undefined
      ? parseBoolFlag(row[target.prior_year_bq]?.toString())
      : null;
    return {
      ok: true,
      value: {
        studentId,
        subject,
        pm1,
        pm2,
        pm3,
        priorYearScore,
        priorYearBq,
      },
    };
  },
  async insertChunk(tx, parsed, schoolId, jobId) {
    if (parsed.length === 0) return 0;
    // Upsert against (school_id, student_id, subject, school_year). The
    // school_year column was added in FAST Phase 1 (Florida xlsx
    // parser) — the CSV importer always writes the current school
    // year so it never collides with prior-year backfill rows.
    //
    // Per-row PMs / prior_year_score use COALESCE so a partial CSV
    // (PM1-only mid-year) doesn't clobber later PMs back to null.
    //
    // Every row — insert OR conflict-update — gets stamped with the
    // current jobId via `import_job_id`. Rollback DELETES rows whose
    // import_job_id matches, so the most recent import "owns" each
    // row. (Older job ids are overwritten; rolling back an older job
    // after a newer one already touched its rows is a no-op for those
    // rows, which matches what the operator wants — the newest data
    // is the source of truth.)
    //
    // The BQ flag is trickier: it is NOT NULL in the schema, so we
    // can't pass null through INSERT. Instead we partition rows on
    // whether the CSV provided a BQ value:
    //   - withBq: explicit boolean → SET prior_year_bq = EXCLUDED.* (CSV wins)
    //   - withoutBq: column unmapped → INSERT default false (only used
    //     for brand-new rows), and on conflict SET prior_year_bq to
    //     itself so the existing DB value is preserved.
    // This guarantees a PM-only CSV upload cannot wipe an existing
    // true BQ flag back to false.
    const schoolYear = await currentSchoolYearLabelForSchool(schoolId);
    const withBq = parsed.filter((p) => p.priorYearBq !== null);
    const withoutBq = parsed.filter((p) => p.priorYearBq === null);
    const now = new Date();
    if (withBq.length > 0) {
      await tx
        .insert(studentFastScoresTable)
        .values(
          withBq.map((p) => ({
            schoolId,
            studentId: p.studentId,
            subject: p.subject,
            schoolYear,
            pm1: p.pm1,
            pm2: p.pm2,
            pm3: p.pm3,
            priorYearScore: p.priorYearScore,
            priorYearBq: p.priorYearBq as boolean,
            importJobId: jobId,
            updatedAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: [
            studentFastScoresTable.schoolId,
            studentFastScoresTable.studentId,
            studentFastScoresTable.subject,
            studentFastScoresTable.schoolYear,
          ],
          set: {
            pm1: sql`COALESCE(EXCLUDED.pm1, ${studentFastScoresTable.pm1})`,
            pm2: sql`COALESCE(EXCLUDED.pm2, ${studentFastScoresTable.pm2})`,
            pm3: sql`COALESCE(EXCLUDED.pm3, ${studentFastScoresTable.pm3})`,
            priorYearScore: sql`COALESCE(EXCLUDED.prior_year_score, ${studentFastScoresTable.priorYearScore})`,
            priorYearBq: sql`EXCLUDED.prior_year_bq`,
            importJobId: sql`EXCLUDED.import_job_id`,
            updatedAt: now,
          },
        });
    }
    if (withoutBq.length > 0) {
      await tx
        .insert(studentFastScoresTable)
        .values(
          withoutBq.map((p) => ({
            schoolId,
            studentId: p.studentId,
            subject: p.subject,
            schoolYear,
            pm1: p.pm1,
            pm2: p.pm2,
            pm3: p.pm3,
            priorYearScore: p.priorYearScore,
            // NOT NULL on a brand-new row only; on conflict the SET
            // clause below preserves the existing value instead.
            priorYearBq: false,
            importJobId: jobId,
            updatedAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: [
            studentFastScoresTable.schoolId,
            studentFastScoresTable.studentId,
            studentFastScoresTable.subject,
            studentFastScoresTable.schoolYear,
          ],
          set: {
            pm1: sql`COALESCE(EXCLUDED.pm1, ${studentFastScoresTable.pm1})`,
            pm2: sql`COALESCE(EXCLUDED.pm2, ${studentFastScoresTable.pm2})`,
            pm3: sql`COALESCE(EXCLUDED.pm3, ${studentFastScoresTable.pm3})`,
            priorYearScore: sql`COALESCE(EXCLUDED.prior_year_score, ${studentFastScoresTable.priorYearScore})`,
            // No BQ column in CSV → preserve existing DB value.
            priorYearBq: sql`${studentFastScoresTable.priorYearBq}`,
            importJobId: sql`EXCLUDED.import_job_id`,
            updatedAt: now,
          },
        });
    }
    return parsed.length;
  },
  async rollback(tx, jobId, schoolId) {
    // Delete every FAST row this job last wrote. Older rows whose
    // import_job_id was overwritten by a subsequent commit stay put,
    // which is the correct semantics: rolling back commit #5 cannot
    // undo data that commit #6 has since rewritten.
    const r = await tx
      .delete(studentFastScoresTable)
      .where(
        and(
          eq(studentFastScoresTable.importJobId, jobId),
          eq(studentFastScoresTable.schoolId, schoolId),
        ),
      );
    return (r as unknown as { rowCount?: number }).rowCount ?? 0;
  },
};

// FAST prior-year-only importer. Same target table as FAST_SCORES_CONFIG
// but the CSV carries only (student_id, subject, prior_year_score, [bq])
// — handy for schools whose end-of-year state report comes in a separate
// file from PM scores. The upsert SET clause intentionally omits PM
// columns so a prior-year-only file can never wipe current-year PM data.
type ParsedFastPriorYear = {
  studentId: string;
  subject: "ela" | "math" | "algebra1" | "geometry";
  priorYearScore: number;
  priorYearBq: boolean | null;
};

const FAST_PRIOR_YEAR_CONFIG: KindConfig<ParsedFastPriorYear> = {
  validTargets: new Set([
    "student_id",
    "subject",
    "prior_year_score",
    "prior_year_bq",
  ]),
  // prior_year_score is required here (the whole point of this importer);
  // PMs are not part of validTargets so an admin can't accidentally map
  // a "PM1" column and have it silently ignored.
  requiredFields: ["student_id", "subject", "prior_year_score"],
  headerSynonyms: {
    student_id: [
      "student_id",
      "student_number",
      "sis_id",
      "id",
      "studentid",
    ],
    subject: ["subject", "test", "assessment", "area", "domain"],
    prior_year_score: [
      "prior_year_score",
      "prior_year",
      "py_score",
      "last_year",
      "last_year_score",
      "previous_year_score",
      "scale_score",
      // FAST PM3 from last spring is functionally the same number — accept
      // those header conventions too so SIS exports don't need re-titling.
      "pm3_prior_year",
      "prior_pm3",
      "py_pm3",
      "pm3_last_year",
    ],
    prior_year_bq: [
      "prior_year_bq",
      "bq",
      "bottom_quartile",
      "py_bq",
      "is_bq",
    ],
  },
  parseRow(row, mapping) {
    const target: Record<string, string> = {};
    for (const [csvCol, tgt] of Object.entries(mapping)) {
      target[tgt] = csvCol;
    }
    for (const req of this.requiredFields) {
      const csvCol = target[req];
      if (!csvCol) {
        return { ok: false, message: `Missing required column: ${req}` };
      }
      const raw = (row[csvCol] ?? "").toString().trim();
      if (!raw) {
        return { ok: false, message: `Empty value for ${req}` };
      }
    }
    const studentId = row[target.student_id].toString().trim();
    // Same subject normalization as FAST_SCORES_CONFIG — keep these two
    // in sync. "Reading" maps to ela; EOC aliases map to algebra1 /
    // geometry.
    const subjectRaw = row[target.subject].toString().trim().toLowerCase();
    let subject: "ela" | "math" | "algebra1" | "geometry";
    if (subjectRaw === "ela" || subjectRaw === "reading") {
      subject = "ela";
    } else if (subjectRaw === "math" || subjectRaw === "mathematics") {
      subject = "math";
    } else if (
      subjectRaw === "algebra1" ||
      subjectRaw === "algebra 1" ||
      subjectRaw === "alg1" ||
      subjectRaw === "algebra_1"
    ) {
      subject = "algebra1";
    } else if (subjectRaw === "geometry" || subjectRaw === "geo") {
      subject = "geometry";
    } else {
      return {
        ok: false,
        message: `Unsupported subject "${subjectRaw}" (expected ela, math, algebra1, or geometry)`,
      };
    }
    const priorYearScore = parseOptionalInt(row[target.prior_year_score]);
    if (priorYearScore === undefined) {
      return { ok: false, message: "Invalid prior_year_score" };
    }
    if (priorYearScore === null) {
      // Required field guard above only checks for the empty string;
      // parseOptionalInt also returns null for "N/A"-style sentinels.
      return { ok: false, message: "Empty prior_year_score" };
    }
    // Same null-sentinel pattern as FAST_SCORES_CONFIG: when the BQ
    // column isn't mapped, leave priorYearBq null so insertChunk can
    // preserve the existing DB value on conflict instead of clobbering
    // it with a default `false`.
    const priorYearBq: boolean | null = target.prior_year_bq !== undefined
      ? parseBoolFlag(row[target.prior_year_bq]?.toString())
      : null;
    return {
      ok: true,
      value: { studentId, subject, priorYearScore, priorYearBq },
    };
  },
  async insertChunk(tx, parsed, schoolId, jobId) {
    if (parsed.length === 0) return 0;
    // Upsert against (school_id, student_id, subject, school_year).
    // The SET clause ONLY touches prior-year columns — PM1/PM2/PM3
    // are intentionally not in `set` so they remain whatever value
    // the row already had. Same withBq / withoutBq partition as
    // FAST_SCORES_CONFIG so a CSV without a BQ column can't wipe
    // an existing true BQ flag. import_job_id is overwritten on
    // conflict — same ownership model as FAST_SCORES_CONFIG.
    const schoolYear = await currentSchoolYearLabelForSchool(schoolId);
    const withBq = parsed.filter((p) => p.priorYearBq !== null);
    const withoutBq = parsed.filter((p) => p.priorYearBq === null);
    const now = new Date();
    if (withBq.length > 0) {
      await tx
        .insert(studentFastScoresTable)
        .values(
          withBq.map((p) => ({
            schoolId,
            studentId: p.studentId,
            subject: p.subject,
            schoolYear,
            priorYearScore: p.priorYearScore,
            priorYearBq: p.priorYearBq as boolean,
            importJobId: jobId,
            updatedAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: [
            studentFastScoresTable.schoolId,
            studentFastScoresTable.studentId,
            studentFastScoresTable.subject,
            studentFastScoresTable.schoolYear,
          ],
          set: {
            priorYearScore: sql`EXCLUDED.prior_year_score`,
            priorYearBq: sql`EXCLUDED.prior_year_bq`,
            importJobId: sql`EXCLUDED.import_job_id`,
            updatedAt: now,
          },
        });
    }
    if (withoutBq.length > 0) {
      await tx
        .insert(studentFastScoresTable)
        .values(
          withoutBq.map((p) => ({
            schoolId,
            studentId: p.studentId,
            subject: p.subject,
            schoolYear,
            priorYearScore: p.priorYearScore,
            // NOT NULL — only used for brand-new rows. On conflict the
            // SET clause below preserves the existing value.
            priorYearBq: false,
            importJobId: jobId,
            updatedAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: [
            studentFastScoresTable.schoolId,
            studentFastScoresTable.studentId,
            studentFastScoresTable.subject,
            studentFastScoresTable.schoolYear,
          ],
          set: {
            priorYearScore: sql`EXCLUDED.prior_year_score`,
            priorYearBq: sql`${studentFastScoresTable.priorYearBq}`,
            importJobId: sql`EXCLUDED.import_job_id`,
            updatedAt: now,
          },
        });
    }
    return parsed.length;
  },
  async rollback(tx, jobId, schoolId) {
    // Same model as FAST_SCORES_CONFIG.rollback().
    const r = await tx
      .delete(studentFastScoresTable)
      .where(
        and(
          eq(studentFastScoresTable.importJobId, jobId),
          eq(studentFastScoresTable.schoolId, schoolId),
        ),
      );
    return (r as unknown as { rowCount?: number }).rowCount ?? 0;
  },
};

// ---------------------------------------------------------------------------
// FAST Phase 1 — Florida per-student xlsx parser.
//
// The state ships a wide xlsx where each row is one student × one
// administration. Columns 1-18 are demographics + test metadata
// (Student ID, Test Reason, Test Completion Date, …), col 19 is the
// scale score ("Grade N FAST ELA Reading Scale Score"), and then
// ~40 repeating Category / Benchmark / Points Earned / Points Possible
// quadruplets per student.
//
// Phase 6 scope: ELA Reading + Mathematics (grades 3–8). Writing
// uses a rubric-scored layout without the per-benchmark quadruplets
// the rest of this parser depends on; the detector surfaces a
// friendly "not yet supported" rejection until samples are in hand.
//
// Storage model:
//   - One row in student_fast_scores per (student, subject,
//     school_year) — the scale score lands in pm1/pm2/pm3 based on the
//     window column.
//   - One row in student_fast_item_responses per (student × benchmark).
//     ~40 rows per administration.
//
// Idempotency: re-uploading the same PM window for the same school
// year DELETEs the prior item-response rows for the student set
// before re-inserting (the scale-score upsert in student_fast_scores
// is conflict-keyed and handles itself).
// ---------------------------------------------------------------------------
type FloridaItemResponse = {
  category: string | null;
  benchmarkCode: string;
  pointsEarned: number | null;
  pointsPossible: number | null;
  itemSeq: number;
};

type FloridaStudentRow = {
  studentId: string;
  studentName: string | null;
  window: "pm1" | "pm2" | "pm3";
  administeredAt: Date | null;
  scaleScore: number | null;
  achievementLevel: string | null;
  items: FloridaItemResponse[];
};

type FloridaParse =
  | { ok: false; error: string }
  | {
      ok: true;
      subject: "ela" | "math";
      gradeLabel: string | null;
      windowsSeen: Set<string>;
      students: FloridaStudentRow[];
      warnings: Array<{ row: number; message: string }>;
      totalItems: number;
    };

// Florida prefixes benchmarks with one or more strand-code segments
// separated by "|". The number of segments varies by subject:
//   ELA  (2 segments): "RP|ELA.6.R.1.1"             → "ELA.6.R.1.1"
//   Math (3 segments): "GRDP|MA.6.DP.1|MA.6.DP.1.6" → "MA.6.DP.1.6"
// We always want the LAST segment (the most-specific benchmark) so
// heatmap and MTSS aggregations roll up cleanly. Using lastIndexOf
// covers both shapes; an unprefixed code passes through unchanged.
function stripBenchmarkStrand(raw: string): string {
  const i = raw.lastIndexOf("|");
  return (i >= 0 ? raw.slice(i + 1) : raw).trim();
}

function parseCellString(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v instanceof Date) return v.toISOString();
  // exceljs sometimes wraps rich text / hyperlink values.
  const obj = v as { text?: unknown; result?: unknown };
  if (obj && typeof obj.text === "string") return obj.text.trim();
  if (obj && typeof obj.result === "string") return obj.result.trim();
  return String(v).trim();
}

function parseCellNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = parseCellString(v);
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseCellDate(v: unknown): Date | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v : null;
  const s = parseCellString(v);
  if (!s) return null;
  // Florida exports use M/D/YYYY. Date.parse handles that.
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t) : null;
}

function detectWindow(testReason: string): "pm1" | "pm2" | "pm3" | null {
  const m = /(?:^|[^A-Za-z])PM\s*([123])\b/i.exec(testReason);
  if (!m) return null;
  return (`pm${m[1]}`) as "pm1" | "pm2" | "pm3";
}

// Phase 6 recognizes ELA Reading and Mathematics (per-benchmark
// quadruplet layout). Writing uses a rubric-scored format that does
// not carry the Category / Benchmark / Points-Earned / Points-Possible
// quadruplets the rest of this parser depends on, so we surface a
// friendly "not yet supported" rejection rather than crashing or
// mis-importing.
function detectSubjectFromScaleHeader(
  header: string,
):
  | { subject: "ela" | "math"; grade: string | null }
  | { error: string } {
  // Examples we accept:
  //   "Grade 6 FAST ELA Reading Scale Score"
  //   "Grade 6 FAST Mathematics Scale Score"
  //   "FAST ELA Reading Scale Score"
  const gradeMatch = /Grade\s+(\d+)/i.exec(header);
  const grade = gradeMatch ? gradeMatch[1] : null;
  if (/ELA\s+Reading/i.test(header)) {
    return { subject: "ela", grade };
  }
  if (/Mathematics|\bMath\b/i.test(header)) {
    return { subject: "math", grade };
  }
  if (/Writing/i.test(header)) {
    return {
      error:
        "Florida FAST Writing xlsx parsing isn't supported yet — the rubric-scored Writing export has a different layout than ELA/Math. Please contact support if you'd like to prioritize it.",
    };
  }
  return {
    error: `Could not recognize subject from header "${header}". This importer supports ELA Reading and Mathematics.`,
  };
}

async function parseFloridaXlsx(
  buffer: Buffer,
): Promise<FloridaParse> {
  let wb: ExcelJS.Workbook;
  try {
    wb = new ExcelJS.Workbook();
    // exceljs typings prefer ArrayBuffer here; Node Buffer's .buffer
    // is fine in practice but we slice to the right window in case
    // the Buffer is a view into a larger pool.
    const ab = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    );
    await wb.xlsx.load(ab as ArrayBuffer);
  } catch (e) {
    return {
      ok: false,
      error: `Could not read xlsx: ${(e as Error).message}`,
    };
  }
  const ws = wb.worksheets[0];
  if (!ws || ws.rowCount < 2) {
    return { ok: false, error: "xlsx is empty (no data rows)." };
  }

  const headerRow = ws.getRow(1);
  const headers: string[] = [];
  for (let c = 1; c <= ws.columnCount; c++) {
    headers.push(parseCellString(headerRow.getCell(c).value));
  }

  // Required columns (case-insensitive exact match).
  const findIdx = (predicate: (h: string) => boolean): number =>
    headers.findIndex(predicate);
  const idxStudentId = findIdx((h) => /^student id$/i.test(h));
  const idxStudentName = findIdx((h) => /^student name$/i.test(h));
  const idxTestReason = findIdx((h) => /^test reason$/i.test(h));
  const idxCompletionDate = findIdx(
    (h) => /^test completion date$/i.test(h) || /^date taken$/i.test(h),
  );
  const idxScaleScore = findIdx((h) =>
    /FAST.*Scale Score/i.test(h),
  );
  const idxAchievement = findIdx((h) =>
    /FAST.*Achievement Level/i.test(h),
  );

  if (idxStudentId < 0) {
    return {
      ok: false,
      error: "Missing 'Student ID' column — this does not look like a Florida FAST per-student xlsx export.",
    };
  }
  if (idxTestReason < 0) {
    return {
      ok: false,
      error: "Missing 'Test Reason' column (required to derive the PM window).",
    };
  }
  if (idxScaleScore < 0) {
    return {
      ok: false,
      error:
        "Missing 'Grade N FAST … Scale Score' column. Re-export from the state portal with the Scale Score column included.",
    };
  }
  const subjectDetect = detectSubjectFromScaleHeader(headers[idxScaleScore]);
  if ("error" in subjectDetect) {
    return { ok: false, error: subjectDetect.error };
  }

  // Walk header row to find repeating Category / Benchmark / Points
  // Earned / Points Possible quadruplets. Each quad starts where a
  // "Category" header is followed by Benchmark / Points Earned /
  // Points Possible in that exact order.
  const quadStarts: number[] = [];
  for (let i = 0; i + 3 < headers.length; i++) {
    if (
      /^category$/i.test(headers[i]) &&
      /^benchmark$/i.test(headers[i + 1]) &&
      /^points earned$/i.test(headers[i + 2]) &&
      /^points possible$/i.test(headers[i + 3])
    ) {
      quadStarts.push(i);
    }
  }
  if (quadStarts.length === 0) {
    return {
      ok: false,
      error:
        "No 'Category / Benchmark / Points Earned / Points Possible' quadruplets found. Re-export from the state portal with the per-benchmark detail columns included.",
    };
  }

  const students: FloridaStudentRow[] = [];
  const warnings: Array<{ row: number; message: string }> = [];
  let totalItems = 0;
  const windowsSeen = new Set<string>();

  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    // exceljs treats trailing empty cells lazily; skip rows where
    // the Student ID cell is blank.
    const studentId = parseCellString(row.getCell(idxStudentId + 1).value);
    if (!studentId) continue;
    const testReason = parseCellString(row.getCell(idxTestReason + 1).value);
    const window = detectWindow(testReason);
    if (!window) {
      // Per task requirement: reject the entire file rather than
      // silently skipping rows when the PM window is ambiguous —
      // a Florida xlsx with un-tagged rows means the operator picked
      // the wrong export type and we don't want to half-import.
      return {
        ok: false,
        error:
          `Row ${r}: could not detect PM window from Test Reason "${testReason}". ` +
          `Re-export from the state portal with Test Reason populated for every row (expected values: "PM1", "PM2", or "PM3").`,
      };
    }
    windowsSeen.add(window);

    const scaleScore = parseCellNumber(row.getCell(idxScaleScore + 1).value);
    const achievement = idxAchievement >= 0
      ? parseCellString(row.getCell(idxAchievement + 1).value) || null
      : null;
    const administeredAt = idxCompletionDate >= 0
      ? parseCellDate(row.getCell(idxCompletionDate + 1).value)
      : null;
    const studentName = idxStudentName >= 0
      ? parseCellString(row.getCell(idxStudentName + 1).value) || null
      : null;

    const items: FloridaItemResponse[] = [];
    for (let qi = 0; qi < quadStarts.length; qi++) {
      const base = quadStarts[qi];
      const benchmarkRaw = parseCellString(row.getCell(base + 2).value);
      if (!benchmarkRaw) continue; // blank item slot
      const category = parseCellString(row.getCell(base + 1).value) || null;
      const pe = parseCellNumber(row.getCell(base + 3).value);
      const pp = parseCellNumber(row.getCell(base + 4).value);
      items.push({
        category,
        benchmarkCode: stripBenchmarkStrand(benchmarkRaw),
        pointsEarned: pe !== null ? Math.round(pe) : null,
        pointsPossible: pp !== null ? Math.round(pp) : null,
        itemSeq: qi,
      });
    }
    totalItems += items.length;

    students.push({
      studentId,
      studentName,
      window,
      administeredAt,
      scaleScore,
      achievementLevel: achievement,
      items,
    });
  }

  if (students.length === 0) {
    return {
      ok: false,
      error: "No student data rows found.",
    };
  }

  return {
    ok: true,
    subject: subjectDetect.subject,
    gradeLabel: subjectDetect.grade,
    windowsSeen,
    students,
    warnings,
    totalItems,
  };
}

// ---------------------------------------------------------------------------
// Gradebook ("Live Grade Report") xlsx parser. One row per student×course;
// each row carries ALL four quarters (Q1-Q4) plus a final (FIN). Matched to
// students by the "Other ID" column == students.local_sis_id. Distinct from
// FAST/iReady — this is the school's own gradebook.
//
// Expected columns (case-insensitive; the course-code header is year-prefixed
// e.g. "2026 Course" so we match on a trailing "course"):
//   Grade · Other ID · Full Name · <YYYY> Course · Section · Course Desc ·
//   Teacher · Length · Start Term · Stop Term · Q1 · Q2 · Q3 · Q4 · FIN
// ---------------------------------------------------------------------------
type GradebookParsedRow = {
  rowIndex: number; // 1-based xlsx data row (for warnings)
  localSisId: string;
  gradeLevel: string | null;
  courseCode: string;
  section: string | null;
  courseDesc: string | null;
  teacherName: string | null;
  length: string | null;
  startTerm: string | null;
  stopTerm: string | null;
  q1: number | null;
  q2: number | null;
  q3: number | null;
  q4: number | null;
  fin: number | null;
};

type GradebookParse =
  | { ok: false; error: string }
  | {
      ok: true;
      rows: GradebookParsedRow[];
      warnings: Array<{ row: number; message: string }>;
    };

// A grade cell: numeric 0-100, sometimes stored as leading-zero text
// ("067"). Out-of-range / non-numeric -> null (with a warning collected by
// the caller). FIN can also be blank on un-finalized courses.
function parseGradeCell(v: unknown): { value: number | null; bad: boolean } {
  const s = parseCellString(v);
  if (!s) return { value: null, bad: false };
  const n = Number(s);
  if (!Number.isFinite(n)) return { value: null, bad: true };
  const r = Math.round(n);
  if (r < 0 || r > 100) return { value: null, bad: true };
  return { value: r, bad: false };
}

async function parseGradebookXlsx(buffer: Buffer): Promise<GradebookParse> {
  let wb: ExcelJS.Workbook;
  try {
    wb = new ExcelJS.Workbook();
    const ab = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    );
    await wb.xlsx.load(ab as ArrayBuffer);
  } catch (e) {
    return { ok: false, error: `Could not read xlsx: ${(e as Error).message}` };
  }
  const ws = wb.worksheets[0];
  if (!ws || ws.rowCount < 2) {
    return { ok: false, error: "xlsx is empty (no data rows)." };
  }

  const headerRow = ws.getRow(1);
  const headers: string[] = [];
  for (let c = 1; c <= ws.columnCount; c++) {
    headers.push(parseCellString(headerRow.getCell(c).value));
  }
  const findIdx = (predicate: (h: string) => boolean): number =>
    headers.findIndex(predicate);

  const idxOtherId = findIdx((h) => /^other id$/i.test(h));
  const idxGrade = findIdx((h) => /^grade$/i.test(h));
  // Course code header is year-prefixed ("2026 Course"); match a trailing
  // "course" but never the description column ("Course Desc").
  const idxCourse = findIdx(
    (h) => /course\s*$/i.test(h) && !/desc/i.test(h),
  );
  const idxSection = findIdx((h) => /^section$/i.test(h));
  const idxCourseDesc = findIdx((h) => /course\s*desc/i.test(h));
  const idxTeacher = findIdx((h) => /^teacher$/i.test(h));
  const idxLength = findIdx((h) => /^length$/i.test(h));
  const idxStartTerm = findIdx((h) => /^start\s*term$/i.test(h));
  const idxStopTerm = findIdx((h) => /^stop\s*term$/i.test(h));
  const idxQ1 = findIdx((h) => /^q1$/i.test(h));
  const idxQ2 = findIdx((h) => /^q2$/i.test(h));
  const idxQ3 = findIdx((h) => /^q3$/i.test(h));
  const idxQ4 = findIdx((h) => /^q4$/i.test(h));
  const idxFin = findIdx((h) => /^fin$/i.test(h));

  if (idxOtherId < 0) {
    return {
      ok: false,
      error:
        "Missing 'Other ID' column — this is the student local SIS id used to match students. This does not look like a Live Grade Report export.",
    };
  }
  if (idxCourse < 0) {
    return {
      ok: false,
      error:
        "Missing the course-code column (e.g. '2026 Course'). Re-export with the course column included.",
    };
  }
  if (idxQ1 < 0 && idxQ2 < 0 && idxQ3 < 0 && idxQ4 < 0) {
    return {
      ok: false,
      error:
        "No quarter grade columns (Q1-Q4) found. Re-export with the quarter grade columns included.",
    };
  }

  const cell = (row: ExcelJS.Row, idx: number): unknown =>
    idx >= 0 ? row.getCell(idx + 1).value : null;
  const str = (row: ExcelJS.Row, idx: number): string | null =>
    idx >= 0 ? parseCellString(row.getCell(idx + 1).value) || null : null;

  const rows: GradebookParsedRow[] = [];
  const warnings: Array<{ row: number; message: string }> = [];

  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const localSisId = parseCellString(cell(row, idxOtherId));
    if (!localSisId) continue; // blank trailing row
    const courseCode = parseCellString(cell(row, idxCourse));
    if (!courseCode) {
      warnings.push({ row: r, message: `Row ${r}: blank course code — skipped.` });
      continue;
    }
    const q1 = parseGradeCell(cell(row, idxQ1));
    const q2 = parseGradeCell(cell(row, idxQ2));
    const q3 = parseGradeCell(cell(row, idxQ3));
    const q4 = parseGradeCell(cell(row, idxQ4));
    const fin = parseGradeCell(cell(row, idxFin));
    if (q1.bad || q2.bad || q3.bad || q4.bad || fin.bad) {
      warnings.push({
        row: r,
        message: `Row ${r}: one or more grade cells were not a number in 0-100 and were stored blank.`,
      });
    }
    rows.push({
      rowIndex: r,
      localSisId,
      gradeLevel: str(row, idxGrade),
      courseCode,
      section: str(row, idxSection),
      courseDesc: str(row, idxCourseDesc),
      teacherName: str(row, idxTeacher),
      length: str(row, idxLength),
      startTerm: str(row, idxStartTerm),
      stopTerm: str(row, idxStopTerm),
      q1: q1.value,
      q2: q2.value,
      q3: q3.value,
      q4: q4.value,
      fin: fin.value,
    });
  }

  if (rows.length === 0) {
    return { ok: false, error: "No student grade rows found." };
  }
  return { ok: true, rows, warnings };
}

// Validate the uploader-chosen quarter + effective date for a gradebook
// import. Returns the normalized values or an error string.
const GRADEBOOK_QUARTERS = ["Q1", "Q2", "Q3", "Q4"] as const;
type GradebookQuarter = (typeof GRADEBOOK_QUARTERS)[number];
function validateGradebookParams(
  body: unknown,
): { quarter: GradebookQuarter; effectiveDate: string } | string {
  const b = (body ?? {}) as { quarter?: unknown; effectiveDate?: unknown };
  const q = typeof b.quarter === "string" ? b.quarter.trim().toUpperCase() : "";
  if (!GRADEBOOK_QUARTERS.includes(q as GradebookQuarter)) {
    return "Pick which quarter these grades represent (Q1-Q4).";
  }
  const d = typeof b.effectiveDate === "string" ? b.effectiveDate.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    return "Effective date must be a valid YYYY-MM-DD date.";
  }
  const t = Date.parse(`${d}T00:00:00`);
  if (!Number.isFinite(t)) {
    return "Effective date must be a valid calendar date.";
  }
  return { quarter: q as GradebookQuarter, effectiveDate: d };
}

// Pull the xlsx bytes off a JSON body. Accepts `xlsxBase64` (string) —
// matches the existing CSV-as-string pattern so we don't have to wire
// multipart middleware just for this one route. Capped at ~12 MB pre
// base-64 (which our 15 MB JSON body limit accommodates).
function decodeXlsxBody(body: unknown): Buffer | string {
  const b = body as { xlsxBase64?: unknown } | null;
  const raw = b && typeof b.xlsxBase64 === "string" ? b.xlsxBase64 : "";
  if (!raw) return "Missing xlsxBase64 in request body.";
  // Strip a `data:…;base64,` prefix if the client included one.
  const stripped = raw.replace(/^data:[^;]+;base64,/, "");
  let buf: Buffer;
  try {
    buf = Buffer.from(stripped, "base64");
  } catch {
    return "xlsxBase64 is not valid base64.";
  }
  if (buf.length === 0) return "xlsxBase64 decoded to 0 bytes.";
  if (buf.length > 12 * 1024 * 1024) {
    return "xlsx exceeds the 12 MB limit. Split the file by grade and try again.";
  }
  return buf;
}

// Validate the admin-supplied school-year label. Allow the current
// year plus three previous (matches the dropdown the client renders).
function validateSchoolYearLabel(
  raw: unknown,
  current: string,
): string | null {
  if (typeof raw !== "string") return null;
  const m = /^(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (end !== (start + 1) % 100) return null;
  // Build the allowed set: current + 3 previous.
  const cm = /^(\d{2})-(\d{2})$/.exec(current);
  if (!cm) return raw.trim(); // fail open — current isn't well-formed
  const curStart = Number(cm[1]);
  const allowed = new Set<string>();
  for (let off = 0; off <= 3; off++) {
    const s = (curStart - off + 100) % 100;
    const e = (s + 1) % 100;
    const pad = (n: number) => String(n).padStart(2, "0");
    allowed.add(`${pad(s)}-${pad(e)}`);
  }
  return allowed.has(raw.trim()) ? raw.trim() : null;
}

router.post(
  "/data-imports/fast_florida/preview",
  requireImporter(),
  requireImportKind("fast_florida"),
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const decoded = decodeXlsxBody(req.body);
    if (typeof decoded === "string") {
      res.status(400).json({ error: decoded });
      return;
    }
    const current = await currentSchoolYearLabelForSchool(schoolId);
    const schoolYear = validateSchoolYearLabel(
      (req.body as { schoolYear?: unknown })?.schoolYear,
      current,
    );
    if (!schoolYear) {
      res.status(400).json({
        error: `Invalid or out-of-range school year. Pick from the current year (${current}) or one of the three preceding years.`,
      });
      return;
    }
    const parsed = await parseFloridaXlsx(decoded);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    res.json({
      kind: "fast_florida",
      subject: parsed.subject,
      gradeLabel: parsed.gradeLabel,
      schoolYear,
      windowsSeen: Array.from(parsed.windowsSeen).sort(),
      totalStudents: parsed.students.length,
      totalItems: parsed.totalItems,
      warnings: parsed.warnings,
      // Sample for the wizard's review pane — first 5 students + first
      // 3 items each. Keeps payload small for the 30+MB raw files.
      sampleStudents: parsed.students.slice(0, 5).map((s) => ({
        studentId: s.studentId,
        studentName: s.studentName,
        window: s.window,
        scaleScore: s.scaleScore,
        achievementLevel: s.achievementLevel,
        sampleItems: s.items.slice(0, 3),
      })),
      readyToCommit: parsed.students.length > 0,
    });
  },
);

router.post(
  "/data-imports/fast_florida/commit",
  requireImporter(),
  requireImportKind("fast_florida"),
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const staff = (req as Request & { staff: StaffRow }).staff;
    const decoded = decodeXlsxBody(req.body);
    if (typeof decoded === "string") {
      res.status(400).json({ error: decoded });
      return;
    }
    const current = await currentSchoolYearLabelForSchool(schoolId);
    const schoolYear = validateSchoolYearLabel(
      (req.body as { schoolYear?: unknown })?.schoolYear,
      current,
    );
    if (!schoolYear) {
      res.status(400).json({
        error: `Invalid or out-of-range school year. Pick from the current year (${current}) or one of the three preceding years.`,
      });
      return;
    }
    // Historical FAST flag (Phase 1 of Historical FAST work). When the
    // admin checks "Import as historical (prior school year)" the
    // importer:
    //   1. requires schoolYear != current (a historical import for the
    //      CURRENT year is an error — that's a normal import).
    //   2. requires the parsed file contain ONLY a PM3 window
    //      (prior-year context is PM3-only by product decision; no
    //      partial-year backfills).
    //   3. stamps is_historical = TRUE + imported_as_historical_at = NOW()
    //      on every row written.
    const isHistorical =
      (req.body as { isHistorical?: unknown })?.isHistorical === true;
    if (isHistorical && schoolYear === current) {
      res.status(400).json({
        error:
          "Historical imports must target a prior school year. Uncheck the historical toggle to import current-year data.",
      });
      return;
    }
    const filename = typeof (req.body as { filename?: unknown })?.filename ===
        "string" &&
      (req.body as { filename: string }).filename.trim()
      ? (req.body as { filename: string }).filename.trim().slice(0, 200)
      : "florida.xlsx";
    const parsed = await parseFloridaXlsx(decoded);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const subject = parsed.subject;
    // Historical imports must be PM3-only (product decision — see
    // "Out of scope" in the task plan). Reject if the parsed xlsx
    // contains any non-PM3 window.
    if (isHistorical) {
      const nonPm3 = Array.from(parsed.windowsSeen).filter(
        (w) => w !== "pm3",
      );
      if (nonPm3.length > 0 || !parsed.windowsSeen.has("pm3")) {
        res.status(400).json({
          error:
            "Historical FAST imports must contain only PM3 (end-of-year) scores. " +
            "Upload a PM3-only export to backfill prior years.",
        });
        return;
      }
    }

    const result = await db.transaction(async (tx) => {
      const [job] = await tx
        .insert(importJobsTable)
        .values({
          schoolId,
          districtId: null,
          kind: "fast_florida",
          filename,
          uploadedBy: staff.id,
          status: "committed",
          totalRows: parsed.students.length,
          successRows: 0,
          errorRows: 0,
          errorLog: parsed.warnings,
          // Snapshot the admin-supplied year + detected windows so
          // History can render "PM2 25-26 for Reading" without
          // re-parsing the xlsx.
          // mapping is typed Record<string, string>; serialize the
          // detected metadata so History can render it without
          // re-parsing the xlsx.
          mapping: {
            subject,
            school_year: schoolYear,
            grade_label: parsed.gradeLabel ?? "",
            windows_seen: Array.from(parsed.windowsSeen).sort().join(","),
            items_total: String(parsed.totalItems),
          },
          committedAt: new Date(),
        })
        .returning({ id: importJobsTable.id });

      // 1) Upsert student_fast_scores — one row per student. The scale
      //    score lands in pm1/pm2/pm3 based on the window column.
      //    COALESCE means a PM1-only file doesn't wipe PM2/PM3.
      const now = new Date();
      const scoreValues = parsed.students.map((s) => ({
        schoolId,
        studentId: s.studentId,
        subject,
        schoolYear,
        pm1: s.window === "pm1" ? s.scaleScore : null,
        pm2: s.window === "pm2" ? s.scaleScore : null,
        pm3: s.window === "pm3" ? s.scaleScore : null,
        priorYearScore: null,
        priorYearBq: false,
        importJobId: job.id,
        isHistorical,
        importedAsHistoricalAt: isHistorical ? now : null,
        updatedAt: now,
      }));
      for (let i = 0; i < scoreValues.length; i += 500) {
        await tx
          .insert(studentFastScoresTable)
          .values(scoreValues.slice(i, i + 500))
          .onConflictDoUpdate({
            target: [
              studentFastScoresTable.schoolId,
              studentFastScoresTable.studentId,
              studentFastScoresTable.subject,
              studentFastScoresTable.schoolYear,
            ],
            set: {
              pm1: sql`COALESCE(EXCLUDED.pm1, ${studentFastScoresTable.pm1})`,
              pm2: sql`COALESCE(EXCLUDED.pm2, ${studentFastScoresTable.pm2})`,
              pm3: sql`COALESCE(EXCLUDED.pm3, ${studentFastScoresTable.pm3})`,
              // Preserve existing BQ + prior_year_score — this importer
              // doesn't carry them.
              priorYearBq: sql`${studentFastScoresTable.priorYearBq}`,
              priorYearScore: sql`${studentFastScoresTable.priorYearScore}`,
              importJobId: sql`EXCLUDED.import_job_id`,
              // Historical flag wins on conflict — re-importing a year
              // as historical re-stamps the row; re-importing as
              // current clears the historical mark.
              isHistorical: sql`EXCLUDED.is_historical`,
              importedAsHistoricalAt: sql`EXCLUDED.imported_as_historical_at`,
              updatedAt: now,
            },
          });
      }

      // 2) Item responses. For idempotency on re-upload, DELETE any
      //    existing rows for (school, subject, school_year, window)
      //    scoped to the student set in the file, then bulk insert
      //    fresh rows. Rollback then walks import_job_id.
      const studentIds = parsed.students.map((s) => s.studentId);
      const uniqueStudentIds = Array.from(new Set(studentIds));
      const windows = Array.from(parsed.windowsSeen);
      if (uniqueStudentIds.length > 0 && windows.length > 0) {
        // Postgres caps single IN(...) lists at 32k params; we chunk
        // student ids to stay well clear.
        for (let i = 0; i < uniqueStudentIds.length; i += 1000) {
          const chunk = uniqueStudentIds.slice(i, i + 1000);
          await tx.delete(studentFastItemResponsesTable).where(
            and(
              eq(studentFastItemResponsesTable.schoolId, schoolId),
              eq(studentFastItemResponsesTable.subject, subject),
              eq(studentFastItemResponsesTable.schoolYear, schoolYear),
              inArray(studentFastItemResponsesTable.window, windows),
              inArray(studentFastItemResponsesTable.studentId, chunk),
            ),
          );
        }
      }

      const itemRows: (typeof studentFastItemResponsesTable.$inferInsert)[] =
        [];
      for (const s of parsed.students) {
        for (const it of s.items) {
          itemRows.push({
            schoolId,
            studentId: s.studentId,
            subject,
            schoolYear,
            window: s.window,
            administeredAt: s.administeredAt,
            category: it.category,
            benchmarkCode: it.benchmarkCode,
            pointsEarned: it.pointsEarned,
            pointsPossible: it.pointsPossible,
            itemSeq: it.itemSeq,
            importJobId: job.id,
          });
        }
      }
      for (let i = 0; i < itemRows.length; i += 1000) {
        await tx
          .insert(studentFastItemResponsesTable)
          .values(itemRows.slice(i, i + 1000));
      }

      await tx
        .update(importJobsTable)
        .set({
          successRows: parsed.students.length,
        })
        .where(eq(importJobsTable.id, job.id));

      return { id: job.id, items: itemRows.length };
    });

    req.log.info(
      {
        jobId: result.id,
        students: parsed.students.length,
        items: result.items,
        subject,
        schoolYear,
        windowsSeen: Array.from(parsed.windowsSeen),
      },
      "[fast_florida] committed",
    );

    res.json({
      jobId: result.id,
      subject,
      schoolYear,
      gradeLabel: parsed.gradeLabel,
      windowsSeen: Array.from(parsed.windowsSeen).sort(),
      totalStudents: parsed.students.length,
      totalItems: result.items,
      warningCount: parsed.warnings.length,
      // Aliases to match the generic commit-result contract the
      // client's success card renders (totalRows / successRows /
      // errorRows). For Florida, every parsed student row commits
      // (parser hard-fails on ambiguity), so success == total.
      totalRows: parsed.students.length,
      successRows: parsed.students.length,
      errorRows: 0,
    });
  },
);

// ---------------------------------------------------------------------------
// Gradebook ("Live Grade Report") import — preview + commit. Fixed-column
// xlsx (one row per student×course, all four quarters per row). Matched to
// students by Other ID == local_sis_id within the active school; unmatched
// rows are skipped and surfaced. Each commit FULL-REPLACES the school's
// gradebook rows (delete-then-insert in one tx). Rollback is special-cased
// in the jobs/:id/rollback handler (deletes by import_job_id).
// ---------------------------------------------------------------------------
router.post(
  "/data-imports/gradebook/preview",
  requireImporter(),
  requireImportKind("gradebook"),
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const decoded = decodeXlsxBody(req.body);
    if (typeof decoded === "string") {
      res.status(400).json({ error: decoded });
      return;
    }
    const params = validateGradebookParams(req.body);
    if (typeof params === "string") {
      res.status(400).json({ error: params });
      return;
    }
    const parsed = await parseGradebookXlsx(decoded);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const distinctSisIds = Array.from(
      new Set(parsed.rows.map((r) => r.localSisId)),
    );
    const { map, ambiguous } = await resolveLocalSisIds(
      schoolId,
      distinctSisIds,
    );
    const matchedRows = parsed.rows.filter((r) =>
      map.has(r.localSisId.trim().toLowerCase()),
    );
    const unmatchedSet = new Set<string>();
    for (const id of distinctSisIds) {
      if (!map.has(id.trim().toLowerCase())) unmatchedSet.add(id);
    }
    const matchedStudents = new Set(
      matchedRows.map((r) => map.get(r.localSisId.trim().toLowerCase())),
    );

    res.json({
      kind: "gradebook",
      quarter: params.quarter,
      effectiveDate: params.effectiveDate,
      totalRows: parsed.rows.length,
      matchedRows: matchedRows.length,
      matchedStudents: matchedStudents.size,
      unmatchedRows: parsed.rows.length - matchedRows.length,
      // Distinct local SIS ids in the file that didn't match a student in
      // this school (capped so a fully-mismatched file can't blow up the
      // payload). Ambiguous ids (matching >1 student) are called out too.
      unmatchedSisIds: Array.from(unmatchedSet).slice(0, 100),
      ambiguousSisIds: Array.from(ambiguous).slice(0, 100),
      warnings: parsed.warnings.slice(0, 100),
      // First few matched rows for the review pane.
      sampleRows: matchedRows.slice(0, 8).map((r) => ({
        localSisId: r.localSisId,
        courseCode: r.courseCode,
        courseDesc: r.courseDesc,
        teacherName: r.teacherName,
        q1: r.q1,
        q2: r.q2,
        q3: r.q3,
        q4: r.q4,
        fin: r.fin,
      })),
      readyToCommit: matchedRows.length > 0,
    });
  },
);

router.post(
  "/data-imports/gradebook/commit",
  requireImporter(),
  requireImportKind("gradebook"),
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const staff = (req as Request & { staff: StaffRow }).staff;
    const decoded = decodeXlsxBody(req.body);
    if (typeof decoded === "string") {
      res.status(400).json({ error: decoded });
      return;
    }
    const params = validateGradebookParams(req.body);
    if (typeof params === "string") {
      res.status(400).json({ error: params });
      return;
    }
    const filename =
      typeof (req.body as { filename?: unknown })?.filename === "string" &&
      (req.body as { filename: string }).filename.trim()
        ? (req.body as { filename: string }).filename.trim().slice(0, 200)
        : "gradebook.xlsx";
    const parsed = await parseGradebookXlsx(decoded);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const distinctSisIds = Array.from(
      new Set(parsed.rows.map((r) => r.localSisId)),
    );
    const { map } = await resolveLocalSisIds(schoolId, distinctSisIds);
    const matchedRows = parsed.rows.filter((r) =>
      map.has(r.localSisId.trim().toLowerCase()),
    );
    if (matchedRows.length === 0) {
      res.status(400).json({
        error:
          "None of the rows matched a student in this school (matched by Other ID == local SIS id). Check that you're uploading to the right school.",
      });
      return;
    }

    const result = await db.transaction(async (tx) => {
      const [job] = await tx
        .insert(importJobsTable)
        .values({
          schoolId,
          districtId: null,
          kind: "gradebook",
          filename,
          uploadedBy: staff.id,
          status: "committed",
          totalRows: parsed.rows.length,
          successRows: 0,
          errorRows: 0,
          errorLog: parsed.warnings,
          mapping: {
            quarter: params.quarter,
            effective_date: params.effectiveDate,
            matched_rows: String(matchedRows.length),
            total_rows: String(parsed.rows.length),
          },
          committedAt: new Date(),
        })
        .returning({ id: importJobsTable.id });

      // JOB-CHAINING (restorable full replace): a gradebook upload is the
      // authoritative snapshot of current grades, but instead of destructively
      // wiping prior rows we KEEP the immediately-previous generation so a
      // rollback can restore it (loadCurrentGrades reads only the latest
      // committed gradebook job's rows). We keep exactly two generations —
      // this new job + the prior latest committed job — and prune anything
      // older so the table can't grow unbounded across quarterly uploads.
      const [priorLatest] = await tx
        .select({ id: importJobsTable.id })
        .from(importJobsTable)
        .where(
          and(
            eq(importJobsTable.schoolId, schoolId),
            eq(importJobsTable.kind, "gradebook"),
            eq(importJobsTable.status, "committed"),
            ne(importJobsTable.id, job.id),
          ),
        )
        .orderBy(desc(importJobsTable.id))
        .limit(1);
      const keepJobIds = [job.id, ...(priorLatest ? [priorLatest.id] : [])];
      await tx
        .delete(studentCourseGradesTable)
        .where(
          and(
            eq(studentCourseGradesTable.schoolId, schoolId),
            not(inArray(studentCourseGradesTable.importJobId, keepJobIds)),
          ),
        );

      const values = matchedRows.map((r) => ({
        schoolId,
        studentId: map.get(r.localSisId.trim().toLowerCase()) as string,
        gradeLevel: r.gradeLevel,
        courseCode: r.courseCode,
        section: r.section,
        courseDesc: r.courseDesc,
        teacherName: r.teacherName,
        length: r.length,
        startTerm: r.startTerm,
        stopTerm: r.stopTerm,
        q1: r.q1,
        q2: r.q2,
        q3: r.q3,
        q4: r.q4,
        fin: r.fin,
        effectiveQuarter: params.quarter,
        effectiveDate: params.effectiveDate,
        importJobId: job.id,
      }));
      for (let i = 0; i < values.length; i += 500) {
        await tx
          .insert(studentCourseGradesTable)
          .values(values.slice(i, i + 500));
      }

      await tx
        .update(importJobsTable)
        .set({ successRows: matchedRows.length })
        .where(eq(importJobsTable.id, job.id));

      return { id: job.id };
    });

    req.log.info(
      {
        jobId: result.id,
        matchedRows: matchedRows.length,
        totalRows: parsed.rows.length,
        quarter: params.quarter,
      },
      "[gradebook] committed",
    );

    res.json({
      jobId: result.id,
      quarter: params.quarter,
      effectiveDate: params.effectiveDate,
      totalRows: parsed.rows.length,
      successRows: matchedRows.length,
      errorRows: parsed.rows.length - matchedRows.length,
      warningCount: parsed.warnings.length,
    });
  },
);

// ---------------------------------------------------------------------------
// PBIS point-balance migration — carry a student's existing reward balance
// over from another PBIS platform (LiveSchool, etc.) when a school converts
// to PulseEDU. Matched by local_sis_id (the only id a foreign vendor exports;
// NEVER the FLEID), resolved to the canonical student_id at commit time.
//
// Destination chosen per-import via the `countsTowardHouses` option:
//   false (default) → pbis_point_migrations ledger. Spendable in the School
//     Store (computeEarned adds it) but EXCLUDED from house standings,
//     leaderboards, and recognition counts.
//   true            → real pbis_entries rows (stamped import_job_id) so the
//     migrated points behave exactly like earned recognitions everywhere
//     (houses, leaderboards, recognition totals) with zero house-code change.
// Either way, rollback deletes by import_job_id from BOTH tables (only one
// ever holds rows for a given job).
// ---------------------------------------------------------------------------
type ParsedPointsMigration = {
  localSisId: string;
  points: number;
  // Filled in by precommitValidate once local_sis_id resolves to the
  // canonical FLEID. Preview never sets it.
  resolvedStudentId?: string;
};

// Resolve a batch of local_sis_id values to canonical student_ids within one
// school. Case-insensitive. A local_sis_id that matches >1 student is
// reported as ambiguous (and removed from the map) — we refuse to guess.
async function resolveLocalSisIds(
  schoolId: number,
  localSisIds: string[],
): Promise<{ map: Map<string, string>; ambiguous: Set<string> }> {
  const wanted = new Set(
    localSisIds.map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
  const map = new Map<string, string>();
  const ambiguous = new Set<string>();
  if (wanted.size === 0) return { map, ambiguous };
  const rows = await db
    .select({
      studentId: studentsTable.studentId,
      localSisId: studentsTable.localSisId,
    })
    .from(studentsTable)
    .where(eq(studentsTable.schoolId, schoolId));
  for (const r of rows) {
    const key = (r.localSisId ?? "").trim().toLowerCase();
    if (!key || !wanted.has(key)) continue;
    if (map.has(key)) {
      ambiguous.add(key);
    } else {
      map.set(key, r.studentId);
    }
  }
  for (const k of ambiguous) map.delete(k);
  return { map, ambiguous };
}

// Pre-seed milestone-email dedupe rows so a "count as earned" migration does
// NOT trigger a belated milestone-email flood. processMilestonesForStudent is
// recompute+dedupe based: without this, the next ordinary award would
// retroactively fire every milestone the carried-over balance crossed. We
// insert "skipped" dedupe rows for crossed milestones (onConflictDoNothing so
// an already-sent milestone is left untouched) — threshold tracking stays
// correct, but no emails go out for points earned on the prior platform.
async function suppressMigratedMilestones(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  schoolId: number,
  studentIds: string[],
  nowIso: string,
  jobId: number,
): Promise<void> {
  const milestones = await tx
    .select({ points: pbisMilestonesTable.points })
    .from(pbisMilestonesTable)
    .where(
      and(
        eq(pbisMilestonesTable.active, true),
        eq(pbisMilestonesTable.schoolId, schoolId),
      ),
    );
  if (milestones.length === 0) return;
  const seen = new Set<string>();
  for (const sid of studentIds) {
    if (seen.has(sid)) continue;
    seen.add(sid);
    const [row] = await tx
      .select({
        total: sql<number>`coalesce(sum(${pbisEntriesTable.points}), 0)::int`,
      })
      .from(pbisEntriesTable)
      .where(
        and(
          eq(pbisEntriesTable.schoolId, schoolId),
          eq(pbisEntriesTable.studentId, sid),
          isNull(pbisEntriesTable.voidedAt),
        ),
      );
    const total = row?.total ?? 0;
    const crossed = milestones.filter((m) => total >= m.points);
    if (crossed.length === 0) continue;
    await tx
      .insert(pbisMilestoneEmailsTable)
      .values(
        crossed.map((m) => ({
          studentId: sid,
          schoolId,
          milestonePoints: m.points,
          sentAt: nowIso,
          emailTo: null,
          status: "skipped" as const,
          errorMsg: "Suppressed — PBIS balance migration",
          importJobId: jobId,
        })),
      )
      .onConflictDoNothing();
  }
}

const POINTS_MIGRATION_CONFIG: KindConfig<ParsedPointsMigration> = {
  validTargets: new Set(["local_sis_id", "points"]),
  requiredFields: ["local_sis_id", "points"],
  headerSynonyms: {
    local_sis_id: [
      "local_sis_id",
      "local_id",
      "sis_id",
      "student_id",
      "student_number",
      "studentnumber",
      "id",
      "studentid",
    ],
    points: [
      "points",
      "balance",
      "point_balance",
      "points_balance",
      "current_balance",
      "available_points",
      "total_points",
    ],
  },
  parseRow(row, mapping) {
    const target: Record<string, string> = {};
    for (const [csvCol, tgt] of Object.entries(mapping)) {
      target[tgt] = csvCol;
    }
    for (const req of this.requiredFields) {
      if (!target[req]) {
        return { ok: false, message: `Missing required column: ${req}` };
      }
    }
    const localSisId = (row[target.local_sis_id] ?? "").toString().trim();
    if (!localSisId) {
      return { ok: false, message: "Empty value for local_sis_id" };
    }
    const rawPts = (row[target.points] ?? "")
      .toString()
      .trim()
      .replace(/,/g, "");
    if (!rawPts) {
      return { ok: false, message: "Empty value for points" };
    }
    const pts = Number(rawPts);
    if (!Number.isFinite(pts) || !Number.isInteger(pts)) {
      return {
        ok: false,
        message: `Points must be a whole number: "${rawPts}"`,
      };
    }
    if (pts < 0) {
      return { ok: false, message: `Points cannot be negative: "${rawPts}"` };
    }
    if (pts > 1_000_000) {
      return {
        ok: false,
        message: `Points value is implausibly large: "${rawPts}"`,
      };
    }
    return { ok: true, value: { localSisId, points: pts } };
  },
  async previewExtras(parsedValues, schoolId) {
    const { map } = await resolveLocalSisIds(
      schoolId,
      parsedValues.map((v) => v.localSisId),
    );
    let matched = 0;
    let unmatched = 0;
    let totalPoints = 0;
    for (const v of parsedValues) {
      if (map.has(v.localSisId.trim().toLowerCase())) {
        matched++;
        totalPoints += v.points;
      } else {
        unmatched++;
      }
    }
    return { pointsMigration: { matched, unmatched, totalPoints } };
  },
  async precommitValidate(items, schoolId) {
    const { map, ambiguous } = await resolveLocalSisIds(
      schoolId,
      items.map((i) => i.value.localSisId),
    );
    const kept: ParsedPointsMigration[] = [];
    const rejected: Array<{
      row: number;
      message: string;
      raw?: Record<string, string>;
      code?: string;
      bucket?: string;
    }> = [];
    // A balance migration must carry at most one row per student: two rows for
    // the same student would double-credit (and the store-only UPSERT can't
    // touch the same key twice in one statement). Reject every later duplicate.
    const seenKeys = new Set<string>();
    for (const { rowIndex, value, raw } of items) {
      const key = value.localSisId.trim().toLowerCase();
      if (seenKeys.has(key)) {
        rejected.push({
          row: rowIndex,
          message: `Local SIS ID "${value.localSisId}" appears more than once in this file — keep a single balance row per student.`,
          raw,
          code: "duplicate_in_file",
          bucket: value.localSisId,
        });
        continue;
      }
      if (ambiguous.has(key)) {
        rejected.push({
          row: rowIndex,
          message: `Local SIS ID "${value.localSisId}" matches more than one student — resolve the duplicate in the roster before importing.`,
          raw,
          code: "ambiguous_student",
          bucket: value.localSisId,
        });
        continue;
      }
      const studentId = map.get(key);
      if (!studentId) {
        rejected.push({
          row: rowIndex,
          message: `No student found with Local SIS ID "${value.localSisId}". Import the roster first, then re-run this migration.`,
          raw,
          code: "unknown_student",
          bucket: value.localSisId,
        });
        continue;
      }
      seenKeys.add(key);
      kept.push({ ...value, resolvedStudentId: studentId });
    }
    return { kept, rejected };
  },
  async insertChunk(tx, parsed, schoolId, jobId, options) {
    if (parsed.length === 0) return 0;
    const countsTowardHouses = options?.countsTowardHouses === true;
    const source =
      typeof options?.source === "string" && options.source.trim()
        ? options.source.trim().slice(0, 80)
        : "Imported balance";
    const nowIso = new Date().toISOString();
    // resolvedStudentId is guaranteed by precommitValidate (unresolved rows
    // were rejected before reaching insertChunk), but filter defensively.
    const rows = parsed.filter(
      (p): p is ParsedPointsMigration & { resolvedStudentId: string } =>
        typeof p.resolvedStudentId === "string",
    );
    if (rows.length === 0) return 0;

    if (countsTowardHouses) {
      // "Count as earned" → real PBIS recognitions. Houses, leaderboards,
      // and recognition counts pick these up automatically because they all
      // sum pbis_entries (computeEarned counts them too).
      await tx.insert(pbisEntriesTable).values(
        rows.map((p) => ({
          schoolId,
          studentId: p.resolvedStudentId,
          reason: `${source} (carried-over PBIS balance)`,
          points: p.points,
          polarity: "positive",
          staffId: null,
          staffName: source,
          createdAt: nowIso,
          importJobId: jobId,
        })),
      );
      await suppressMigratedMilestones(
        tx,
        schoolId,
        rows.map((p) => p.resolvedStudentId),
        nowIso,
        jobId,
      );
    } else {
      // Store-balance only → spendable wallet credit, invisible to houses.
      // UPSERT on the unique (school, student) index so re-importing the same
      // (or a corrected) balance file SETS the balance rather than stacking —
      // the migration is idempotent. precommitValidate already rejected in-file
      // duplicates, so a single statement never touches the same key twice.
      await tx
        .insert(pbisPointMigrationsTable)
        .values(
          rows.map((p) => ({
            schoolId,
            studentId: p.resolvedStudentId,
            points: p.points,
            source,
            importJobId: jobId,
            createdById: null,
            createdByName: source,
            createdAt: nowIso,
          })),
        )
        .onConflictDoUpdate({
          target: [
            pbisPointMigrationsTable.schoolId,
            pbisPointMigrationsTable.studentId,
          ],
          set: {
            points: sql`excluded.points`,
            source: sql`excluded.source`,
            importJobId: sql`excluded.import_job_id`,
            createdById: sql`excluded.created_by_id`,
            createdByName: sql`excluded.created_by_name`,
            createdAt: sql`excluded.created_at`,
            voidedAt: null,
          },
        });
    }
    return rows.length;
  },
  async rollback(tx, jobId, schoolId) {
    // A given job only ever wrote to ONE table, but deleting from both by
    // import_job_id is safe (the other has no matching rows) and means
    // rollback doesn't need to know which toggle was used.
    const led = await tx
      .delete(pbisPointMigrationsTable)
      .where(
        and(
          eq(pbisPointMigrationsTable.importJobId, jobId),
          eq(pbisPointMigrationsTable.schoolId, schoolId),
        ),
      );
    const ent = await tx
      .delete(pbisEntriesTable)
      .where(
        and(
          eq(pbisEntriesTable.importJobId, jobId),
          eq(pbisEntriesTable.schoolId, schoolId),
        ),
      );
    // Remove the milestone-email suppression rows this import pre-seeded (only
    // the "count as earned" path created any), so rolling back the migration
    // doesn't permanently silence future legitimate milestone emails.
    await tx
      .delete(pbisMilestoneEmailsTable)
      .where(
        and(
          eq(pbisMilestoneEmailsTable.importJobId, jobId),
          eq(pbisMilestoneEmailsTable.schoolId, schoolId),
        ),
      );
    return (
      ((led as unknown as { rowCount?: number }).rowCount ?? 0) +
      ((ent as unknown as { rowCount?: number }).rowCount ?? 0)
    );
  },
};

const KIND_CONFIGS: Record<string, KindConfig<any>> = {
  rosters: ROSTERS_CONFIG,
  behavior: BEHAVIOR_CONFIG,
  fast_scores: FAST_SCORES_CONFIG,
  fast_prior_year: FAST_PRIOR_YEAR_CONFIG,
  points_migration: POINTS_MIGRATION_CONFIG,
};

// ---------------------------------------------------------------------------
// Generic preview/commit handlers, parameterized by kind. Same flow as
// the assessments-specific routes but driven from the registry above.
// ---------------------------------------------------------------------------
function makePreviewHandler(kind: string, config: KindConfig) {
  return async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const csv = typeof req.body?.csv === "string" ? req.body.csv : "";
    if (!validateCsvPayload(csv, res)) return;
    const { headers, rows, parseError } = parseCsv(csv);
    if (parseError) {
      res.status(400).json({ error: parseError, headers });
      return;
    }
    if (rejectTooManyRows(rows.length, res)) return;
    const auto = autoMapHeadersForConfig(headers, config);
    const supplied =
      req.body?.mapping && typeof req.body.mapping === "object"
        ? (req.body.mapping as Record<string, string>)
        : {};
    const mapping: Record<string, string> = { ...auto.mapping };
    for (const [csvCol, tgtRaw] of Object.entries(supplied)) {
      const tgt = String(tgtRaw);
      if (!headers.includes(csvCol)) continue;
      if (!config.validTargets.has(tgt)) continue;
      for (const k of Object.keys(mapping)) {
        if (mapping[k] === tgt && k !== csvCol) delete mapping[k];
      }
      mapping[csvCol] = tgt;
    }
    const errors: Array<{ row: number; message: string }> = [];
    let valid = 0;
    const sample: unknown[] = [];
    const mappingOk =
      validateMappingForConfig(mapping, headers, config) === null;
    const allValid: unknown[] = [];
    if (mappingOk) {
      for (let i = 0; i < rows.length; i++) {
        await yieldImportProcessing(i);
        const parsed = config.parseRow(rows[i], mapping);
        if (parsed.ok) {
          valid++;
          allValid.push(parsed.value);
          if (sample.length < 10) sample.push(parsed.value);
        } else if (errors.length < 50) {
          errors.push({ row: i + 2, message: parsed.message });
        }
      }
    }
    const extras: Record<string, unknown> =
      mappingOk && config.previewExtras && allValid.length > 0
        ? await config.previewExtras(allValid, schoolId)
        : {};
    res.json({
      kind,
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
        config.requiredFields.every((f) =>
          Object.values(mapping).includes(f),
        ),
      ...extras,
    });
  };
}

function makeCommitHandler<T>(kind: string, config: KindConfig<T>) {
  return async (req: Request, res: Response) => {
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
    const rawOptions = req.body?.options;
    const options: ImportCommitOptions =
      rawOptions && typeof rawOptions === "object" && !Array.isArray(rawOptions)
        ? {
            countsTowardHouses: rawOptions.countsTowardHouses === true,
            source:
              typeof rawOptions.source === "string"
                ? rawOptions.source
                : undefined,
          }
        : {};
    if (!validateCsvPayload(csv, res)) return;
    const { headers, rows, parseError } = parseCsv(csv);
    if (parseError) {
      res.status(400).json({ error: parseError });
      return;
    }
    if (rejectTooManyRows(rows.length, res)) return;
    const mappingError = validateMappingForConfig(mapping, headers, config);
    if (mappingError) {
      res.status(400).json({ error: mappingError });
      return;
    }
    const validIndexed: Array<{
      rowIndex: number;
      value: T;
      raw: Record<string, string>;
    }> = [];
    const errors: Array<{
      row: number;
      message: string;
      raw?: Record<string, string>;
      code?: string;
      bucket?: string;
    }> = [];
    for (let i = 0; i < rows.length; i++) {
      await yieldImportProcessing(i);
      const parsed = config.parseRow(rows[i], mapping);
      if (parsed.ok) {
        validIndexed.push({ rowIndex: i + 2, value: parsed.value, raw: rows[i] });
      } else if (errors.length < 500) {
        errors.push({ row: i + 2, message: parsed.message, raw: rows[i] });
      }
    }
    // Post-parse, pre-insert filter (kind-aware). Used by the roster
    // importer's strict house-name mode to surface unmatched house
    // names as per-row errors instead of silently routing them through
    // the smallest-house fallback. We preserve `raw` + `code` so the
    // History tab can group these rejections by their trigger value
    // and emit a fixup CSV download.
    let valid: T[];
    if (config.precommitValidate) {
      const r = await config.precommitValidate(validIndexed, schoolId);
      valid = r.kept;
      for (const rej of r.rejected) {
        if (errors.length >= 500) break;
        errors.push({
          row: rej.row,
          message: rej.message,
          raw: rej.raw,
          code: rej.code,
          bucket: rej.bucket,
        });
      }
    } else {
      valid = validIndexed.map((v) => v.value);
    }
    const result = await db.transaction(async (tx) => {
      const [job] = await tx
        .insert(importJobsTable)
        .values({
          schoolId,
          districtId: null,
          kind,
          filename,
          uploadedBy: staff.id,
          status: "committed",
          totalRows: rows.length,
          successRows: 0, // patched after insertChunk so we know real count
          errorRows: rows.length - valid.length,
          errorLog: errors,
          mapping,
          committedAt: new Date(),
        })
        .returning({ id: importJobsTable.id });
      let committedTotal = 0;
      const chunkSize = 500;
      for (let i = 0; i < valid.length; i += chunkSize) {
        const chunk = valid.slice(i, i + chunkSize);
        committedTotal += await config.insertChunk(
          tx,
          chunk,
          schoolId,
          job.id,
          options,
        );
      }
      // For upsert-skip kinds (rosters), committedTotal can be < valid.length.
      // The diff is "valid but skipped due to existing row" — we surface
      // that to the UI as the difference between valid (parsed) and
      // success (actually inserted).
      await tx
        .update(importJobsTable)
        .set({ successRows: committedTotal })
        .where(eq(importJobsTable.id, job.id));
      return { id: job.id, committedTotal };
    });
    res.json({
      jobId: result.id,
      totalRows: rows.length,
      validRows: valid.length,
      successRows: result.committedTotal,
      skippedRows: valid.length - result.committedTotal,
      errorRows: rows.length - valid.length,
    });
  };
}

// Roster importer is opt-in per school (school_settings
// .manual_roster_upload_enabled, default FALSE) because the expected
// source of truth for most schools is a Classlink / Clever OneRoster
// sync. The toggle is enforced server-side on BOTH preview and commit
// — the wizard greys out the Roster card client-side, but a stale tab
// or scripted client must not be able to bypass it.
function requireManualRosterUploadEnabled() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const [row] = await db
      .select({
        enabled: schoolSettingsTable.manualRosterUploadEnabled,
      })
      .from(schoolSettingsTable)
      .where(eq(schoolSettingsTable.schoolId, schoolId));
    if (!row || !row.enabled) {
      res.status(403).json({
        error:
          "Manual roster uploads are disabled for this school. Most schools sync rosters from Classlink or Clever (OneRoster). An administrator can enable manual uploads in School Settings → Data & Integrations.",
      });
      return;
    }
    next();
  };
}

router.post(
  "/data-imports/rosters/preview",
  requireImporter(),
  requireImportKind("rosters"),
  requireManualRosterUploadEnabled(),
  makePreviewHandler("rosters", ROSTERS_CONFIG),
);
router.post(
  "/data-imports/rosters/commit",
  requireImporter(),
  requireImportKind("rosters"),
  requireManualRosterUploadEnabled(),
  makeCommitHandler("rosters", ROSTERS_CONFIG),
);
router.post(
  "/data-imports/behavior/preview",
  requireImporter(),
  requireImportKind("behavior"),
  makePreviewHandler("behavior", BEHAVIOR_CONFIG),
);
router.post(
  "/data-imports/behavior/commit",
  requireImporter(),
  requireImportKind("behavior"),
  makeCommitHandler("behavior", BEHAVIOR_CONFIG),
);
router.post(
  "/data-imports/fast_scores/preview",
  requireImporter(),
  requireImportKind("fast_scores"),
  makePreviewHandler("fast_scores", FAST_SCORES_CONFIG),
);
router.post(
  "/data-imports/fast_scores/commit",
  requireImporter(),
  requireImportKind("fast_scores"),
  makeCommitHandler("fast_scores", FAST_SCORES_CONFIG),
);
router.post(
  "/data-imports/fast_prior_year/preview",
  requireImporter(),
  requireImportKind("fast_prior_year"),
  makePreviewHandler("fast_prior_year", FAST_PRIOR_YEAR_CONFIG),
);
router.post(
  "/data-imports/fast_prior_year/commit",
  requireImporter(),
  requireImportKind("fast_prior_year"),
  makeCommitHandler("fast_prior_year", FAST_PRIOR_YEAR_CONFIG),
);
router.post(
  "/data-imports/points_migration/preview",
  requireImporter(),
  requireImportKind("points_migration"),
  makePreviewHandler("points_migration", POINTS_MIGRATION_CONFIG),
);
router.post(
  "/data-imports/points_migration/commit",
  requireImporter(),
  requireImportKind("points_migration"),
  makeCommitHandler("points_migration", POINTS_MIGRATION_CONFIG),
);

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
  kind: string,
): string | null {
  if (
    !mapping ||
    typeof mapping !== "object" ||
    Array.isArray(mapping) ||
    Object.keys(mapping).length === 0
  ) {
    return "Template mapping must have at least one column";
  }
  // Kind-aware target validation: assessments still uses the legacy
  // VALID_TARGETS set (school + district variants combined); rosters /
  // behavior look up the registry. Unknown kinds reject all targets.
  let allowedTargets: Set<string>;
  if (kind === "assessments") {
    allowedTargets = VALID_TARGETS;
  } else {
    const cfg = KIND_CONFIGS[kind];
    if (!cfg) return `Unknown import kind: "${kind}"`;
    allowedTargets = new Set(cfg.validTargets);
  }
  const seenTargets = new Set<string>();
  for (const [csvCol, target] of Object.entries(mapping)) {
    if (typeof csvCol !== "string" || !csvCol.trim()) {
      return "Template has an empty CSV column name";
    }
    if (typeof target !== "string" || !allowedTargets.has(target)) {
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
    // Delegated clerks may only list templates for the kinds they can import.
    // Admins bypass via canImportKind; district scope is gated below.
    if (scope === "school" && !canImportKind(staff, kind)) {
      res.status(403).json({ error: "Data import access required" });
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
    // Delegated clerks may only save templates for the kinds they can import.
    // Admins bypass via canImportKind; district scope is gated below.
    if (scope === "school" && !canImportKind(staff, kind)) {
      res.status(403).json({ error: "Data import access required" });
      return;
    }
    const mappingError = validateTemplateMapping(mapping, kind);
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
    const id = parseInt(String(req.params.id), 10);
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
      // Delegated clerks may only delete templates for kinds they can import.
      if (!canImportKind(staff, tpl.kind)) {
        res.status(403).json({ error: "Data import access required" });
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
