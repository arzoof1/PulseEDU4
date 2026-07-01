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
  studentsTable,
  schoolSettingsTable,
  eligibilityActivitiesTable,
  eligibilityActivityMembersTable,
  eligibilityActivityCoachesTable,
  eligibilityAbsencesTable,
  eligibilityParentNotesTable,
  eligibilityUploadsTable,
} from "@workspace/db";
import { and, eq, inArray, sql, desc } from "drizzle-orm";
import PDFDocument from "pdfkit";
import { requireSchool } from "../lib/scope.js";
import { canManageEligibility } from "../lib/coreTeam.js";
import {
  loadEligibilitySettings,
  buildEligibilityMap,
  loadActiveMembers,
  type EligibilitySettings,
} from "../lib/eligibility.js";
import { notifyEligibilityUpload } from "../lib/eligibilityNotify.js";

// =============================================================================
// Eligibility Hub — attendance-based participation eligibility for athletics,
// clubs, and activities. Tenant-scoped via req.schoolId.
//
// Audience: managers (admin / Core Team / Athletic Director / front-office
// dismissal cap) via canManageEligibility. Coaches assigned to an activity
// get a read-only view of their own rosters.
//
// Client talks to this module via authFetch (no OpenAPI codegen) — matching
// the DataImports / Pickup precedent. DEVIATION from the contract-first norm,
// documented in the commit message.
// =============================================================================

const router: IRouter = Router();
type StaffRow = typeof staffTable.$inferSelect;

async function requireStaff(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const staffId = req.staffId;
  if (!staffId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const [staff] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, staffId));
  if (!staff || !staff.active) {
    res.status(401).json({ error: "Staff not found or inactive" });
    return;
  }
  (req as Request & { staff: StaffRow }).staff = staff;
  next();
}

function staffOf(req: Request): StaffRow {
  return (req as Request & { staff: StaffRow }).staff;
}

function requireManager(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!canManageEligibility(staffOf(req))) {
    res
      .status(403)
      .json({ error: "Not authorized to manage eligibility" });
    return;
  }
  next();
}

// The attendance/tardy upload is one of the four delegable data importers.
// Eligibility managers reach it as before; a delegated clerk may also reach it
// with capImportAttendance alone (without the rest of the Eligibility Hub).
function requireAttendanceImporter(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const staff = staffOf(req);
  if (!canManageEligibility(staff) && !staff.capImportAttendance) {
    res
      .status(403)
      .json({ error: "Not authorized to import attendance" });
    return;
  }
  next();
}

// Settings edits are limited to admin / district admin / SuperUser /
// Athletic Director (district-default ownership). Core Team / front-office
// dismissal staff can manage rosters + notes but not the school-wide rules.
function requireSettingsManager(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const s = staffOf(req);
  const ok =
    Boolean(s.isSuperUser) ||
    Boolean(s.isDistrictAdmin) ||
    Boolean(s.isAdmin) ||
    Boolean(s.isAthleticDirector);
  if (!ok) {
    res
      .status(403)
      .json({ error: "Not authorized to edit eligibility settings" });
    return;
  }
  next();
}

function asInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

// ---- Settings --------------------------------------------------------------

router.get(
  "/eligibility/settings",
  requireStaff,
  requireManager,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const settings = await loadEligibilitySettings(schoolId);
    res.json({
      ...settings,
      canEditSettings:
        Boolean(staffOf(req).isSuperUser) ||
        Boolean(staffOf(req).isDistrictAdmin) ||
        Boolean(staffOf(req).isAdmin) ||
        Boolean(staffOf(req).isAthleticDirector),
    });
  },
);

router.put(
  "/eligibility/settings",
  requireStaff,
  requireSettingsManager,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const b = req.body ?? {};
    const patch: Record<string, unknown> = {};
    if (b.threshold !== undefined)
      patch.eligibilityIneligibilityThreshold = asInt(b.threshold, 10, 1, 365);
    if (b.warningWindowDays !== undefined)
      patch.eligibilityWarningWindowDays = asInt(b.warningWindowDays, 4, 0, 365);
    if (b.tardyToAbsenceRatio !== undefined)
      patch.eligibilityTardyToAbsenceRatio = asInt(
        b.tardyToAbsenceRatio,
        0,
        0,
        100,
      );
    if (b.parentNoteCap !== undefined)
      patch.eligibilityParentNoteCap = asInt(b.parentNoteCap, 5, 0, 365);
    if (b.districtAdNotify !== undefined)
      patch.eligibilityDistrictAdNotify = Boolean(b.districtAdNotify);
    if (typeof b.semesterLabel === "string")
      patch.eligibilitySemesterLabel = b.semesterLabel.trim().slice(0, 60);
    if (b.semesterStart !== undefined)
      patch.eligibilitySemesterStart = b.semesterStart || null;
    if (b.semesterEnd !== undefined)
      patch.eligibilitySemesterEnd = b.semesterEnd || null;

    if (Object.keys(patch).length > 0) {
      await db
        .update(schoolSettingsTable)
        .set(patch)
        .where(eq(schoolSettingsTable.schoolId, schoolId));
    }
    const settings = await loadEligibilitySettings(schoolId);
    res.json(settings);
  },
);

