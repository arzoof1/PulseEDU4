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
  studentsTable,
  supportNotesTable,
  studentFastScoresTable,
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
    // FAST scores import is an upsert with no per-job audit trail
    // (the table has no `import_job_id` column), so there is nothing
    // we can safely undo. Rather than silently flipping the job to
    // `rolled_back` while the rows stay changed — which gives the
    // operator false confidence the data was reverted — we refuse
    // the rollback up front. This must stay in sync with
    // FAST_SCORES_CONFIG.rollback() (also a no-op).
    if (job.kind === "fast_scores" || job.kind === "fast_prior_year") {
      res.status(409).json({
        error:
          "FAST score imports cannot be rolled back. Re-upload a corrected CSV to update the affected rows.",
      });
      return;
    }
    const deleted = await db.transaction(async (tx) => {
      let count = 0;
      // Multi-kind kinds (rosters, behavior) live in the registry. They
      // only support school scope; the registry rollback() does the
      // schoolId-AND defense-in-depth itself.
      const cfg = KIND_CONFIGS[job.kind];
      if (cfg && job.schoolId != null) {
        count = await cfg.rollback(tx, id, job.schoolId);
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
  // like rosters where duplicate student_ids are no-ops).
  insertChunk: (
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    parsed: T[],
    schoolId: number,
    jobId: number,
  ) => Promise<number>;
  // Rollback: delete every row this job inserted. Returns row count.
  rollback: (
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    jobId: number,
    schoolId: number,
  ) => Promise<number>;
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
      },
    };
  },
  async insertChunk(tx, parsed, schoolId, jobId) {
    if (parsed.length === 0) return 0;
    // Use returning() so we can count how many actually survived the
    // unique-constraint conflict check. Drizzle's onConflictDoNothing
    // skips dupes silently; the returned array tells us the truth.
    const inserted = await tx
      .insert(studentsTable)
      .values(
        parsed.map((p) => {
          const row: Record<string, unknown> = {
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
          // Only include flag columns when the importer actually saw a
          // value; otherwise let the column default fire so we don't
          // overwrite future-set MTSS values via INSERT (insert is moot
          // here because of onConflictDoNothing, but the principle
          // holds for the parsed-row shape).
          if (p.ell !== undefined) row.ell = p.ell;
          if (p.ese !== undefined) row.ese = p.ese;
          if (p.is504 !== undefined) row.is504 = p.is504;
          return row as typeof studentsTable.$inferInsert;
        }),
      )
      .onConflictDoNothing({ target: studentsTable.studentId })
      .returning({ id: studentsTable.id });
    return inserted.length;
  },
  async rollback(tx, jobId, schoolId) {
    // Defense in depth: AND on schoolId so a malformed job can't nuke
    // another school's roster.
    const r = await tx
      .delete(studentsTable)
      .where(
        and(
          eq(studentsTable.importJobId, jobId),
          eq(studentsTable.schoolId, schoolId),
        ),
      );
    return (r as unknown as { rowCount?: number }).rowCount ?? 0;
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
  subject: "ela" | "math";
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
    // ELA Reading exports use that label; everything else normalizes to
    // its base subject. Anything outside ela/math is rejected (we don't
    // model EOC subjects yet — see schema header comment).
    const subjectRaw = row[target.subject].toString().trim().toLowerCase();
    let subject: "ela" | "math";
    if (subjectRaw === "ela" || subjectRaw === "reading") {
      subject = "ela";
    } else if (subjectRaw === "math" || subjectRaw === "mathematics") {
      subject = "math";
    } else {
      return {
        ok: false,
        message: `Unsupported subject "${subjectRaw}" (expected ela or math)`,
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
  async insertChunk(tx, parsed, schoolId, _jobId) {
    if (parsed.length === 0) return 0;
    // Upsert against (school_id, student_id, subject). Numeric PMs and
    // prior_year_score use COALESCE so a partial CSV (PM1-only mid-year)
    // doesn't clobber later PMs back to null.
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
            pm1: p.pm1,
            pm2: p.pm2,
            pm3: p.pm3,
            priorYearScore: p.priorYearScore,
            priorYearBq: p.priorYearBq as boolean,
            updatedAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: [
            studentFastScoresTable.schoolId,
            studentFastScoresTable.studentId,
            studentFastScoresTable.subject,
          ],
          set: {
            pm1: sql`COALESCE(EXCLUDED.pm1, ${studentFastScoresTable.pm1})`,
            pm2: sql`COALESCE(EXCLUDED.pm2, ${studentFastScoresTable.pm2})`,
            pm3: sql`COALESCE(EXCLUDED.pm3, ${studentFastScoresTable.pm3})`,
            priorYearScore: sql`COALESCE(EXCLUDED.prior_year_score, ${studentFastScoresTable.priorYearScore})`,
            priorYearBq: sql`EXCLUDED.prior_year_bq`,
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
            pm1: p.pm1,
            pm2: p.pm2,
            pm3: p.pm3,
            priorYearScore: p.priorYearScore,
            // NOT NULL on a brand-new row only; on conflict the SET
            // clause below preserves the existing value instead.
            priorYearBq: false,
            updatedAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: [
            studentFastScoresTable.schoolId,
            studentFastScoresTable.studentId,
            studentFastScoresTable.subject,
          ],
          set: {
            pm1: sql`COALESCE(EXCLUDED.pm1, ${studentFastScoresTable.pm1})`,
            pm2: sql`COALESCE(EXCLUDED.pm2, ${studentFastScoresTable.pm2})`,
            pm3: sql`COALESCE(EXCLUDED.pm3, ${studentFastScoresTable.pm3})`,
            priorYearScore: sql`COALESCE(EXCLUDED.prior_year_score, ${studentFastScoresTable.priorYearScore})`,
            // No BQ column in CSV → preserve existing DB value.
            priorYearBq: sql`${studentFastScoresTable.priorYearBq}`,
            updatedAt: now,
          },
        });
    }
    // Silence unused-param lint — jobId is part of the KindConfig
    // contract but FAST scores doesn't track it (no column).
    void _jobId;
    return parsed.length;
  },
  async rollback(_tx, _jobId, _schoolId) {
    // FAST scores are upserts — there is no per-job audit trail, so
    // rollback is intentionally a no-op. The UI should warn the
    // importer that FAST imports are not undoable before they commit.
    void _tx;
    void _jobId;
    void _schoolId;
    return 0;
  },
};

// FAST prior-year-only importer. Same target table as FAST_SCORES_CONFIG
// but the CSV carries only (student_id, subject, prior_year_score, [bq])
// — handy for schools whose end-of-year state report comes in a separate
// file from PM scores. The upsert SET clause intentionally omits PM
// columns so a prior-year-only file can never wipe current-year PM data.
type ParsedFastPriorYear = {
  studentId: string;
  subject: "ela" | "math";
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
    // Same subject normalization as FAST_SCORES_CONFIG. "Reading" maps to
    // ela because Florida FAST ELA Reading exports use that label.
    const subjectRaw = row[target.subject].toString().trim().toLowerCase();
    let subject: "ela" | "math";
    if (subjectRaw === "ela" || subjectRaw === "reading") {
      subject = "ela";
    } else if (subjectRaw === "math" || subjectRaw === "mathematics") {
      subject = "math";
    } else {
      return {
        ok: false,
        message: `Unsupported subject "${subjectRaw}" (expected ela or math)`,
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
  async insertChunk(tx, parsed, schoolId, _jobId) {
    if (parsed.length === 0) return 0;
    // Upsert against (school_id, student_id, subject). The SET clause
    // ONLY touches prior-year columns — PM1/PM2/PM3 are intentionally
    // not in `set` so they remain whatever value the row already had.
    // Same withBq / withoutBq partition as FAST_SCORES_CONFIG so a
    // CSV without a BQ column can't wipe an existing true BQ flag.
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
            priorYearScore: p.priorYearScore,
            priorYearBq: p.priorYearBq as boolean,
            updatedAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: [
            studentFastScoresTable.schoolId,
            studentFastScoresTable.studentId,
            studentFastScoresTable.subject,
          ],
          set: {
            priorYearScore: sql`EXCLUDED.prior_year_score`,
            priorYearBq: sql`EXCLUDED.prior_year_bq`,
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
            priorYearScore: p.priorYearScore,
            // NOT NULL — only used for brand-new rows. On conflict the
            // SET clause below preserves the existing value.
            priorYearBq: false,
            updatedAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: [
            studentFastScoresTable.schoolId,
            studentFastScoresTable.studentId,
            studentFastScoresTable.subject,
          ],
          set: {
            priorYearScore: sql`EXCLUDED.prior_year_score`,
            priorYearBq: sql`${studentFastScoresTable.priorYearBq}`,
            updatedAt: now,
          },
        });
    }
    void _jobId;
    return parsed.length;
  },
  async rollback(_tx, _jobId, _schoolId) {
    // Same rationale as FAST_SCORES_CONFIG: upsert + no per-job audit
    // trail = nothing to safely undo. Rollback handler returns 409
    // before reaching here for fast_prior_year jobs.
    void _tx;
    void _jobId;
    void _schoolId;
    return 0;
  },
};

const KIND_CONFIGS: Record<string, KindConfig<any>> = {
  rosters: ROSTERS_CONFIG,
  behavior: BEHAVIOR_CONFIG,
  fast_scores: FAST_SCORES_CONFIG,
  fast_prior_year: FAST_PRIOR_YEAR_CONFIG,
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
    if (mappingOk) {
      for (let i = 0; i < rows.length; i++) {
        const parsed = config.parseRow(rows[i], mapping);
        if (parsed.ok) {
          valid++;
          if (sample.length < 10) sample.push(parsed.value);
        } else if (errors.length < 50) {
          errors.push({ row: i + 2, message: parsed.message });
        }
      }
    }
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
    });
  };
}

