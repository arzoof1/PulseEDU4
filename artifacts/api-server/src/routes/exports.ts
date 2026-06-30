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
  classSectionsTable,
  dataExportAuditLogTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { requireSchool } from "../lib/scope.js";
import { isCoreTeam } from "../lib/coreTeam.js";
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

export default router;
