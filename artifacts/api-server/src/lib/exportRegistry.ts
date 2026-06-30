// =============================================================================
// Data Export — dataset registry
// =============================================================================
// The customizable exporter is backed by a curated REGISTRY of datasets, NOT a
// generic join-anything query builder. Each dataset declares its own columns,
// safe per-column formatters, the filters it supports, a permission gate, and a
// `run()` that returns already-formatted string rows. Adding a future "random
// download" = registering one more Dataset here; the routes + UI never change.
//
// NON-NEGOTIABLE GUARDRAILS enforced here:
//   * FLEID boundary: a dataset column whitelist NEVER includes student_id.
//     The only student identifier ever emitted is local_sis_id. `run()`
//     functions must never put `studentId` into an output cell.
//   * Multi-tenancy: every query is forced to ctx.schoolId.
//   * Visibility scoping: student-centric datasets resolve the actor's
//     visible student set via getVisibleStudentIds (Core Team / admin /
//     counselor => whole school; teachers => own roster ∪ trusted-adult),
//     then narrow further by any teacher/student filter.
//
// CSV formula-injection neutralization lives in `csvCell` below (mirrors the
// helper in routes/reports.ts) and is applied by `toCsv`.
// =============================================================================

import {
  db,
  studentsTable,
  staffTable,
  hallPassesTable,
  tier3WeeklyRecordsTable,
  classSectionsTable,
  sectionRosterTable,
} from "@workspace/db";
import {
  and,
  eq,
  inArray,
  asc,
  desc,
  gte,
  lte,
  type Column,
  type SQL,
} from "drizzle-orm";
import { isCoreTeam } from "./coreTeam.js";
import { getVisibleStudentIds } from "../routes/insights.js";

export type StaffRow = typeof staffTable.$inferSelect;

export type ExportFilters = {
  grade: number | null;
  teacherStaffId: number | null;
  studentId: string | null;
  dateFrom: string | null; // "YYYY-MM-DD" inclusive
  dateTo: string | null; // "YYYY-MM-DD" inclusive
};

export type ColumnDef = { id: string; label: string };

// A dataset row is always a flat map of column-id -> already-formatted string.
// Keeping rows as strings means preview and CSV/XLSX serialize identically and
// no raw value (e.g. a FLEID) can slip through a missing formatter.
export type DatasetRow = Record<string, string>;

export type ExportContext = {
  schoolId: number;
  staff: StaffRow;
  filters: ExportFilters;
  // null = no limit (full download); a number caps rows (preview).
  limit: number | null;
};

export type Dataset = {
  key: string;
  label: string;
  description: string;
  category: string;
  supportsGrade: boolean;
  supportsTeacher: boolean;
  supportsStudent: boolean;
  supportsDateRange: boolean;
  permission: (staff: StaffRow) => boolean;
  columns: ColumnDef[];
  run: (ctx: ExportContext) => Promise<DatasetRow[]>;
};