// ---- Activities + coaches --------------------------------------------------

router.get(
  "/eligibility/activities",
  requireStaff,
  requireManager,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const activities = await db
      .select()
      .from(eligibilityActivitiesTable)
      .where(eq(eligibilityActivitiesTable.schoolId, schoolId))
      .orderBy(eligibilityActivitiesTable.name);

    const counts = await db
      .select({
        activityId: eligibilityActivityMembersTable.activityId,
        c: sql<number>`count(*)::int`,
      })
      .from(eligibilityActivityMembersTable)
      .where(
        and(
          eq(eligibilityActivityMembersTable.schoolId, schoolId),
          eq(eligibilityActivityMembersTable.active, true),
        ),
      )
      .groupBy(eligibilityActivityMembersTable.activityId);
    const countMap = new Map(counts.map((c) => [c.activityId, c.c]));

    const coaches = await db
      .select({
        id: eligibilityActivityCoachesTable.id,
        activityId: eligibilityActivityCoachesTable.activityId,
        staffId: eligibilityActivityCoachesTable.staffId,
        name: staffTable.displayName,
      })
      .from(eligibilityActivityCoachesTable)
      .innerJoin(
        staffTable,
        eq(eligibilityActivityCoachesTable.staffId, staffTable.id),
      )
      .where(eq(eligibilityActivityCoachesTable.schoolId, schoolId));
    const coachMap = new Map<number, typeof coaches>();
    for (const c of coaches) {
      const list = coachMap.get(c.activityId) ?? [];
      list.push(c);
      coachMap.set(c.activityId, list);
    }

    res.json(
      activities.map((a) => ({
        ...a,
        memberCount: countMap.get(a.id) ?? 0,
        coaches: coachMap.get(a.id) ?? [],
      })),
    );
  },
);

router.post(
  "/eligibility/activities",
  requireStaff,
  requireManager,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const name = String(req.body?.name ?? "").trim();
    if (!name) {
      res.status(400).json({ error: "Name is required" });
      return;
    }
    const category = ["athletics", "club", "activity"].includes(
      req.body?.category,
    )
      ? req.body.category
      : "athletics";
    const [row] = await db
      .insert(eligibilityActivitiesTable)
      .values({
        schoolId,
        name,
        category,
        createdByStaffId: req.staffId ?? null,
      })
      .returning();
    res.status(201).json(row);
  },
);

router.patch(
  "/eligibility/activities/:id",
  requireStaff,
  requireManager,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const id = Number(req.params.id);
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (typeof req.body?.name === "string" && req.body.name.trim())
      patch.name = req.body.name.trim();
    if (["athletics", "club", "activity"].includes(req.body?.category))
      patch.category = req.body.category;
    if (req.body?.active !== undefined) patch.active = Boolean(req.body.active);
    const [row] = await db
      .update(eligibilityActivitiesTable)
      .set(patch)
      .where(
        and(
          eq(eligibilityActivitiesTable.id, id),
          eq(eligibilityActivitiesTable.schoolId, schoolId),
        ),
      )
      .returning();
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(row);
  },
);

router.delete(
  "/eligibility/activities/:id",
  requireStaff,
  requireManager,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const id = Number(req.params.id);
    await db
      .delete(eligibilityActivityMembersTable)
      .where(
        and(
          eq(eligibilityActivityMembersTable.activityId, id),
          eq(eligibilityActivityMembersTable.schoolId, schoolId),
        ),
      );
    await db
      .delete(eligibilityActivityCoachesTable)
      .where(
        and(
          eq(eligibilityActivityCoachesTable.activityId, id),
          eq(eligibilityActivityCoachesTable.schoolId, schoolId),
        ),
      );
    await db
      .delete(eligibilityActivitiesTable)
      .where(
        and(
          eq(eligibilityActivitiesTable.id, id),
          eq(eligibilityActivitiesTable.schoolId, schoolId),
        ),
      );
    res.json({ ok: true });
  },
);

