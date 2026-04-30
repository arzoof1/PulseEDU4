// Unified intervention history feed.
//
// Two routes, same row shape:
//   GET /api/students/:studentId/intervention-history
//        — every Tier 2 / Tier 3 / legacy-intervention / quick-check-in
//          row for one student in the caller's school. Used by the
//          per-student panel on StudentProfile.
//
//   GET /api/interventions/my-history?from=&to=&studentId=&tier=
//        — the caller's own logs across students, filtered by the
//          requested date range and (optional) student / tier.
//          Core Team can pass `?staffId=` to view another teacher.
//          Used by the new "My Interventions" page.
//
// The unified row shape lets the client render one table regardless of
// source. `occurredAt` is a sort key (ISO-ish); `date` is the
// display string (YYYY-MM-DD or "week of YYYY-MM-DD" for Tier 3).

import { Router, type IRouter } from "express";
import {
  db,
  staffTable,
  studentsTable,
  tier2InterventionEntriesTable,
  tier3WeeklyRecordsTable,
  interventionEntriesTable,
  tardiesTable,
  trustedAdultInterventionsTable,
} from "@workspace/db";
import { and, eq, gte, lte, inArray, or } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import { isCoreTeam } from "../lib/coreTeam.js";

const router: IRouter = Router();

type Tier = "t2" | "t3" | "legacy" | "quick";

export type InterventionHistoryRow = {
  source: "tier2" | "tier3" | "legacy" | "checkInOut";
  sourceId: number;
  studentId: string;
  staffId: number | null;
  staffName: string | null;
  occurredAt: string; // ISO timestamp for sorting (newest first)
  date: string; // user-facing date label
  tier: Tier;
  typeLabel: string;
  detail: string | null;
};

async function loadStaff(
  req: import("express").Request,
  res: import("express").Response,
) {
  const staffId = req.staffId;
  if (!staffId) {
    res.status(401).json({ error: "Sign-in required" });
    return null;
  }
  const [staff] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, staffId));
  if (!staff || !staff.active) {
    res.status(401).json({ error: "Sign-in required" });
    return null;
  }
  return staff;
}

// Build a small lookup so Tier 2 entries can show the Trusted-Adult
// intervention name they were paired with (if any). We do one query
// per call instead of N+1.
async function loadTaiLookup(schoolId: number, ids: number[]) {
  const unique = [...new Set(ids.filter((n) => Number.isInteger(n) && n > 0))];
  if (unique.length === 0) return new Map<number, string>();
  const rows = await db
    .select({
      id: trustedAdultInterventionsTable.id,
      name: trustedAdultInterventionsTable.name,
    })
    .from(trustedAdultInterventionsTable)
    .where(
      and(
        eq(trustedAdultInterventionsTable.schoolId, schoolId),
        inArray(trustedAdultInterventionsTable.id, unique),
      ),
    );
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function loadStaffNameLookup(schoolId: number, ids: number[]) {
  const unique = [...new Set(ids.filter((n) => Number.isInteger(n) && n > 0))];
  if (unique.length === 0) return new Map<number, string>();
  const rows = await db
    .select({
      id: staffTable.id,
      name: staffTable.displayName,
    })
    .from(staffTable)
    .where(
      and(eq(staffTable.schoolId, schoolId), inArray(staffTable.id, unique)),
    );
  return new Map(rows.map((r) => [r.id, r.name]));
}

// Verify a studentId belongs to the caller's school. Returns true if
// the lookup succeeds; false (and writes a 404) otherwise. Used to
// stop cross-tenant reads on the per-student endpoint and on the
// optional ?studentId= filter of /my-history.
async function studentBelongsToSchool(
  schoolId: number,
  studentId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: studentsTable.studentId })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.schoolId, schoolId),
        eq(studentsTable.studentId, studentId),
      ),
    )
    .limit(1);
  return !!row;
}