// ---------------------------------------------------------------------------
// Formatting helpers — every cell goes through one of these.
// ---------------------------------------------------------------------------
function txt(v: unknown): string {
  return v == null ? "" : String(v);
}
function yesNo(v: unknown): string {
  if (v == null) return "";
  return v ? "Yes" : "No";
}
const DISMISSAL_LABELS: Record<string, string> = {
  car_rider: "Car Rider",
  walker: "Walker",
  bus: "Bus",
  aftercare: "Aftercare",
  parent_pickup_only: "Parent Pickup Only",
};
function dismissalLabel(v: unknown): string {
  const s = txt(v);
  return DISMISSAL_LABELS[s] ?? s;
}
function dateOnly(v: unknown): string {
  if (!v) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

// Neutralize CSV formula injection: a cell starting with = + - @ (or a control
// char) can execute in Excel/Sheets. Prefix with an apostrophe and always
// quote. Mirrors routes/reports.ts `csvCell`.
export function csvCell(value: unknown): string {
  let s = value == null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCsv(columns: ColumnDef[], rows: DatasetRow[]): string {
  const header = columns.map((c) => csvCell(c.label)).join(",");
  if (!rows.length) return `${header}\r\n`;
  const body = rows
    .map((r) => columns.map((c) => csvCell(r[c.id] ?? "")).join(","))
    .join("\r\n");
  return `${header}\r\n${body}\r\n`;
}

// ---------------------------------------------------------------------------
// Student visibility / scope resolution
// ---------------------------------------------------------------------------
async function rosterStudentIdsForTeacher(
  schoolId: number,
  teacherStaffId: number,
): Promise<Set<string>> {
  const rows = await db
    .select({ studentId: sectionRosterTable.studentId })
    .from(sectionRosterTable)
    .innerJoin(
      classSectionsTable,
      and(
        eq(classSectionsTable.id, sectionRosterTable.sectionId),
        eq(classSectionsTable.schoolId, schoolId),
      ),
    )
    .where(
      and(
        eq(sectionRosterTable.schoolId, schoolId),
        eq(classSectionsTable.teacherStaffId, teacherStaffId),
        eq(classSectionsTable.isPlanning, false),
      ),
    );
  return new Set(rows.map((r) => r.studentId));
}

function intersect(a: Set<string>, b: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const x of a) if (b.has(x)) out.add(x);
  return out;
}

// Resolve the effective student-id scope for a student-centric dataset.
// `full: true` means whole-school (caller should NOT add a studentId filter).
// Otherwise `ids` is the exact allowed set (possibly empty => zero rows).
export async function resolveStudentScope(
  ctx: ExportContext,
  opts?: { skipTeacher?: boolean },
): Promise<{ full: boolean; ids: Set<string> }> {
  const vis = await getVisibleStudentIds(ctx.staff, ctx.schoolId);
  let full = vis.full;
  let ids = new Set(vis.ids);

  if (!opts?.skipTeacher && ctx.filters.teacherStaffId != null) {
    const roster = await rosterStudentIdsForTeacher(
      ctx.schoolId,
      ctx.filters.teacherStaffId,
    );
    ids = full ? roster : intersect(ids, roster);
    full = false;
  }

  if (ctx.filters.studentId) {
    const sid = ctx.filters.studentId;
    if (full) {
      ids = new Set([sid]);
    } else {
      ids = ids.has(sid) ? new Set([sid]) : new Set();
    }
    full = false;
  }

  return { full, ids };
}

// Build the inclusive date-range predicate for a TEXT ISO `created_at`-style
// column (or a "YYYY-MM-DD" date column). ISO-8601 strings sort
// lexicographically, so string comparison is correct: `>= dateFrom` and
// `<= dateTo + 'T23:59:59'` (the suffix keeps a date-only column inclusive of
// the whole end day).
function dateRangePredicates(column: Column, filters: ExportFilters): SQL[] {
  const preds: SQL[] = [];
  if (filters.dateFrom) preds.push(gte(column, filters.dateFrom));
  if (filters.dateTo) preds.push(lte(column, `${filters.dateTo}T23:59:59`));
  return preds;
}

// ===========================================================================
// Dataset: Students
// ===========================================================================
const studentsDataset: Dataset = {
  key: "students",
  label: "Students",
  description:
    "One row per student: name, Local SIS ID, grade, program flags, and demographics.",
  category: "Roster",
  supportsGrade: true,
  supportsTeacher: true,
  supportsStudent: true,
  supportsDateRange: false,
  permission: (staff) => isCoreTeam(staff),
  columns: [
    { id: "localSisId", label: "Local SIS ID" },
    { id: "lastName", label: "Last Name" },
    { id: "firstName", label: "First Name" },
    { id: "grade", label: "Grade" },
    { id: "gender", label: "Gender" },
    { id: "ell", label: "ELL" },
    { id: "ese", label: "ESE" },
    { id: "is504", label: "504" },
    { id: "ctEla", label: "Critical Thinking (ELA)" },
    { id: "ctMath", label: "Critical Thinking (Math)" },
    { id: "race", label: "Race" },
    { id: "ethnicity", label: "Ethnicity" },
    { id: "dismissalMode", label: "Dismissal Mode" },
  ],
  run: async (ctx) => {
    const scope = await resolveStudentScope(ctx);
    if (!scope.full && scope.ids.size === 0) return [];

    const where = [eq(studentsTable.schoolId, ctx.schoolId)];
    if (ctx.filters.grade != null)
      where.push(eq(studentsTable.grade, ctx.filters.grade));
    if (!scope.full)
      where.push(inArray(studentsTable.studentId, [...scope.ids]));

    const base = db
      .select({
        localSisId: studentsTable.localSisId,
        firstName: studentsTable.firstName,
        lastName: studentsTable.lastName,
        grade: studentsTable.grade,
        gender: studentsTable.gender,
        ell: studentsTable.ell,
        ese: studentsTable.ese,
        is504: studentsTable.is504,
        ctEla: studentsTable.ctEla,
        ctMath: studentsTable.ctMath,
        race: studentsTable.race,
        ethnicity: studentsTable.ethnicity,
        dismissalMode: studentsTable.dismissalMode,
      })
      .from(studentsTable)
      .where(and(...where))
      .orderBy(asc(studentsTable.lastName), asc(studentsTable.firstName));

    const rows = ctx.limit != null ? await base.limit(ctx.limit) : await base;
    return rows.map((r) => ({
      localSisId: txt(r.localSisId),
      lastName: txt(r.lastName),
      firstName: txt(r.firstName),
      grade: txt(r.grade),
      gender: txt(r.gender),
      ell: yesNo(r.ell),
      ese: yesNo(r.ese),
      is504: yesNo(r.is504),
      ctEla: yesNo(r.ctEla),
      ctMath: yesNo(r.ctMath),
      race: txt(r.race),
      ethnicity: txt(r.ethnicity),
      dismissalMode: dismissalLabel(r.dismissalMode),
    }));
  },
};

// ===========================================================================
// Dataset: Hall Passes
// ===========================================================================
// One row per hall pass, joined to the student for the name / Local SIS ID /
// grade (the pass row itself only carries the FLEID, which never leaves here).
// No teacher_staff_id on the pass, so teacher-filtering isn't offered; the
// date range filters on created_at (text ISO).
const hallPassesDataset: Dataset = {
  key: "hall_passes",
  label: "Hall Passes",
  description:
    "One row per hall pass: student, destination, origin room, teacher, status, and timing.",
  category: "Hall Pass",
  supportsGrade: true,
  supportsTeacher: false,
  supportsStudent: true,
  supportsDateRange: true,
  permission: (staff) => isCoreTeam(staff),
  columns: [
    { id: "localSisId", label: "Local SIS ID" },
    { id: "lastName", label: "Last Name" },
    { id: "firstName", label: "First Name" },
    { id: "grade", label: "Grade" },
    { id: "destination", label: "Destination" },
    { id: "originRoom", label: "Origin Room" },
    { id: "teacherName", label: "Issued By" },
    { id: "destinationTeacher", label: "Destination Teacher" },
    { id: "status", label: "Status" },
    { id: "createdAt", label: "Created" },
    { id: "endedAt", label: "Ended" },
    { id: "maxDurationMinutes", label: "Max Minutes" },
    { id: "isTardyReturn", label: "Tardy Return" },
  ],
  run: async (ctx) => {
    const scope = await resolveStudentScope(ctx);
    if (!scope.full && scope.ids.size === 0) return [];

    const where = [eq(hallPassesTable.schoolId, ctx.schoolId)];
    if (!scope.full)
      where.push(inArray(hallPassesTable.studentId, [...scope.ids]));
    if (ctx.filters.grade != null)
      where.push(eq(studentsTable.grade, ctx.filters.grade));
    where.push(...dateRangePredicates(hallPassesTable.createdAt, ctx.filters));

    const base = db
      .select({
        localSisId: studentsTable.localSisId,
        firstName: studentsTable.firstName,
        lastName: studentsTable.lastName,
        grade: studentsTable.grade,
        destination: hallPassesTable.destination,
        originRoom: hallPassesTable.originRoom,
        teacherName: hallPassesTable.teacherName,
        destinationTeacher: hallPassesTable.destinationTeacher,
        status: hallPassesTable.status,
        createdAt: hallPassesTable.createdAt,
        endedAt: hallPassesTable.endedAt,
        maxDurationMinutes: hallPassesTable.maxDurationMinutes,
        isTardyReturn: hallPassesTable.isTardyReturn,
      })
      .from(hallPassesTable)
      .innerJoin(
        studentsTable,
        and(
          eq(studentsTable.studentId, hallPassesTable.studentId),
          eq(studentsTable.schoolId, hallPassesTable.schoolId),
        ),
      )
      .where(and(...where))
      .orderBy(desc(hallPassesTable.createdAt));

    const rows = ctx.limit != null ? await base.limit(ctx.limit) : await base;
    return rows.map((r) => ({
      localSisId: txt(r.localSisId),
      lastName: txt(r.lastName),
      firstName: txt(r.firstName),
      grade: txt(r.grade),
      destination: txt(r.destination),
      originRoom: txt(r.originRoom),
      teacherName: txt(r.teacherName),
      destinationTeacher: txt(r.destinationTeacher),
      status: txt(r.status),
      createdAt: txt(r.createdAt),
      endedAt: txt(r.endedAt),
      maxDurationMinutes: txt(r.maxDurationMinutes),
      isTardyReturn: yesNo(r.isTardyReturn),
    }));
  },
};

// ===========================================================================
// Dataset: Interventions (Tier 3 weekly progress records)
// ===========================================================================
// One row per Tier 3 weekly record, joined to the student (name / Local SIS ID
// / grade) and the intervention teacher (display name). The "teacher" filter
// here means the INTERVENTION teacher (records.teacher_staff_id), NOT a roster
// teacher — so we skip resolveStudentScope's roster narrowing and filter the
// record column directly. Date range filters on week_start_date.
const interventionsDataset: Dataset = {
  key: "interventions",
  label: "Interventions (Tier 3 Weekly)",
  description:
    "One row per Tier 3 weekly progress record: student, intervention teacher, week, daily scores, and release status.",
  category: "MTSS",
  supportsGrade: true,
  supportsTeacher: true,
  supportsStudent: true,
  supportsDateRange: true,
  permission: (staff) => isCoreTeam(staff),
  columns: [
    { id: "localSisId", label: "Local SIS ID" },
    { id: "lastName", label: "Last Name" },
    { id: "firstName", label: "First Name" },
    { id: "grade", label: "Grade" },
    { id: "teacher", label: "Intervention Teacher" },
    { id: "weekStartDate", label: "Week Of" },
    { id: "monScore", label: "Mon" },
    { id: "tueScore", label: "Tue" },
    { id: "wedScore", label: "Wed" },
    { id: "thuScore", label: "Thu" },
    { id: "friScore", label: "Fri" },
    { id: "releasedNoIntervention", label: "Released (No Intervention)" },
    { id: "releaseReason", label: "Release Reason" },
    { id: "submittedAt", label: "Submitted" },
  ],
  run: async (ctx) => {
    const scope = await resolveStudentScope(ctx, { skipTeacher: true });
    if (!scope.full && scope.ids.size === 0) return [];

    const where = [eq(tier3WeeklyRecordsTable.schoolId, ctx.schoolId)];
    if (!scope.full)
      where.push(inArray(tier3WeeklyRecordsTable.studentId, [...scope.ids]));
    if (ctx.filters.teacherStaffId != null)
      where.push(
        eq(
          tier3WeeklyRecordsTable.teacherStaffId,
          ctx.filters.teacherStaffId,
        ),
      );
    if (ctx.filters.grade != null)
      where.push(eq(studentsTable.grade, ctx.filters.grade));
    where.push(
      ...dateRangePredicates(tier3WeeklyRecordsTable.weekStartDate, ctx.filters),
    );

    const base = db
      .select({
        localSisId: studentsTable.localSisId,
        firstName: studentsTable.firstName,
        lastName: studentsTable.lastName,
        grade: studentsTable.grade,
        teacher: staffTable.displayName,
        weekStartDate: tier3WeeklyRecordsTable.weekStartDate,
        monScore: tier3WeeklyRecordsTable.monScore,
        tueScore: tier3WeeklyRecordsTable.tueScore,
        wedScore: tier3WeeklyRecordsTable.wedScore,
        thuScore: tier3WeeklyRecordsTable.thuScore,
        friScore: tier3WeeklyRecordsTable.friScore,
        releasedNoIntervention: tier3WeeklyRecordsTable.releasedNoIntervention,
        releaseReason: tier3WeeklyRecordsTable.releaseReason,
        submittedAt: tier3WeeklyRecordsTable.submittedAt,
      })
      .from(tier3WeeklyRecordsTable)
      .innerJoin(
        studentsTable,
        and(
          eq(studentsTable.studentId, tier3WeeklyRecordsTable.studentId),
          eq(studentsTable.schoolId, tier3WeeklyRecordsTable.schoolId),
        ),
      )
      .leftJoin(
        staffTable,
        and(
          eq(staffTable.id, tier3WeeklyRecordsTable.teacherStaffId),
          eq(staffTable.schoolId, ctx.schoolId),
        ),
      )
      .where(and(...where))
      .orderBy(desc(tier3WeeklyRecordsTable.weekStartDate));

    const rows = ctx.limit != null ? await base.limit(ctx.limit) : await base;
    return rows.map((r) => ({
      localSisId: txt(r.localSisId),
      lastName: txt(r.lastName),
      firstName: txt(r.firstName),
      grade: txt(r.grade),
      teacher: txt(r.teacher),
      weekStartDate: txt(r.weekStartDate),
      monScore: txt(r.monScore),
      tueScore: txt(r.tueScore),
      wedScore: txt(r.wedScore),
      thuScore: txt(r.thuScore),
      friScore: txt(r.friScore),
      releasedNoIntervention: yesNo(r.releasedNoIntervention),
      releaseReason: txt(r.releaseReason),
      submittedAt: dateOnly(r.submittedAt),
    }));
  },
};

// ---------------------------------------------------------------------------
// Registry + lookup helpers
// ---------------------------------------------------------------------------
export const DATASETS: Dataset[] = [
  studentsDataset,
  hallPassesDataset,
  interventionsDataset,
];

export function getDataset(key: string): Dataset | undefined {
  return DATASETS.find((d) => d.key === key);
}

export function datasetsForStaff(staff: StaffRow): Dataset[] {
  return DATASETS.filter((d) => d.permission(staff));
}

// Resolve the effective output columns from a caller-supplied id list,
// preserving the dataset's declared order and dropping unknown ids. Empty /
// undefined selection => all columns.
export function resolveColumns(
  dataset: Dataset,
  requested: string[] | undefined,
): ColumnDef[] {
  if (!requested || requested.length === 0) return dataset.columns;
  const want = new Set(requested);
  const picked = dataset.columns.filter((c) => want.has(c.id));
  return picked.length ? picked : dataset.columns;
}