router.post(
  "/eligibility/activities/:id/coaches",
  requireStaff,
  requireManager,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const activityId = Number(req.params.id);
    if (!(await assertActivityInSchool(activityId, schoolId))) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const staffId = Number(req.body?.staffId);
    if (!Number.isFinite(staffId)) {
      res.status(400).json({ error: "staffId required" });
      return;
    }
    const [coachStaff] = await db
      .select({ id: staffTable.id })
      .from(staffTable)
      .where(and(eq(staffTable.id, staffId), eq(staffTable.schoolId, schoolId)));
    if (!coachStaff) {
      res.status(400).json({ error: "Staff not in this school" });
      return;
    }
    await db
      .insert(eligibilityActivityCoachesTable)
      .values({ schoolId, activityId, staffId })
      .onConflictDoNothing();
    res.status(201).json({ ok: true });
  },
);

router.delete(
  "/eligibility/coaches/:id",
  requireStaff,
  requireManager,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const id = Number(req.params.id);
    await db
      .delete(eligibilityActivityCoachesTable)
      .where(
        and(
          eq(eligibilityActivityCoachesTable.id, id),
          eq(eligibilityActivityCoachesTable.schoolId, schoolId),
        ),
      );
    res.json({ ok: true });
  },
);

// ---- Roster ----------------------------------------------------------------

// Tenancy guard for the `:id` activity routes. The PATCH/DELETE activity
// routes already school-scope via their WHERE clause (so they 404
// cross-school), but the member/coach/roster routes derive a free-floating
// activityId from the path — confirm it belongs to this school before
// reading or writing against it, or a forged activityId could link rows or
// read a roster across tenants.
async function assertActivityInSchool(
  activityId: number,
  schoolId: number,
): Promise<boolean> {
  if (!Number.isFinite(activityId)) return false;
  const [row] = await db
    .select({ id: eligibilityActivitiesTable.id })
    .from(eligibilityActivitiesTable)
    .where(
      and(
        eq(eligibilityActivitiesTable.id, activityId),
        eq(eligibilityActivitiesTable.schoolId, schoolId),
      ),
    );
  return Boolean(row);
}

async function rosterForActivity(
  schoolId: number,
  activityId: number,
  settings: EligibilitySettings,
) {
  const members = await db
    .select()
    .from(eligibilityActivityMembersTable)
    .where(
      and(
        eq(eligibilityActivityMembersTable.schoolId, schoolId),
        eq(eligibilityActivityMembersTable.activityId, activityId),
        eq(eligibilityActivityMembersTable.active, true),
      ),
    );
  const map = await buildEligibilityMap(
    schoolId,
    settings.semesterLabel,
    members.map((m) => m.studentId),
    settings,
  );
  return members
    .map((m) => {
      const e = map.get(m.studentId);
      return {
        memberId: m.id,
        studentId: m.studentId,
        jerseyNumber: m.jerseyNumber,
        localSisId: e?.localSisId ?? null,
        firstName: e?.firstName ?? "",
        lastName: e?.lastName ?? "",
        grade: e?.grade ?? null,
        countedAbsences: e?.countedAbsences ?? 0,
        daysTardy: e?.daysTardy ?? 0,
        notesLeft: e?.notesLeft ?? settings.parentNoteCap,
        status: e?.status ?? "ok",
      };
    })
    .sort((a, b) => b.countedAbsences - a.countedAbsences);
}

router.get(
  "/eligibility/activities/:id/roster",
  requireStaff,
  requireManager,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const activityId = Number(req.params.id);
    if (!(await assertActivityInSchool(activityId, schoolId))) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const settings = await loadEligibilitySettings(schoolId);
    const roster = await rosterForActivity(schoolId, activityId, settings);
    const asOfDate = await latestUploadAsOf(schoolId, settings.semesterLabel);
    res.json({
      settings,
      roster,
      asOf: asOfDate?.toISOString() ?? null,
      asOfLabel: formatAsOf(asOfDate),
    });
  },
);

// ---- Per-activity eligibility export (CSV / PDF) ---------------------------
// "Select a team or club first, then print." Both downloads carry an
// "Attendance Eligibility as of <upload date>" header where the date is the
// latest attendance upload for the current semester.