function tier3WeekDetail(row: typeof tier3WeeklyRecordsTable.$inferSelect) {
  // Compact "Mon 5 / Tue 4 / Wed - / …" with a status suffix.
  const parts: string[] = [];
  const labels: Array<[string, number | null]> = [
    ["Mon", row.monScore],
    ["Tue", row.tueScore],
    ["Wed", row.wedScore],
    ["Thu", row.thuScore],
    ["Fri", row.friScore],
  ];
  for (const [d, v] of labels) {
    parts.push(`${d} ${v ?? "–"}`);
  }
  const status = row.submittedAt ? "submitted" : "draft";
  const note =
    typeof row.weeklyComment === "string" && row.weeklyComment.trim()
      ? ` — ${row.weeklyComment.trim()}`
      : "";
  return `${parts.join(" / ")} (${status})${note}`;
}

// ---------------------------------------------------------------
// Builders. Each one returns the unified shape from a single source.
// ---------------------------------------------------------------

async function fetchTier2(opts: {
  schoolId: number;
  studentId?: string;
  staffId?: number;
  from?: string;
  to?: string;
}): Promise<InterventionHistoryRow[]> {
  const conds = [eq(tier2InterventionEntriesTable.schoolId, opts.schoolId)];
  if (opts.studentId)
    conds.push(eq(tier2InterventionEntriesTable.studentId, opts.studentId));
  if (opts.staffId)
    conds.push(
      eq(tier2InterventionEntriesTable.teacherStaffId, opts.staffId),
    );
  if (opts.from)
    conds.push(gte(tier2InterventionEntriesTable.entryDate, opts.from));
  if (opts.to)
    conds.push(lte(tier2InterventionEntriesTable.entryDate, opts.to));
  const rows = await db
    .select()
    .from(tier2InterventionEntriesTable)
    .where(and(...conds));
  const tai = await loadTaiLookup(
    opts.schoolId,
    rows.map((r) => r.trustedAdultInterventionId ?? 0),
  );
  const staffNames = await loadStaffNameLookup(
    opts.schoolId,
    rows.map((r) => r.teacherStaffId),
  );
  return rows.map((r) => ({
    source: "tier2",
    sourceId: r.id,
    studentId: r.studentId,
    staffId: r.teacherStaffId,
    staffName: staffNames.get(r.teacherStaffId) ?? null,
    occurredAt: `${r.entryDate}T00:00:00Z`,
    date: r.entryDate,
    tier: "t2",
    typeLabel: `Tier 2 — ${r.subType === "cico" ? "CICO" : "Behavior Group"}`,
    detail: [
      r.trustedAdultInterventionId
        ? tai.get(r.trustedAdultInterventionId) ?? null
        : null,
      r.notes && r.notes.trim() ? r.notes.trim() : null,
    ]
      .filter(Boolean)
      .join(" — ") || null,
  }));
}

async function fetchTier3(opts: {
  schoolId: number;
  studentId?: string;
  staffId?: number;
  from?: string;
  to?: string;
}): Promise<InterventionHistoryRow[]> {
  const conds = [eq(tier3WeeklyRecordsTable.schoolId, opts.schoolId)];
  if (opts.studentId)
    conds.push(eq(tier3WeeklyRecordsTable.studentId, opts.studentId));
  if (opts.staffId)
    conds.push(eq(tier3WeeklyRecordsTable.teacherStaffId, opts.staffId));
  if (opts.from)
    conds.push(gte(tier3WeeklyRecordsTable.weekStartDate, opts.from));
  if (opts.to)
    conds.push(lte(tier3WeeklyRecordsTable.weekStartDate, opts.to));
  const rows = await db
    .select()
    .from(tier3WeeklyRecordsTable)
    .where(and(...conds));
  const staffNames = await loadStaffNameLookup(
    opts.schoolId,
    rows.map((r) => r.teacherStaffId),
  );
  return rows.map((r) => ({
    source: "tier3",
    sourceId: r.id,
    studentId: r.studentId,
    staffId: r.teacherStaffId,
    staffName: staffNames.get(r.teacherStaffId) ?? null,
    // Use updatedAt if present so a re-saved week sorts to the top;
    // fall back to createdAt and finally to the week start.
    occurredAt:
      (r.updatedAt && new Date(r.updatedAt).toISOString()) ||
      (r.createdAt && new Date(r.createdAt).toISOString()) ||
      `${r.weekStartDate}T00:00:00Z`,
    date: `Week of ${r.weekStartDate}`,
    tier: "t3",
    typeLabel: "Tier 3 — Weekly",
    detail: tier3WeekDetail(r),
  }));
}

