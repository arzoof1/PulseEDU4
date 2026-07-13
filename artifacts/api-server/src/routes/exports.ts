// =============================================================================
// Data Export — routes
// =============================================================================
// Customizable, registry-backed exporter. Three endpoints:
//   GET  /api/exports/datasets        -> datasets the actor may export
//   POST /api/exports/preview         -> first N formatted rows (no audit)
//   POST /api/exports/download        -> full file (CSV now, XLSX in P3) + audit
//
// Every handler resolves the actor's full staff row (for permission + student
// visibility) and forces ctx.schoolId. The dataset registry (lib/exportRegistry)
// owns column whitelisting (FLEID never emitted), formatting, and CSV injection
// neutralization. Downloads are append-only-audited before the bytes go out.
// =============================================================================

import { Router, type IRouter, type Request } from "express";
import {
  db,
  staffTable,
  studentsTable,
  classSectionsTable,
  dataExportAuditLogTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { requireSchool } from "../lib/scope.js";
import { isCoreTeam } from "../lib/coreTeam.js";
import { hasFreshPrivilegedReauth } from "../lib/privilegedReauth.js";
import * as ExcelJS from "exceljs";
import {
  getDataset,
  datasetsForStaff,
  resolveColumns,
  toCsv,
  type ExportFilters,
  type StaffRow,
  type ColumnDef,
  type DatasetRow,
} from "../lib/exportRegistry.js";
import {
  loadStudentMetrics,
  resolveMetricRange,
  computeCohortComparison,
  METRIC_DESCRIPTORS,
  type StudentMetrics,
} from "../lib/studentMetrics.js";
import { getVisibleStudentIds } from "./insights.js";
import { loadStudentFastParity } from "../lib/fastParity.js";

const router: IRouter = Router();

// Preview is capped so a "show me what this looks like" tap never pulls the
// whole school. The full set only leaves via /download.
const PREVIEW_LIMIT = 50;

async function loadActor(req: Request): Promise<StaffRow | null> {
  const staffId = req.staffId;
  if (!staffId) return null;
  const [staff] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, staffId));
  return staff ?? null;
}

const filtersSchema = z
  .object({
    grade: z.number().int().nullable().optional(),
    teacherStaffId: z.number().int().positive().nullable().optional(),
    studentId: z.string().min(1).max(64).nullable().optional(),
    dateFrom: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    dateTo: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
  })
  .partial();

const bodySchema = z.object({
  dataset: z.string().min(1),
  columns: z.array(z.string()).optional(),
  filters: filtersSchema.optional(),
  format: z.enum(["csv", "xlsx"]).optional(),
});

function normalizeFilters(
  raw: z.infer<typeof filtersSchema> | undefined,
): ExportFilters {
  return {
    grade: raw?.grade ?? null,
    teacherStaffId: raw?.teacherStaffId ?? null,
    studentId: raw?.studentId ?? null,
    dateFrom: raw?.dateFrom ?? null,
    dateTo: raw?.dateTo ?? null,
  };
}

// Build an XLSX workbook buffer from the same columns + string rows used by CSV.
// exceljs writes strings as-is; no formula evaluation, so the apostrophe-prefix
// injection guard from csvCell is unnecessary here (cells are inert text).
async function toXlsx(
  columns: ColumnDef[],
  rows: DatasetRow[],
  sheetName: string,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName.slice(0, 31) || "Export");
  ws.columns = columns.map((c) => ({
    header: c.label,
    key: c.id,
    width: Math.min(Math.max(c.label.length + 2, 12), 40),
  }));
  ws.getRow(1).font = { bold: true };
  for (const r of rows) {
    ws.addRow(columns.map((c) => r[c.id] ?? ""));
  }
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

// GET /api/exports/datasets — registry filtered by the actor's permissions.
router.get("/exports/datasets", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const staff = await loadActor(req);
  if (!staff) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const datasets = datasetsForStaff(staff).map((d) => ({
    key: d.key,
    label: d.label,
    description: d.description,
    category: d.category,
    supportsGrade: d.supportsGrade,
    supportsTeacher: d.supportsTeacher,
    supportsStudent: d.supportsStudent,
    supportsDateRange: d.supportsDateRange,
    columns: d.columns,
  }));
  res.json({ datasets });
});