// Latest attendance upload timestamp for the semester (the "as of" date).
async function latestUploadAsOf(
  schoolId: number,
  semesterLabel: string,
): Promise<Date | null> {
  const [row] = await db
    .select({ createdAt: eligibilityUploadsTable.createdAt })
    .from(eligibilityUploadsTable)
    .where(
      and(
        eq(eligibilityUploadsTable.schoolId, schoolId),
        eq(eligibilityUploadsTable.semesterLabel, semesterLabel),
      ),
    )
    .orderBy(desc(eligibilityUploadsTable.createdAt))
    .limit(1);
  return row?.createdAt ?? null;
}

function formatAsOf(d: Date | null): string {
  if (!d) return "no attendance upload yet";
  // School-local (Eastern) calendar date — the upload's day is what matters.
  return d.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

// CSV formula-injection guard (mirrors routes/reports.ts csvCell).
function csvCell(value: unknown): string {
  let s = value == null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

const EXPORT_STATUS_LABEL: Record<string, string> = {
  ok: "OK",
  warning: "Warning",
  ineligible: "Ineligible",
};

// Fetch the activity row (name/category) after school-scoping. Returns null
// when the activity is missing or belongs to another school.
async function activityInSchool(activityId: number, schoolId: number) {
  if (!Number.isInteger(activityId) || activityId <= 0) return null;
  const [row] = await db
    .select()
    .from(eligibilityActivitiesTable)
    .where(
      and(
        eq(eligibilityActivitiesTable.id, activityId),
        eq(eligibilityActivitiesTable.schoolId, schoolId),
      ),
    );
  return row ?? null;
}

function safeFilePart(s: string): string {
  return s.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "") || "activity";
}

router.get(
  "/eligibility/activities/:id/roster.csv",
  requireStaff,
  requireManager,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const activityId = Number(req.params.id);
    const activity = await activityInSchool(activityId, schoolId);
    if (!activity) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const settings = await loadEligibilitySettings(schoolId);
    const roster = await rosterForActivity(schoolId, activityId, settings);
    const asOf = formatAsOf(await latestUploadAsOf(schoolId, settings.semesterLabel));

    const lines: string[] = [];
    lines.push(csvCell(`Attendance Eligibility as of ${asOf}`));
    lines.push(csvCell(`Activity: ${activity.name}`));
    lines.push(
      csvCell(
        `${settings.semesterLabel} · ineligible at ${settings.threshold}+ counted absences`,
      ),
    );
    lines.push("");
    const header = [
      "Name",
      "Grade",
      "SIS ID",
      "Jersey",
      "Counted Absences",
      "Tardies",
      "Notes Left",
      "Status",
    ];
    lines.push(header.map(csvCell).join(","));
    for (const m of roster) {
      lines.push(
        [
          `${m.lastName}, ${m.firstName}`,
          m.grade ?? "",
          m.localSisId ?? "",
          m.jerseyNumber ?? "",
          m.countedAbsences,
          m.daysTardy,
          m.notesLeft,
          EXPORT_STATUS_LABEL[m.status] ?? m.status,
        ]
          .map(csvCell)
          .join(","),
      );
    }

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="eligibility-${safeFilePart(activity.name)}-${settings.semesterLabel.replace(/\s+/g, "-")}.csv"`,
    );
    res.send(lines.join("\r\n"));
  },
);

router.get(
  "/eligibility/activities/:id/roster.pdf",
  requireStaff,
  requireManager,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const activityId = Number(req.params.id);
    const activity = await activityInSchool(activityId, schoolId);
    if (!activity) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const settings = await loadEligibilitySettings(schoolId);
    const roster = await rosterForActivity(schoolId, activityId, settings);
    const asOf = formatAsOf(await latestUploadAsOf(schoolId, settings.semesterLabel));

    const doc = new PDFDocument({ size: "LETTER", margin: 48 });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="eligibility-${safeFilePart(activity.name)}-${settings.semesterLabel.replace(/\s+/g, "-")}.pdf"`,
    );
    doc.pipe(res);

    doc
      .fontSize(18)
      .fillColor("#111827")
      .text(`Attendance Eligibility as of ${asOf}`);
    doc
      .moveDown(0.2)
      .fontSize(12)
      .fillColor("#374151")
      .text(activity.name);
    doc
      .moveDown(0.1)
      .fontSize(10)
      .fillColor("#6b7280")
      .text(
        `${settings.semesterLabel}  •  Ineligible at ${settings.threshold}+ counted absences  •  Warning within ${settings.warningWindowDays}`,
      );
    doc.moveDown(0.6);

    if (roster.length === 0) {
      doc
        .fontSize(12)
        .fillColor("#111827")
        .text("No students on this roster yet.");
      doc.end();
      return;
    }

    doc
      .fontSize(9)
      .fillColor("#6b7280")
      .text(
        "Name                              Grade  Jersey  Counted Abs  Tardies  Status",
      );
    doc.moveDown(0.1);
    for (const m of roster) {
      const name = `${m.lastName}, ${m.firstName}`.padEnd(32, " ").slice(0, 32);
      const grade = String(m.grade ?? "—").padEnd(5, " ");
      const jersey = (m.jerseyNumber ?? "—").padEnd(6, " ");
      const abs = String(m.countedAbsences).padEnd(11, " ");
      const tard = String(m.daysTardy).padEnd(7, " ");
      doc
        .fontSize(10)
        .fillColor(
          m.status === "ineligible"
            ? "#b91c1c"
            : m.status === "warning"
              ? "#b45309"
              : "#111827",
        )
        .text(
          `${name}  ${grade}  ${jersey}  ${abs}  ${tard}  ${(EXPORT_STATUS_LABEL[m.status] ?? m.status).toUpperCase()}`,
        );
    }
    doc.end();
  },
);