async function fetchLegacy(opts: {
  schoolId: number;
  studentId?: string;
  staffId?: number;
  from?: string;
  to?: string;
}): Promise<InterventionHistoryRow[]> {
  const conds = [eq(interventionEntriesTable.schoolId, opts.schoolId)];
  if (opts.studentId)
    conds.push(eq(interventionEntriesTable.studentId, opts.studentId));
  if (opts.staffId)
    conds.push(eq(interventionEntriesTable.staffId, opts.staffId));
  // intervention_entries.created_at is timestamp; date filter uses
  // the date prefix.
  if (opts.from)
    conds.push(gte(interventionEntriesTable.createdAt, `${opts.from}T00:00:00.000Z`));
  if (opts.to)
    conds.push(lte(interventionEntriesTable.createdAt, `${opts.to}T23:59:59.999Z`));
  const rows = await db
    .select()
    .from(interventionEntriesTable)
    .where(and(...conds));
  return rows.map((r) => ({
    source: "legacy",
    sourceId: r.id,
    studentId: r.studentId,
    staffId: r.staffId,
    staffName: r.staffName,
    occurredAt: r.createdAt,
    date: r.createdAt.slice(0, 10),
    tier: "legacy",
    typeLabel: `Trusted Adult — ${r.interventionType}`,
    detail: r.note && r.note.trim() ? r.note.trim() : null,
  }));
}

async function fetchCheckIns(opts: {
  schoolId: number;
  studentId?: string;
  // Quick check-ins have no staff_id; we filter by display name. We
  // push the filter into SQL so a teacher with no recent check-ins
  // doesn't drag the entire school's tardy table back across the wire.
  staffName?: string;
  from?: string;
  to?: string;
}): Promise<InterventionHistoryRow[]> {
  const conds = [
    eq(tardiesTable.schoolId, opts.schoolId),
    inArray(tardiesTable.entryType, ["checkin", "checkout", "intervention"]),
  ];
  if (opts.studentId) conds.push(eq(tardiesTable.studentId, opts.studentId));
  if (opts.from) conds.push(gte(tardiesTable.createdAt, `${opts.from}T00:00:00.000Z`));
  if (opts.to) conds.push(lte(tardiesTable.createdAt, `${opts.to}T23:59:59.999Z`));
  if (opts.staffName) {
    const nameCond = or(
      eq(tardiesTable.createdBy, opts.staffName),
      eq(tardiesTable.teacherName, opts.staffName),
    );
    if (nameCond) conds.push(nameCond);
  }
  const rows = await db.select().from(tardiesTable).where(and(...conds));
  return rows
    .map((r) => ({
      source: "checkInOut",
      sourceId: r.id,
      studentId: r.studentId,
      staffId: null,
      staffName: r.createdBy || r.teacherName,
      occurredAt: r.createdAt,
      date: r.createdAt.slice(0, 10),
      tier: "quick",
      typeLabel:
        r.entryType === "intervention"
          ? `Quick Check-in — ${r.checkInWith || "Intervention"}`
          : r.entryType === "checkin"
            ? "Quick Check-in"
            : "Quick Check-out",
      detail: r.notes && r.notes.trim() ? r.notes.trim() : null,
    }));
}

function mergeNewestFirst(...lists: InterventionHistoryRow[][]) {
  return lists
    .flat()
    .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1));
}

// ---------------------------------------------------------------
// Routes
// ---------------------------------------------------------------