// GET /api/exports/teachers — teacher options for the teacher filter, gated by
// the same Core Team check as the export page (NOT the narrower admin/ESE-only
// /reports/teachers), so privileged non-admin roles still get a populated
// dropdown. School-scoped.
router.get("/exports/teachers", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const staff = await loadActor(req);
  if (!staff) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  if (!isCoreTeam(staff)) {
    res.status(403).json({ error: "Not permitted" });
    return;
  }
  const rows = await db
    .selectDistinct({
      id: staffTable.id,
      displayName: staffTable.displayName,
    })
    .from(staffTable)
    .innerJoin(
      classSectionsTable,
      and(
        eq(classSectionsTable.teacherStaffId, staffTable.id),
        eq(classSectionsTable.schoolId, schoolId),
      ),
    )
    .where(
      and(
        eq(staffTable.active, true),
        eq(classSectionsTable.isPlanning, false),
        eq(staffTable.schoolId, schoolId),
      ),
    );
  rows.sort((a, b) => a.displayName.localeCompare(b.displayName));
  res.json({ teachers: rows });
});

// POST /api/exports/preview — first PREVIEW_LIMIT rows. No audit (no file left).
router.post("/exports/preview", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const staff = await loadActor(req);
  if (!staff) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const dataset = getDataset(parsed.data.dataset);
  if (!dataset) {
    res.status(404).json({ error: "Unknown dataset" });
    return;
  }
  if (!dataset.permission(staff)) {
    res.status(403).json({ error: "Not permitted to export this dataset" });
    return;
  }
  const columns = resolveColumns(dataset, parsed.data.columns);
  const filters = normalizeFilters(parsed.data.filters);
  const rows = await dataset.run({
    schoolId,
    staff,
    filters,
    limit: PREVIEW_LIMIT,
  });
  res.json({
    columns,
    rows,
    previewLimit: PREVIEW_LIMIT,
    truncated: rows.length >= PREVIEW_LIMIT,
  });
});

// POST /api/exports/download — full dataset as CSV (P1) or XLSX (P3). Audited.
router.post("/exports/download", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const staff = await loadActor(req);
  if (!staff) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  // Step-up reauth (Section 1.15): a full-dataset export is the primary
  // student-PII exfil surface, so require a recent privileged step-up.
  if (!hasFreshPrivilegedReauth(req.session)) {
    res.status(403).json({ error: "reauth_required" });
    return;
  }
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const dataset = getDataset(parsed.data.dataset);
  if (!dataset) {
    res.status(404).json({ error: "Unknown dataset" });
    return;
  }
  if (!dataset.permission(staff)) {
    res.status(403).json({ error: "Not permitted to export this dataset" });
    return;
  }
  const format = parsed.data.format ?? "csv";
  const columns = resolveColumns(dataset, parsed.data.columns);
  const filters = normalizeFilters(parsed.data.filters);
  const rows = await dataset.run({ schoolId, staff, filters, limit: null });

  // Append-only audit BEFORE the bytes leave — exports remove PII from the
  // app's access controls, so the trail is non-optional.
  await db.insert(dataExportAuditLogTable).values({
    schoolId,
    datasetKey: dataset.key,
    format,
    columns: columns.map((c) => c.id),
    filters: { ...filters },
    rowCount: rows.length,
    actorStaffId: staff.id,
    actorName: staff.displayName ?? staff.email ?? null,
  });

  const stamp = new Date().toISOString().slice(0, 10);
  if (format === "xlsx") {
    const buf = await toXlsx(columns, rows, dataset.label);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${dataset.key}-${stamp}.xlsx"`,
    );
    res.send(buf);
    return;
  }

  const csv = toCsv(columns, rows);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${dataset.key}-${stamp}.csv"`,
  );
  res.send(csv);
});