// Add a member by localSisId (preferred) or studentId (FLEID). Jersey optional.
router.post(
  "/eligibility/activities/:id/members",
  requireStaff,
  requireManager,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const activityId = Number(req.params.id);
    if (!(await assertActivityInSchool(activityId, schoolId))) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const { localSisId, studentId, jerseyNumber } = req.body ?? {};
    let resolvedId: string | null = null;
    if (typeof studentId === "string" && studentId) {
      const [s] = await db
        .select({ id: studentsTable.studentId })
        .from(studentsTable)
        .where(
          and(
            eq(studentsTable.schoolId, schoolId),
            eq(studentsTable.studentId, studentId),
          ),
        );
      resolvedId = s?.id ?? null;
    } else if (typeof localSisId === "string" && localSisId) {
      const [s] = await db
        .select({ id: studentsTable.studentId })
        .from(studentsTable)
        .where(
          and(
            eq(studentsTable.schoolId, schoolId),
            eq(studentsTable.localSisId, localSisId),
          ),
        );
      resolvedId = s?.id ?? null;
    }
    if (!resolvedId) {
      res.status(404).json({ error: "Student not found" });
      return;
    }
    await db
      .insert(eligibilityActivityMembersTable)
      .values({
        schoolId,
        activityId,
        studentId: resolvedId,
        jerseyNumber:
          typeof jerseyNumber === "string" && jerseyNumber.trim()
            ? jerseyNumber.trim().slice(0, 8)
            : null,
        addedByStaffId: req.staffId ?? null,
      })
      .onConflictDoNothing();
    res.status(201).json({ ok: true });
  },
);

router.patch(
  "/eligibility/members/:id",
  requireStaff,
  requireManager,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const id = Number(req.params.id);
    const patch: Record<string, unknown> = {};
    if (req.body?.jerseyNumber !== undefined)
      patch.jerseyNumber =
        typeof req.body.jerseyNumber === "string" &&
        req.body.jerseyNumber.trim()
          ? req.body.jerseyNumber.trim().slice(0, 8)
          : null;
    if (req.body?.active !== undefined) patch.active = Boolean(req.body.active);
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }
    const [row] = await db
      .update(eligibilityActivityMembersTable)
      .set(patch)
      .where(
        and(
          eq(eligibilityActivityMembersTable.id, id),
          eq(eligibilityActivityMembersTable.schoolId, schoolId),
        ),
      )
      .returning();
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(row);
  },
);

router.delete(
  "/eligibility/members/:id",
  requireStaff,
  requireManager,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const id = Number(req.params.id);
    await db
      .delete(eligibilityActivityMembersTable)
      .where(
        and(
          eq(eligibilityActivityMembersTable.id, id),
          eq(eligibilityActivityMembersTable.schoolId, schoolId),
        ),
      );
    res.json({ ok: true });
  },
);