router.get(
  "/students/:studentId/intervention-history",
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const staff = await loadStaff(req, res);
    if (!staff) return;
    const studentId = String(req.params.studentId || "").trim();
    if (!studentId) {
      res.status(400).json({ error: "studentId is required" });
      return;
    }
    // Cross-tenant safety: a teacher in school A must not be able to
    // read intervention history for a student in school B by guessing
    // the path id.
    if (!(await studentBelongsToSchool(schoolId, studentId))) {
      res.status(404).json({ error: "Student not found" });
      return;
    }
    const [t2, t3, legacy, checkIns] = await Promise.all([
      fetchTier2({ schoolId, studentId }),
      fetchTier3({ schoolId, studentId }),
      fetchLegacy({ schoolId, studentId }),
      fetchCheckIns({ schoolId, studentId }),
    ]);
    res.json({
      studentId,
      rows: mergeNewestFirst(t2, t3, legacy, checkIns),
    });
  },
);

router.get("/interventions/my-history", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId === null) return;
  const staff = await loadStaff(req, res);
  if (!staff) return;

  // Permit Core Team to view another teacher's history (they already
  // have access to this data via Intervention Reports). Plain teachers
  // are pinned to their own staff_id.
  let viewedStaffId = staff.id;
  let viewedStaffName = staff.displayName;
  const requested = req.query.staffId;
  if (requested !== undefined && requested !== "") {
    const wantId = Number(requested);
    if (!Number.isInteger(wantId) || wantId < 1) {
      res.status(400).json({ error: "staffId must be a positive integer" });
      return;
    }
    if (wantId !== staff.id) {
      if (!isCoreTeam(staff)) {
        res
          .status(403)
          .json({ error: "Not allowed to view another staff member's history" });
        return;
      }
      const [other] = await db
        .select()
        .from(staffTable)
        .where(and(eq(staffTable.id, wantId), eq(staffTable.schoolId, schoolId)));
      if (!other) {
        res.status(404).json({ error: "Staff member not found" });
        return;
      }
      viewedStaffId = other.id;
      viewedStaffName = other.displayName;
    }
  }

  const studentId = req.query.studentId
    ? String(req.query.studentId).trim() || undefined
    : undefined;
  // Same cross-tenant safety as the per-student route: don't let a
  // teacher narrow their history by a studentId outside their school.
  if (studentId && !(await studentBelongsToSchool(schoolId, studentId))) {
    res.status(404).json({ error: "Student not found" });
    return;
  }
  const tierFilter = req.query.tier
    ? String(req.query.tier).trim().toLowerCase()
    : "";
  const from = req.query.from ? String(req.query.from).slice(0, 10) : undefined;
  const to = req.query.to ? String(req.query.to).slice(0, 10) : undefined;

  // Light validation on date strings.
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  if (from && !DATE_RE.test(from)) {
    res.status(400).json({ error: "from must be YYYY-MM-DD" });
    return;
  }
  if (to && !DATE_RE.test(to)) {
    res.status(400).json({ error: "to must be YYYY-MM-DD" });
    return;
  }

  // Fan out per-source. We always run all four queries but the result
  // sets are small and this keeps the response simple regardless of
  // what tier filter the client picks. The client then narrows by
  // `tier` if a specific one was requested — keeps the union counts
  // honest in the summary row.
  const [t2, t3, legacy, checkIns] = await Promise.all([
    fetchTier2({
      schoolId,
      studentId,
      staffId: viewedStaffId,
      from,
      to,
    }),
    fetchTier3({
      schoolId,
      studentId,
      staffId: viewedStaffId,
      from,
      to,
    }),
    fetchLegacy({
      schoolId,
      studentId,
      staffId: viewedStaffId,
      from,
      to,
    }),
    fetchCheckIns({
      schoolId,
      studentId,
      staffName: viewedStaffName,
      from,
      to,
    }),
  ]);

  // Per-tier counts BEFORE the optional tier filter is applied so the
  // summary row can stay accurate even when the user has narrowed the
  // table to one tier.
  const counts = {
    t2: t2.length,
    t3: t3.length,
    legacy: legacy.length,
    quick: checkIns.length,
  };

  let rows = mergeNewestFirst(t2, t3, legacy, checkIns);
  if (tierFilter && tierFilter !== "all") {
    rows = rows.filter((r) => r.tier === tierFilter);
  }

  res.json({
    staffId: viewedStaffId,
    staffName: viewedStaffName,
    counts,
    rows,
  });
});

export default router;