// ===========================================================================
// GET /api/exports/snapshot/:studentId — visual single-student snapshot
// ===========================================================================
// Returns the student's whole-child metrics plus a grade-cohort comparison
// (mean + percentile per numeric metric, suppressed below the min cohort size)
// and an oriented-percentile radar (bigger shape = healthier). Same gate as the
// export datasets (isCoreTeam) PLUS getVisibleStudentIds defensive scoping.
//
// FLEID boundary: the response carries localSisId only. The metrics engine keys
// on studentId, but we strip it from everything emitted — the wire shape holds
// numbers (the student's values + de-identified cohort value arrays) only.
const snapshotQuerySchema = z.object({
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

// Orient a percentile so "outward / higher" always means healthier, regardless
// of whether the underlying metric is good or bad when large.
function orientedPercentile(
  percentile: number | null,
  direction: "higher_better" | "higher_worse",
): number | null {
  if (percentile == null) return null;
  return direction === "higher_better" ? percentile : 100 - percentile;
}

router.get("/exports/snapshot/:studentId", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const staff = await loadActor(req);
  if (!staff) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  if (!isCoreTeam(staff)) {
    res.status(403).json({ error: "Not permitted" });
    return;
  }
  const studentId = req.params.studentId;
  const q = snapshotQuerySchema.safeParse(req.query);
  if (!studentId || !q.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }

  // Load the target student (school-scoped). Identity is local_sis_id only.
  const [student] = await db
    .select({
      studentId: studentsTable.studentId,
      localSisId: studentsTable.localSisId,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
      grade: studentsTable.grade,
      gender: studentsTable.gender,
      ell: studentsTable.ell,
      ese: studentsTable.ese,
      is504: studentsTable.is504,
    })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.schoolId, schoolId),
        eq(studentsTable.studentId, studentId),
      ),
    );
  if (!student) {
    res.status(404).json({ error: "Student not found" });
    return;
  }

  // Defensive visibility scoping (Core Team => full; still guards future gates).
  const vis = await getVisibleStudentIds(staff, schoolId);
  if (!vis.full && !vis.ids.has(studentId)) {
    res.status(404).json({ error: "Student not found" });
    return;
  }

  const range = await resolveMetricRange(schoolId, {
    from: q.data.from ?? null,
    to: q.data.to ?? null,
  });

  // Roster-parity FAST view for this student (both subjects, null-filled when
  // absent). Same shared helpers as the roster / insights, so numbers agree.
  const fast = await loadStudentFastParity({
    schoolId,
    studentId,
    grade: student.grade,
  });

  // Cohort = every student in the same grade at this school.
  const cohortRows =
    student.grade == null
      ? []
      : await db
          .select({ studentId: studentsTable.studentId })
          .from(studentsTable)
          .where(
            and(
              eq(studentsTable.schoolId, schoolId),
              eq(studentsTable.grade, student.grade),
            ),
          );
  const cohortIds = cohortRows.map((r) => r.studentId);
  // Always include the target even if grade is null / not in the grade query.
  if (!cohortIds.includes(studentId)) cohortIds.push(studentId);

  const metricsMap = await loadStudentMetrics(schoolId, cohortIds, range);
  const me = metricsMap.get(studentId);
  if (!me) {
    res.status(404).json({ error: "Student not found" });
    return;
  }

  const numericKeys = METRIC_DESCRIPTORS.map((d) => d.key);
  // Pre-collect cohort value arrays per metric key (de-identified numbers).
  const cohortValues: Record<string, (number | null | undefined)[]> = {};
  for (const key of numericKeys) cohortValues[key] = [];
  for (const m of metricsMap.values()) {
    for (const key of numericKeys) {
      cohortValues[key].push(m[key] as number | null | undefined);
    }
  }

  const metrics = METRIC_DESCRIPTORS.map((d) => {
    const value = me[d.key] as number | null;
    const cmp = computeCohortComparison(value, cohortValues[d.key], 10);
    return {
      key: d.key,
      label: d.label,
      direction: d.direction,
      pillar: d.pillar,
      value: cmp.value,
      mean: cmp.mean,
      percentile: cmp.percentile,
      n: cmp.n,
      suppressed: cmp.suppressed,
      orientedPercentile: cmp.suppressed
        ? null
        : orientedPercentile(cmp.percentile, d.direction),
      // De-identified cohort distribution (numbers only), omitted when suppressed.
      distribution: cmp.suppressed
        ? []
        : cohortValues[d.key].filter(
            (v): v is number => typeof v === "number" && Number.isFinite(v),
          ),
    };
  });

  // Pillar radar: average oriented percentile across each pillar's metrics.
  const pillarLabels: Record<string, string> = {
    shows_up: "Shows Up",
    stays: "Stays in Room",
    engages: "Engages",
    achieves: "Achieves",
  };
  const radar = (["shows_up", "stays", "engages", "achieves"] as const).map(
    (pillar) => {
      const vals = metrics
        .filter((m) => m.pillar === pillar && m.orientedPercentile != null)
        .map((m) => m.orientedPercentile as number);
      const studentScore = vals.length
        ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length)
        : null;
      return {
        pillar,
        label: pillarLabels[pillar],
        studentScore,
        suppressed: vals.length === 0,
      };
    },
  );

  // The student's raw metrics WITHOUT the FLEID key (for the supports/academics
  // sections that show actual values, not comparisons).
  const { studentId: _omit, ...rawMetrics } = me satisfies StudentMetrics;
  void _omit;

  res.json({
    student: {
      localSisId: student.localSisId ?? null,
      firstName: student.firstName,
      lastName: student.lastName,
      grade: student.grade,
      gender: student.gender,
      ell: student.ell,
      ese: student.ese,
      is504: student.is504,
    },
    range,
    cohort: {
      grade: student.grade,
      label: student.grade == null ? "Grade —" : `Grade ${student.grade}`,
      n: cohortIds.length,
      minCohort: 10,
      suppressed: cohortIds.length < 10,
    },
    metrics,
    radar,
    rawMetrics,
    // Teacher-Roster-parity FAST view (level pills, points-to-next-level,
    // points-to-proficiency, learning-gain check) — single-sourced so the
    // Snapshot's numbers match the roster / insights drill-downs exactly.
    fast,
  });
});

export default router;