// Bulk add members from a parsed roster file. Rows = [{localSisId, jerseyNumber?}].
// Match by localSisId; report unmatched.
router.post(
  "/eligibility/activities/:id/members/bulk",
  requireStaff,
  requireManager,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const activityId = Number(req.params.id);
    if (!(await assertActivityInSchool(activityId, schoolId))) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const rows: { localSisId?: string; jerseyNumber?: string }[] = Array.isArray(
      req.body?.rows,
    )
      ? req.body.rows
      : [];
    if (rows.length === 0) {
      res.status(400).json({ error: "No rows" });
      return;
    }
    const sisIds = rows
      .map((r) => String(r.localSisId ?? "").trim())
      .filter(Boolean);
    const students = await db
      .select({
        studentId: studentsTable.studentId,
        localSisId: studentsTable.localSisId,
      })
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.schoolId, schoolId),
          inArray(studentsTable.localSisId, sisIds),
        ),
      );
    const byLocal = new Map(students.map((s) => [s.localSisId, s.studentId]));
    let matched = 0;
    const unmatched: string[] = [];
    for (const r of rows) {
      const local = String(r.localSisId ?? "").trim();
      const resolved = local ? byLocal.get(local) : undefined;
      if (!resolved) {
        if (local) unmatched.push(local);
        continue;
      }
      await db
        .insert(eligibilityActivityMembersTable)
        .values({
          schoolId,
          activityId,
          studentId: resolved,
          jerseyNumber:
            typeof r.jerseyNumber === "string" && r.jerseyNumber.trim()
              ? r.jerseyNumber.trim().slice(0, 8)
              : null,
          addedByStaffId: req.staffId ?? null,
        })
        .onConflictDoNothing();
      matched += 1;
    }
    res.json({ matched, unmatchedCount: unmatched.length, unmatched });
  },
);

// ---- Attendance upload (REPLACE per student/semester) ----------------------

router.post(
  "/eligibility/attendance/upload",
  requireStaff,
  requireAttendanceImporter,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const settings = await loadEligibilitySettings(schoolId);
    const rows: {
      localSisId?: string;
      absenceTotal?: number | string;
      daysTardy?: number | string;
    }[] = Array.isArray(req.body?.rows) ? req.body.rows : [];
    const filename =
      typeof req.body?.filename === "string" ? req.body.filename : null;
    if (rows.length === 0) {
      res.status(400).json({ error: "No rows" });
      return;
    }

    const sisIds = rows
      .map((r) => String(r.localSisId ?? "").trim())
      .filter(Boolean);
    const students = await db
      .select({
        studentId: studentsTable.studentId,
        localSisId: studentsTable.localSisId,
      })
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.schoolId, schoolId),
          inArray(studentsTable.localSisId, sisIds),
        ),
      );
    const byLocal = new Map(students.map((s) => [s.localSisId, s.studentId]));

    const [upload] = await db
      .insert(eligibilityUploadsTable)
      .values({
        schoolId,
        semesterLabel: settings.semesterLabel,
        uploadedByStaffId: req.staffId!,
        filename,
        rowCount: rows.length,
        matchedCount: 0,
        unmatchedCount: 0,
      })
      .returning();

    let matched = 0;
    const unmatched: string[] = [];
    for (const r of rows) {
      const local = String(r.localSisId ?? "").trim();
      const resolved = local ? byLocal.get(local) : undefined;
      if (!resolved) {
        if (local) unmatched.push(local);
        continue;
      }
      const absenceTotal = Math.max(0, Math.round(Number(r.absenceTotal ?? 0)));
      const daysTardy = Math.max(0, Math.round(Number(r.daysTardy ?? 0)));
      // REPLACE: upsert overwrites the stored totals for this student/sem.
      await db
        .insert(eligibilityAbsencesTable)
        .values({
          schoolId,
          studentId: resolved,
          semesterLabel: settings.semesterLabel,
          absenceTotal: Number.isFinite(absenceTotal) ? absenceTotal : 0,
          daysTardy: Number.isFinite(daysTardy) ? daysTardy : 0,
          lastUploadId: upload.id,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            eligibilityAbsencesTable.schoolId,
            eligibilityAbsencesTable.studentId,
            eligibilityAbsencesTable.semesterLabel,
          ],
          set: {
            absenceTotal: Number.isFinite(absenceTotal) ? absenceTotal : 0,
            daysTardy: Number.isFinite(daysTardy) ? daysTardy : 0,
            lastUploadId: upload.id,
            updatedAt: new Date(),
          },
        });
      matched += 1;
    }

    await db
      .update(eligibilityUploadsTable)
      .set({ matchedCount: matched, unmatchedCount: unmatched.length })
      .where(eq(eligibilityUploadsTable.id, upload.id));

    // Fire notifications for threshold crossings + warning-zone re-notify.
    let notified = 0;
    try {
      notified = await notifyEligibilityUpload(schoolId, upload.id);
    } catch (err) {
      req.log?.error?.({ err }, "Eligibility upload notify failed");
    }

    res.json({
      uploadId: upload.id,
      matched,
      unmatchedCount: unmatched.length,
      unmatched: unmatched.slice(0, 200),
      notified,
    });
  },
);