function makeCommitHandler(kind: string, config: KindConfig) {
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
    const mappingError = validateMappingForConfig(mapping, headers, config);
    if (mappingError) {
      res.status(400).json({ error: mappingError });
      return;
    }
    const valid: unknown[] = [];
    const errors: Array<{
      row: number;
      message: string;
      raw?: Record<string, string>;
    }> = [];
    for (let i = 0; i < rows.length; i++) {
      const parsed = config.parseRow(rows[i], mapping);
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

router.post(
  "/data-imports/rosters/preview",
  requireImporter(),
  makePreviewHandler("rosters", ROSTERS_CONFIG),
);
router.post(
  "/data-imports/rosters/commit",
  requireImporter(),
  makeCommitHandler("rosters", ROSTERS_CONFIG),
);
router.post(
  "/data-imports/behavior/preview",
  requireImporter(),
  makePreviewHandler("behavior", BEHAVIOR_CONFIG),
);
router.post(
  "/data-imports/behavior/commit",
  requireImporter(),
  makeCommitHandler("behavior", BEHAVIOR_CONFIG),
);
router.post(
  "/data-imports/fast_scores/preview",
  requireImporter(),
  makePreviewHandler("fast_scores", FAST_SCORES_CONFIG),
);
router.post(
  "/data-imports/fast_scores/commit",
  requireImporter(),
  makeCommitHandler("fast_scores", FAST_SCORES_CONFIG),
);
router.post(
  "/data-imports/fast_prior_year/preview",
  requireImporter(),
  makePreviewHandler("fast_prior_year", FAST_PRIOR_YEAR_CONFIG),
);
router.post(
  "/data-imports/fast_prior_year/commit",
  requireImporter(),
  makeCommitHandler("fast_prior_year", FAST_PRIOR_YEAR_CONFIG),
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