router.get(
  "/eligibility/uploads",
  requireStaff,
  requireAttendanceImporter,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const uploads = await db
      .select()
      .from(eligibilityUploadsTable)
      .where(eq(eligibilityUploadsTable.schoolId, schoolId))
      .orderBy(desc(eligibilityUploadsTable.createdAt))
      .limit(20);
    res.json(uploads);
  },
);

// ---- Parent notes (cap enforced) -------------------------------------------

router.get(
  "/eligibility/parent-notes",
  requireStaff,
  requireManager,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const studentId = String(req.query.studentId ?? "");
    if (!studentId) {
      res.status(400).json({ error: "studentId required" });
      return;
    }
    const settings = await loadEligibilitySettings(schoolId);
    const notes = await db
      .select()
      .from(eligibilityParentNotesTable)
      .where(
        and(
          eq(eligibilityParentNotesTable.schoolId, schoolId),
          eq(eligibilityParentNotesTable.studentId, studentId),
          eq(eligibilityParentNotesTable.semesterLabel, settings.semesterLabel),
        ),
      )
      .orderBy(desc(eligibilityParentNotesTable.createdAt));
    res.json({
      notes,
      cap: settings.parentNoteCap,
      notesLeft: Math.max(0, settings.parentNoteCap - notes.length),
    });
  },
);

router.post(
  "/eligibility/parent-notes",
  requireStaff,
  requireManager,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const settings = await loadEligibilitySettings(schoolId);
    const studentId = String(req.body?.studentId ?? "");
    if (!studentId) {
      res.status(400).json({ error: "studentId required" });
      return;
    }
    // Confirm the student belongs to this school.
    const [s] = await db
      .select({ id: studentsTable.studentId })
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.schoolId, schoolId),
          eq(studentsTable.studentId, studentId),
        ),
      );
    if (!s) {
      res.status(404).json({ error: "Student not found" });
      return;
    }
    const [{ c }] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(eligibilityParentNotesTable)
      .where(
        and(
          eq(eligibilityParentNotesTable.schoolId, schoolId),
          eq(eligibilityParentNotesTable.studentId, studentId),
          eq(eligibilityParentNotesTable.semesterLabel, settings.semesterLabel),
        ),
      );
    if (c >= settings.parentNoteCap) {
      res.status(409).json({
        error: "cap_reached",
        message: `Parent-note cap of ${settings.parentNoteCap} reached for this semester.`,
      });
      return;
    }
    const [row] = await db
      .insert(eligibilityParentNotesTable)
      .values({
        schoolId,
        studentId,
        semesterLabel: settings.semesterLabel,
        reason:
          typeof req.body?.reason === "string"
            ? req.body.reason.slice(0, 500)
            : null,
        noteDate:
          typeof req.body?.noteDate === "string" && req.body.noteDate
            ? req.body.noteDate
            : null,
        enteredByStaffId: req.staffId!,
      })
      .returning();
    res.status(201).json({
      note: row,
      notesLeft: Math.max(0, settings.parentNoteCap - (c + 1)),
    });
  },
);

router.delete(
  "/eligibility/parent-notes/:id",
  requireStaff,
  requireManager,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const id = Number(req.params.id);
    await db
      .delete(eligibilityParentNotesTable)
      .where(
        and(
          eq(eligibilityParentNotesTable.id, id),
          eq(eligibilityParentNotesTable.schoolId, schoolId),
        ),
      );
    res.json({ ok: true });
  },
);

// ---- At-risk report --------------------------------------------------------

interface AtRiskEntry {
  activityId: number;
  activityName: string;
  studentId: string;
  localSisId: string | null;
  name: string;
  grade: number | null;
  jerseyNumber: string | null;
  daysAbsent: number;
  notesLeft: number;
  status: "warning" | "ineligible";
}

async function buildAtRisk(
  schoolId: number,
  settings: EligibilitySettings,
): Promise<AtRiskEntry[]> {
  const members = await loadActiveMembers(schoolId);
  const map = await buildEligibilityMap(
    schoolId,
    settings.semesterLabel,
    members.map((m) => m.studentId),
    settings,
  );
  const out: AtRiskEntry[] = [];
  for (const m of members) {
    const e = map.get(m.studentId);
    if (!e) continue;
    if (e.status === "ok") continue;
    out.push({
      activityId: m.activityId,
      activityName: m.activityName,
      studentId: m.studentId,
      localSisId: e.localSisId,
      name: `${e.firstName} ${e.lastName}`.trim(),
      grade: e.grade,
      jerseyNumber: m.jerseyNumber,
      daysAbsent: e.countedAbsences,
      notesLeft: e.notesLeft,
      status: e.status,
    });
  }
  out.sort(
    (a, b) =>
      a.activityName.localeCompare(b.activityName) ||
      b.daysAbsent - a.daysAbsent,
  );
  return out;
}

router.get(
  "/eligibility/at-risk",
  requireStaff,
  requireManager,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const settings = await loadEligibilitySettings(schoolId);
    const entries = await buildAtRisk(schoolId, settings);
    res.json({ settings, entries });
  },
);

router.get(
  "/eligibility/at-risk.pdf",
  requireStaff,
  requireManager,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const settings = await loadEligibilitySettings(schoolId);
    const entries = await buildAtRisk(schoolId, settings);

    const doc = new PDFDocument({ size: "LETTER", margin: 48 });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="at-risk-eligibility-${settings.semesterLabel.replace(/\s+/g, "-")}.pdf"`,
    );
    doc.pipe(res);

    doc
      .fontSize(18)
      .fillColor("#111827")
      .text("Eligibility — At-Risk Report", { continued: false });
    doc
      .moveDown(0.2)
      .fontSize(10)
      .fillColor("#6b7280")
      .text(
        `${settings.semesterLabel}  •  Ineligible at ${settings.threshold}+ counted absences  •  Warning within ${settings.warningWindowDays}`,
      );
    doc.moveDown(0.6);

    if (entries.length === 0) {
      doc
        .fontSize(12)
        .fillColor("#111827")
        .text("No students are currently in the warning or ineligible zone.");
      doc.end();
      return;
    }

    let currentActivity = "";
    for (const e of entries) {
      if (e.activityName !== currentActivity) {
        currentActivity = e.activityName;
        doc.moveDown(0.5);
        doc
          .fontSize(13)
          .fillColor("#1d4ed8")
          .text(currentActivity);
        doc
          .fontSize(9)
          .fillColor("#6b7280")
          .text("Name                              Grade   Jersey   Days Absent   Status");
        doc.moveDown(0.1);
      }
      const name = e.name.padEnd(32, " ").slice(0, 32);
      const grade = String(e.grade ?? "—").padEnd(6, " ");
      const jersey = (e.jerseyNumber ?? "—").padEnd(7, " ");
      const days = String(e.daysAbsent).padEnd(12, " ");
      doc
        .fontSize(10)
        .fillColor(e.status === "ineligible" ? "#b91c1c" : "#b45309")
        .text(
          `${name}  ${grade}  ${jersey}  ${days}  ${e.status.toUpperCase()}`,
        );
    }
    doc.end();
  },
);

// ---- Coach read-only view --------------------------------------------------

router.get(
  "/eligibility/coach/activities",
  requireStaff,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const staffId = req.staffId!;
    const coached = await db
      .select({ activityId: eligibilityActivityCoachesTable.activityId })
      .from(eligibilityActivityCoachesTable)
      .where(
        and(
          eq(eligibilityActivityCoachesTable.schoolId, schoolId),
          eq(eligibilityActivityCoachesTable.staffId, staffId),
        ),
      );
    const ids = coached.map((c) => c.activityId);
    if (ids.length === 0) {
      res.json({ settings: await loadEligibilitySettings(schoolId), activities: [] });
      return;
    }
    const settings = await loadEligibilitySettings(schoolId);
    const activities = await db
      .select()
      .from(eligibilityActivitiesTable)
      .where(
        and(
          eq(eligibilityActivitiesTable.schoolId, schoolId),
          inArray(eligibilityActivitiesTable.id, ids),
        ),
      );
    const result = [];
    for (const a of activities) {
      const roster = await rosterForActivity(schoolId, a.id, settings);
      result.push({ activity: a, roster });
    }
    res.json({ settings, activities: result });
  },
);

export const eligibilityRouter: IRouter = router;
export default router;
