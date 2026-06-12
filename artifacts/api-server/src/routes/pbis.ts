import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  pbisEntriesTable,
  pbisReasonsTable,
  staffTable,
  studentsTable,
  classSectionsTable,
  recordEditsTable,
  schoolSettingsTable,
  bellSchedulesTable,
  bellSchedulePeriodsTable,
  studentMtssPlansTable,
} from "@workspace/db";
import { eq, and, isNull, gte, lt, inArray } from "drizzle-orm";
import {
  processMilestonesForStudent,
  processMilestonesForStudents,
} from "../lib/pbisMilestones";
import { requireSchool } from "../lib/scope.js";

const router: IRouter = Router();

type StaffRow = typeof staffTable.$inferSelect;

async function loadSessionStaff(req: Request): Promise<StaffRow | null> {
  const id = req.staffId;
  if (!id) return null;
  const [s] = await db.select().from(staffTable).where(eq(staffTable.id, id));
  return s && s.active ? s : null;
}

function canManageEntry(
  staff: StaffRow,
  entry: typeof pbisEntriesTable.$inferSelect,
): boolean {
  if (staff.isSuperUser || staff.isAdmin || staff.isPbisCoordinator) return true;
  return entry.staffId !== null && entry.staffId === staff.id;
}

async function logEdit(
  entryId: number,
  field: string,
  oldVal: string | null,
  newVal: string | null,
  staff: StaffRow,
  schoolId: number,
) {
  await db.insert(recordEditsTable).values({
    schoolId,
    recordType: "pbis_entry",
    recordId: String(entryId),
    fieldName: field,
    oldValue: oldVal,
    newValue: newVal,
    editedBy: staff.displayName,
    editedAt: new Date().toISOString(),
  });
}

router.get("/pbis", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const rows = await db
    .select()
    .from(pbisEntriesTable)
    .where(eq(pbisEntriesTable.schoolId, schoolId));
  const stu = await db
    .select({
      studentId: studentsTable.studentId,
      localSisId: studentsTable.localSisId,
    })
    .from(studentsTable)
    .where(eq(studentsTable.schoolId, schoolId));
  const localBySid = new Map<string, string | null>();
  for (const s of stu) localBySid.set(s.studentId, s.localSisId);
  res.json(
    rows.map((r) => ({
      ...r,
      localSisId: localBySid.get(r.studentId) ?? null,
    })),
  );
});

// Leaderboard for a bounded period. Excludes voided entries.
// Query: ?period=week|month|quarter|all (default week), ?limit=10
// Returns: { period, from, until, students: [{studentId, total, count}], staff: [{staffId, staffName, total, count}] }
router.get("/pbis/leaderboard", async (req: Request, res: Response) => {
  const staff = await loadSessionStaff(req);
  if (!staff) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const period = String(req.query.period ?? "week");
  const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 10)));

  const now = new Date();
  let from: Date | null = null;
  if (period === "week") {
    const d = new Date(now);
    const day = d.getDay(); // 0=Sun
    const diff = (day + 6) % 7; // days since Monday
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - diff);
    from = d;
  } else if (period === "month") {
    from = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  } else if (period === "quarter") {
    const qStartMonth = Math.floor(now.getMonth() / 3) * 3;
    from = new Date(now.getFullYear(), qStartMonth, 1, 0, 0, 0, 0);
  } else if (period !== "all") {
    res.status(400).json({ error: "Invalid period" });
    return;
  }

  const all = await db
    .select()
    .from(pbisEntriesTable)
    .where(eq(pbisEntriesTable.schoolId, req.schoolId!));
  const fromIso = from ? from.toISOString() : null;
  const filtered = all.filter((e) => {
    if (e.voidedAt) return false;
    if (fromIso && e.createdAt < fromIso) return false;
    return true;
  });

  const studentTotals = new Map<string, { total: number; count: number }>();
  const staffTotals = new Map<
    number,
    { staffName: string; total: number; count: number }
  >();
  for (const e of filtered) {
    const s = studentTotals.get(e.studentId) ?? { total: 0, count: 0 };
    s.total += e.points;
    s.count += 1;
    studentTotals.set(e.studentId, s);
    if (e.staffId !== null) {
      const t = staffTotals.get(e.staffId) ?? {
        staffName: e.staffName,
        total: 0,
        count: 0,
      };
      t.total += e.points;
      t.count += 1;
      t.staffName = e.staffName || t.staffName;
      staffTotals.set(e.staffId, t);
    }
  }

  const leaderStu = await db
    .select({
      studentId: studentsTable.studentId,
      localSisId: studentsTable.localSisId,
    })
    .from(studentsTable)
    .where(eq(studentsTable.schoolId, req.schoolId!));
  const leaderLocalBySid = new Map<string, string | null>();
  for (const s of leaderStu) leaderLocalBySid.set(s.studentId, s.localSisId);

  const students = Array.from(studentTotals.entries())
    .map(([studentId, v]) => ({
      studentId,
      localSisId: leaderLocalBySid.get(studentId) ?? null,
      total: v.total,
      count: v.count,
    }))
    .sort((a, b) => b.total - a.total || a.studentId.localeCompare(b.studentId))
    .slice(0, limit);
  const staffBoard = Array.from(staffTotals.entries())
    .map(([staffId, v]) => ({
      staffId,
      staffName: v.staffName,
      total: v.total,
      count: v.count,
    }))
    .sort((a, b) => b.total - a.total || a.staffName.localeCompare(b.staffName))
    .slice(0, limit);

  res.json({
    period,
    from: fromIso,
    until: now.toISOString(),
    students,
    staff: staffBoard,
  });
});

router.post("/pbis", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const { studentId, reason, reasonId, points, staffName, note } =
    req.body ?? {};
  const sessionStaffId = req.staffId;
  let resolvedStaffId: number | null = null;
  let resolvedStaffName =
    typeof staffName === "string" ? staffName : "";
  if (sessionStaffId) {
    const [s] = await db
      .select()
      .from(staffTable)
      .where(eq(staffTable.id, sessionStaffId));
    if (s && s.active) {
      resolvedStaffId = s.id;
      resolvedStaffName = s.displayName;
    }
  }

  if (typeof studentId !== "string" || !studentId) {
    res.status(400).json({ error: "studentId is required" });
    return;
  }
  if (typeof reason !== "string" || !reason) {
    res.status(400).json({ error: "reason is required" });
    return;
  }
  // Cross-school protection: confirm the student exists in THIS school before
  // we accept the entry — otherwise an attacker could file an entry against a
  // student id from another school under their school's tenant.
  const [studentRow] = await db
    .select({ id: studentsTable.id })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.studentId, studentId),
        eq(studentsTable.schoolId, schoolId),
      ),
    );
  if (!studentRow) {
    res.status(404).json({ error: "Student not found in this school" });
    return;
  }
  const pts = Number(points);
  if (!Number.isFinite(pts)) {
    res.status(400).json({ error: "points must be a number" });
    return;
  }

  // Resolve polarity for this entry from the configured rubric (server is
  // authoritative — clients cannot mark an entry "positive" when the rubric
  // says it's negative). Now that names can collide across owner scopes
  // (school's "Participation" vs a teacher's "Participation"), prefer the
  // client-supplied reasonId. Fall back to name+school for backwards compat,
  // then to the sign of `points` for ad-hoc reasons.
  let polarity: "positive" | "negative" = "positive";
  let matched: typeof pbisReasonsTable.$inferSelect | undefined;
  if (reasonId !== undefined && reasonId !== null) {
    const idNum = Number(reasonId);
    if (Number.isInteger(idNum) && idNum > 0) {
      const [byId] = await db
        .select()
        .from(pbisReasonsTable)
        .where(
          and(
            eq(pbisReasonsTable.id, idNum),
            eq(pbisReasonsTable.schoolId, schoolId),
          ),
        );
      matched = byId;
    }
  }
  if (!matched) {
    const [byName] = await db
      .select()
      .from(pbisReasonsTable)
      .where(
        and(
          eq(pbisReasonsTable.schoolId, schoolId),
          eq(pbisReasonsTable.name, reason),
        ),
      );
    matched = byName;
  }
  if (matched) {
    polarity = matched.polarity === "negative" ? "negative" : "positive";
  } else if (pts < 0) {
    polarity = "negative";
  }

  let storedPoints = pts;
  if (polarity === "negative") {
    const [settingsRow] = await db
      .select()
      .from(schoolSettingsTable)
      .where(eq(schoolSettingsTable.schoolId, schoolId));
    const subtract = settingsRow?.pbisNegativeAffectsTotal ?? false;
    const magnitude = Math.abs(pts);
    storedPoints = subtract ? -magnitude : 0;
  } else {
    storedPoints = Math.abs(pts);
  }

  // Optional teacher note (trim, cap to 500 chars to keep rows reasonable).
  let cleanNote: string | null = null;
  if (typeof note === "string") {
    const t = note.trim();
    if (t) cleanNote = t.slice(0, 500);
  }

  const [entry] = await db
    .insert(pbisEntriesTable)
    .values({
      schoolId,
      studentId,
      reason,
      points: storedPoints,
      polarity,
      staffId: resolvedStaffId,
      staffName: resolvedStaffName,
      createdAt: new Date().toISOString(),
      note: cleanNote,
    })
    .returning();

  const milestoneResults = await processMilestonesForStudent(
    studentId,
    schoolId,
  );
  res.status(201).json({ ...entry, milestoneResults });
});

// Bulk award the same reason+points to many students at once.
// Body: { studentIds: string[], reason: string, points: number }
// Cap: 200 distinct ids per call. Per-row errors are returned, not thrown.
router.post("/pbis/bulk", async (req: Request, res: Response) => {
  const staff = await loadSessionStaff(req);
  if (!staff) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const { studentIds, reason, reasonId, points, note } = req.body ?? {};
  if (!Array.isArray(studentIds) || studentIds.length === 0) {
    res
      .status(400)
      .json({ error: "studentIds (non-empty array) is required" });
    return;
  }
  if (typeof reason !== "string" || !reason.trim()) {
    res.status(400).json({ error: "reason is required" });
    return;
  }
  const pts = Number(points);
  if (!Number.isFinite(pts)) {
    res.status(400).json({ error: "points must be a number" });
    return;
  }
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const raw of studentIds) {
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (ids.length === 0) {
    res.status(400).json({ error: "No valid studentIds provided" });
    return;
  }
  if (ids.length > 200) {
    res
      .status(400)
      .json({ error: "Bulk awards are capped at 200 students per call" });
    return;
  }

  // Cross-school protection: every id must exist in THIS school's roster.
  // Reject the whole batch on any stranger so we never silently file entries
  // against another school's students.
  const owned = await db
    .select({ studentId: studentsTable.studentId })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.schoolId, req.schoolId!),
        inArray(studentsTable.studentId, ids),
      ),
    );
  if (owned.length !== ids.length) {
    res
      .status(403)
      .json({ error: "Some students are not in your school" });
    return;
  }

  // Resolve polarity ONCE (every student in this bulk gets the same reason),
  // then apply the school's negative-affects-total policy. This mirrors the
  // single-award endpoint so a bulk "Disruption" can't slip past the school's
  // log-only policy.
  const trimmedReason = reason.trim();
  // Prefer client-supplied reasonId so we pick the right row when school and
  // teacher rubrics share a name (e.g. both have "Participation"). Fall back
  // to name+school for old clients, then to sign of points.
  let matched: typeof pbisReasonsTable.$inferSelect | undefined;
  if (reasonId !== undefined && reasonId !== null) {
    const idNum = Number(reasonId);
    if (Number.isInteger(idNum) && idNum > 0) {
      const [byId] = await db
        .select()
        .from(pbisReasonsTable)
        .where(
          and(
            eq(pbisReasonsTable.id, idNum),
            eq(pbisReasonsTable.schoolId, req.schoolId!),
          ),
        );
      matched = byId;
    }
  }
  if (!matched) {
    const [byName] = await db
      .select()
      .from(pbisReasonsTable)
      .where(
        and(
          eq(pbisReasonsTable.schoolId, req.schoolId!),
          eq(pbisReasonsTable.name, trimmedReason),
        ),
      );
    matched = byName;
  }
  let polarity: "positive" | "negative" = "positive";
  if (matched) {
    polarity = matched.polarity === "negative" ? "negative" : "positive";
  } else if (pts < 0) {
    polarity = "negative";
  }
  let storedPoints = pts;
  if (polarity === "negative") {
    const [settingsRow] = await db
      .select()
      .from(schoolSettingsTable)
      .where(eq(schoolSettingsTable.schoolId, req.schoolId!));
    const subtract = settingsRow?.pbisNegativeAffectsTotal ?? false;
    const magnitude = Math.abs(pts);
    storedPoints = subtract ? -magnitude : 0;
  } else {
    storedPoints = Math.abs(pts);
  }

  // Optional shared note attached to every entry in this bulk.
  let cleanNote: string | null = null;
  if (typeof note === "string") {
    const t = note.trim();
    if (t) cleanNote = t.slice(0, 500);
  }

  const nowIso = new Date().toISOString();
  const created: Array<typeof pbisEntriesTable.$inferSelect> = [];
  const errors: Array<{ studentId: string; error: string }> = [];
  for (const id of ids) {
    try {
      const [row] = await db
        .insert(pbisEntriesTable)
        .values({
          schoolId: req.schoolId!,
          studentId: id,
          reason: trimmedReason,
          points: storedPoints,
          polarity,
          staffId: staff.id,
          staffName: staff.displayName,
          createdAt: nowIso,
          note: cleanNote,
        })
        .returning();
      created.push(row);
    } catch (e) {
      errors.push({
        studentId: id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  // Decouple bulk milestone email processing from the response. Up to ~200
  // students with one Resend send each can take a long time; let the request
  // return immediately and run the processing in the background. Results land
  // in pbis_milestone_emails (visible in PBIS Lists -> Milestone Parent Emails).
  const idsToProcess = created.map((c) => c.studentId);
  void processMilestonesForStudents(idsToProcess, req.schoolId!).catch((err) => {
    console.error("[bulk milestones] background failure", err);
  });
  res.status(201).json({
    createdCount: created.length,
    errors,
    entries: created,
    milestoneProcessing: "queued",
  });
});

// Edit an existing PBIS entry. Owner OR admin/PBIS coord. No edits to voided rows.
router.patch("/pbis/:id", async (req: Request, res: Response) => {
  const staff = await loadSessionStaff(req);
  if (!staff) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  // D5: load by (id, school) so an admin in school A can't edit a row
  // belonging to school B even if they know the id.
  const [entry] = await db
    .select()
    .from(pbisEntriesTable)
    .where(
      and(
        eq(pbisEntriesTable.id, id),
        eq(pbisEntriesTable.schoolId, req.schoolId!),
      ),
    );
  if (!entry) {
    res.status(404).json({ error: "Entry not found" });
    return;
  }
  if (entry.voidedAt) {
    res.status(400).json({ error: "Voided entries cannot be edited" });
    return;
  }
  if (!canManageEntry(staff, entry)) {
    res.status(403).json({ error: "Not your entry" });
    return;
  }

  const updates: { reason?: string; points?: number } = {};
  const { reason, points } = req.body ?? {};
  if (reason !== undefined) {
    if (typeof reason !== "string" || !reason.trim()) {
      res.status(400).json({ error: "reason must be a non-empty string" });
      return;
    }
    updates.reason = reason.trim();
  }
  if (points !== undefined) {
    const pts = Number(points);
    if (!Number.isFinite(pts)) {
      res.status(400).json({ error: "points must be a number" });
      return;
    }
    updates.points = pts;
  }
  if (!Object.keys(updates).length) {
    res.status(400).json({ error: "Nothing to update" });
    return;
  }

  const [updated] = await db
    .update(pbisEntriesTable)
    .set(updates)
    .where(
      and(
        eq(pbisEntriesTable.id, id),
        eq(pbisEntriesTable.schoolId, req.schoolId!),
      ),
    )
    .returning();

  if (updates.reason !== undefined && updates.reason !== entry.reason) {
    await logEdit(id, "reason", entry.reason, updates.reason, staff, schoolId);
  }
  if (updates.points !== undefined && updates.points !== entry.points) {
    await logEdit(
      id,
      "points",
      String(entry.points),
      String(updates.points),
      staff,
      schoolId,
    );
  }

  res.json(updated);
});

// Void a PBIS entry (soft-delete). Owner OR admin/PBIS coord. Idempotent-ish:
// re-voiding returns 400.
router.post("/pbis/:id/void", async (req: Request, res: Response) => {
  const staff = await loadSessionStaff(req);
  if (!staff) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  // D5: load by (id, school) so a coordinator in school A can't void a
  // row belonging to school B by id.
  const [entry] = await db
    .select()
    .from(pbisEntriesTable)
    .where(
      and(
        eq(pbisEntriesTable.id, id),
        eq(pbisEntriesTable.schoolId, req.schoolId!),
      ),
    );
  if (!entry) {
    res.status(404).json({ error: "Entry not found" });
    return;
  }
  if (entry.voidedAt) {
    res.status(400).json({ error: "Already voided" });
    return;
  }
  if (!canManageEntry(staff, entry)) {
    res.status(403).json({ error: "Not your entry" });
    return;
  }
  const { reason } = req.body ?? {};
  const reasonText = typeof reason === "string" ? reason.trim() : "";
  if (!reasonText) {
    res.status(400).json({ error: "Void reason is required" });
    return;
  }
  const nowIso = new Date().toISOString();
  const [updated] = await db
    .update(pbisEntriesTable)
    .set({
      voidedAt: nowIso,
      voidedById: staff.id,
      voidedByName: staff.displayName,
      voidReason: reasonText,
    })
    .where(
      and(
        eq(pbisEntriesTable.id, id),
        eq(pbisEntriesTable.schoolId, req.schoolId!),
      ),
    )
    .returning();
  await logEdit(id, "voided", null, reasonText, staff, req.schoolId!);
  res.json(updated);
});

// Aggregate KPIs for the PBIS Hub home panel.
// Returns 8 weeks of school-week buckets (Mon-Fri, no weekends) with
// pointsAwarded, distinct studentsRecognized, distinct teachersActive,
// and avgPointsPerStudent (over the full student body). Voided entries
// are excluded everywhere.
router.get("/pbis/home-stats", async (req: Request, res: Response) => {
  const staff = await loadSessionStaff(req);
  if (!staff) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const allowed =
    staff.isSuperUser ||
    staff.isAdmin ||
    staff.isPbisCoordinator ||
    staff.isBehaviorSpecialist ||
    staff.isMtssCoordinator ||
    staff.isDean;
  if (!allowed) {
    res.status(403).json({ error: "Not authorized" });
    return;
  }

  const WEEKS = 8;

  // Compute the Monday (00:00 local) of the current week.
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 1=Mon
  const daysSinceMonday = (day + 6) % 7;
  const thisMonday = new Date(now);
  thisMonday.setHours(0, 0, 0, 0);
  thisMonday.setDate(thisMonday.getDate() - daysSinceMonday);

  // Window: WEEKS weeks back, ending Friday end-of-day this week.
  const windowStart = new Date(thisMonday);
  windowStart.setDate(windowStart.getDate() - 7 * (WEEKS - 1));
  const windowEnd = new Date(thisMonday);
  windowEnd.setDate(windowEnd.getDate() + 5); // Saturday 00:00 = end of Fri

  // Pull all non-voided entries in the window.
  const entries = await db
    .select({
      studentId: pbisEntriesTable.studentId,
      points: pbisEntriesTable.points,
      staffId: pbisEntriesTable.staffId,
      createdAt: pbisEntriesTable.createdAt,
    })
    .from(pbisEntriesTable)
    .where(
      and(
        eq(pbisEntriesTable.schoolId, req.schoolId!),
        isNull(pbisEntriesTable.voidedAt),
        gte(pbisEntriesTable.createdAt, windowStart.toISOString()),
        lt(pbisEntriesTable.createdAt, windowEnd.toISOString()),
      ),
    );

  // Bucket by week index 0..WEEKS-1 (0 = oldest, WEEKS-1 = current).
  type Bucket = {
    weekStart: string;
    weekEnd: string;
    points: number;
    studentIds: Set<string>;
    staffIds: Set<number>;
  };
  const buckets: Bucket[] = [];
  for (let i = 0; i < WEEKS; i++) {
    const wStart = new Date(windowStart);
    wStart.setDate(wStart.getDate() + 7 * i);
    const wEnd = new Date(wStart);
    wEnd.setDate(wEnd.getDate() + 5); // Sat 00:00
    buckets.push({
      weekStart: wStart.toISOString().slice(0, 10),
      weekEnd: new Date(wEnd.getTime() - 1).toISOString().slice(0, 10),
      points: 0,
      studentIds: new Set<string>(),
      staffIds: new Set<number>(),
    });
  }

  for (const e of entries) {
    const created = new Date(e.createdAt);
    const dow = created.getDay(); // 0=Sun..6=Sat
    if (dow === 0 || dow === 6) continue; // Mon-Fri only
    const idx = Math.floor(
      (created.getTime() - windowStart.getTime()) / (7 * 24 * 60 * 60 * 1000),
    );
    if (idx < 0 || idx >= WEEKS) continue;
    const b = buckets[idx];
    if (!b) continue;
    b.points += e.points || 0;
    b.studentIds.add(e.studentId);
    if (e.staffId != null) b.staffIds.add(e.staffId);
  }

  // Denominators: total students; total active staff who teach a real
  // (non-planning) class section. All scoped to the active school.
  const allStudents = await db
    .select({ id: studentsTable.id })
    .from(studentsTable)
    .where(eq(studentsTable.schoolId, req.schoolId!));
  const totalStudents = allStudents.length;

  // class_sections has not yet been migrated to school_id (scheduled for D4).
  // For now we constrain via the joined staff row's school_id so a different
  // school's sections can't slip into this denominator.
  const teachingRows = await db
    .select({
      staffId: classSectionsTable.teacherStaffId,
      isPlanning: classSectionsTable.isPlanning,
      active: staffTable.active,
      staffSchoolId: staffTable.schoolId,
    })
    .from(classSectionsTable)
    .innerJoin(staffTable, eq(staffTable.id, classSectionsTable.teacherStaffId));
  const teachingStaffSet = new Set<number>();
  for (const r of teachingRows) {
    if (!r.isPlanning && r.active && r.staffSchoolId === req.schoolId!) {
      teachingStaffSet.add(r.staffId);
    }
  }
  const totalTeachingStaff = teachingStaffSet.size;

  const weeks = buckets.map((b) => ({
    weekStart: b.weekStart,
    weekEnd: b.weekEnd,
    pointsAwarded: b.points,
    studentsRecognized: b.studentIds.size,
    teachersActive: b.staffIds.size,
    avgPointsPerStudent:
      totalStudents > 0 ? +(b.points / totalStudents).toFixed(2) : 0,
  }));

  const thisWeek = weeks[weeks.length - 1] ?? null;
  const lastWeek = weeks[weeks.length - 2] ?? null;

  res.json({
    weeks,
    totalStudents,
    totalTeachingStaff,
    thisWeek,
    lastWeek,
  });
});

// "Needs Attention" alerts for the PBIS Hub home panel.
// Reads tunable thresholds from school_settings and surfaces 5 alert types.
// Voided entries are excluded everywhere.
router.get("/pbis/needs-attention", async (req: Request, res: Response) => {
  const staff = await loadSessionStaff(req);
  if (!staff) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const allowed =
    staff.isSuperUser ||
    staff.isAdmin ||
    staff.isPbisCoordinator ||
    staff.isBehaviorSpecialist ||
    staff.isMtssCoordinator ||
    staff.isDean;
  if (!allowed) {
    res.status(403).json({ error: "Not authorized" });
    return;
  }

  // Load per-school tunable thresholds (with safe defaults). This is the
  // D4 acceptance criterion: changing pbisQuietTeacherDays in one school
  // must not affect another.
  const [settingsRow] = await db
    .select()
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, req.schoolId!));
  const QUIET_DAYS = settingsRow?.pbisQuietTeacherDays ?? 5;
  // Tier-aware "Invisible Student" windows. Tier 1 = no active MTSS plan.
  const INVISIBLE_DAYS_TIER1 = settingsRow?.pbisInvisibleDaysTier1 ?? 8;
  const INVISIBLE_DAYS_TIER2 = settingsRow?.pbisInvisibleDaysTier2 ?? 5;
  const INVISIBLE_DAYS_TIER3 = settingsRow?.pbisInvisibleDaysTier3 ?? 3;
  const IMBALANCE_PCT = settingsRow?.pbisReasonImbalancePct ?? 60;
  const COLD_MULTIPLE = settingsRow?.pbisColdPeriodMultiple ?? 5;

  // ---------- Date helpers (Mon–Fri only school days) ----------
  const now = new Date();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  // Subtract N school days (skipping Sat/Sun) and return that midnight.
  const subtractSchoolDays = (n: number): Date => {
    const d = new Date(today);
    let remaining = n;
    while (remaining > 0) {
      d.setDate(d.getDate() - 1);
      const dow = d.getDay();
      if (dow !== 0 && dow !== 6) remaining--;
    }
    return d;
  };

  // Monday of current school week.
  const day = now.getDay();
  const daysSinceMonday = (day + 6) % 7;
  const thisMonday = new Date(today);
  thisMonday.setDate(thisMonday.getDate() - daysSinceMonday);
  const nextMonday = new Date(thisMonday);
  nextMonday.setDate(nextMonday.getDate() + 7);

  // Start of current month.
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

  // ---------- Reference data ----------
  const allStaff = await db
    .select({
      id: staffTable.id,
      displayName: staffTable.displayName,
      active: staffTable.active,
    })
    .from(staffTable)
    .where(eq(staffTable.schoolId, req.schoolId!));

  const teachingRows = await db
    .select({
      staffId: classSectionsTable.teacherStaffId,
      isPlanning: classSectionsTable.isPlanning,
    })
    .from(classSectionsTable);
  const teachingStaffIds = new Set<number>();
  for (const r of teachingRows) {
    if (!r.isPlanning) teachingStaffIds.add(r.staffId);
  }
  const teachingStaff = allStaff.filter(
    (s) => s.active && teachingStaffIds.has(s.id),
  );
  const allStudents = await db
    .select({
      id: studentsTable.id,
      studentId: studentsTable.studentId,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
    })
    .from(studentsTable)
    .where(eq(studentsTable.schoolId, req.schoolId!));
  const studentNameById = new Map<string, string>(
    allStudents.map((s) => [
      s.studentId,
      `${s.lastName ?? ""}, ${s.firstName ?? ""}`.trim(),
    ]),
  );

  // ---------- 1. Quiet teachers ----------
  // Teachers with no non-voided entries in the last QUIET_DAYS school days.
  const quietWindow = subtractSchoolDays(QUIET_DAYS);
  const recentTeacherEntries = await db
    .select({ staffId: pbisEntriesTable.staffId })
    .from(pbisEntriesTable)
    .where(
      and(
        eq(pbisEntriesTable.schoolId, req.schoolId!),
        isNull(pbisEntriesTable.voidedAt),
        gte(pbisEntriesTable.createdAt, quietWindow.toISOString()),
      ),
    );
  const activeStaffIds = new Set<number>();
  for (const r of recentTeacherEntries) {
    if (r.staffId != null) activeStaffIds.add(r.staffId);
  }
  const quietTeachers = teachingStaff.filter((s) => !activeStaffIds.has(s.id));
  const quietTeacherSample = quietTeachers
    .slice(0, 3)
    .map((s) => s.displayName);

  // ---------- 2. Invisible students (tier-aware) ----------
  // A student is "invisible" when they have 0 non-voided PBIS entries
  // within the window for their highest active MTSS tier. Tier 1 (no open
  // plan) uses the widest window; Tier 3 the tightest, so the highest-need
  // students surface fastest. Fetch recognitions once since the WIDEST of
  // the three windows, then compare each student's most-recent recognition
  // against their own tier window.
  const widestInvisibleDays = Math.max(
    INVISIBLE_DAYS_TIER1,
    INVISIBLE_DAYS_TIER2,
    INVISIBLE_DAYS_TIER3,
  );
  const widestInvisibleWindow = subtractSchoolDays(widestInvisibleDays);

  // Highest active MTSS tier per student (most intensive open plan). A plan
  // is "active" when it has no closedAt — mirrors the Teacher Roster query.
  const invisibleTierRows = await db
    .select({
      studentId: studentMtssPlansTable.studentId,
      tier: studentMtssPlansTable.tier,
    })
    .from(studentMtssPlansTable)
    .where(
      and(
        eq(studentMtssPlansTable.schoolId, req.schoolId!),
        isNull(studentMtssPlansTable.closedAt),
      ),
    );
  const invisibleTierByStudent = new Map<string, number>();
  for (const r of invisibleTierRows) {
    const cur = invisibleTierByStudent.get(r.studentId) ?? 0;
    if (r.tier > cur) invisibleTierByStudent.set(r.studentId, r.tier);
  }

  const recentStudentEntries = await db
    .select({
      studentId: pbisEntriesTable.studentId,
      createdAt: pbisEntriesTable.createdAt,
    })
    .from(pbisEntriesTable)
    .where(
      and(
        eq(pbisEntriesTable.schoolId, req.schoolId!),
        isNull(pbisEntriesTable.voidedAt),
        gte(pbisEntriesTable.createdAt, widestInvisibleWindow.toISOString()),
      ),
    );
  // Most-recent recognition timestamp per student (ms since epoch).
  const lastSeenByStudent = new Map<string, number>();
  for (const r of recentStudentEntries) {
    const t = new Date(r.createdAt).getTime();
    const cur = lastSeenByStudent.get(r.studentId) ?? 0;
    if (t > cur) lastSeenByStudent.set(r.studentId, t);
  }
  // Pre-compute each tier's window cutoff once (tier 1/2/3).
  const tierWindowCutoff = new Map<number, number>([
    [1, subtractSchoolDays(INVISIBLE_DAYS_TIER1).getTime()],
    [2, subtractSchoolDays(INVISIBLE_DAYS_TIER2).getTime()],
    [3, subtractSchoolDays(INVISIBLE_DAYS_TIER3).getTime()],
  ]);
  const invisibleStudents = allStudents.filter((s) => {
    const tier = invisibleTierByStudent.get(s.studentId) ?? 1;
    const cutoff =
      tierWindowCutoff.get(tier >= 3 ? 3 : tier === 2 ? 2 : 1) ?? 0;
    const lastSeen = lastSeenByStudent.get(s.studentId);
    return lastSeen === undefined || lastSeen < cutoff;
  });
  const invisibleStudentSample = invisibleStudents
    .slice(0, 3)
    .map((s) => studentNameById.get(s.studentId) ?? "—");

  // ---------- This-week entries (drives alerts 3–5) ----------
  const weekEntries = await db
    .select({
      reason: pbisEntriesTable.reason,
      points: pbisEntriesTable.points,
      studentId: pbisEntriesTable.studentId,
      createdAt: pbisEntriesTable.createdAt,
    })
    .from(pbisEntriesTable)
    .where(
      and(
        eq(pbisEntriesTable.schoolId, req.schoolId!),
        isNull(pbisEntriesTable.voidedAt),
        gte(pbisEntriesTable.createdAt, thisMonday.toISOString()),
        lt(pbisEntriesTable.createdAt, nextMonday.toISOString()),
      ),
    );

  // ---------- 3. Reason imbalance ----------
  let reasonImbalance:
    | { topReason: string; percent: number; weekTotal: number }
    | null = null;
  {
    const reasonTotals = new Map<string, number>();
    let weekTotal = 0;
    for (const e of weekEntries) {
      const dow = new Date(e.createdAt).getDay();
      if (dow === 0 || dow === 6) continue;
      const p = e.points || 0;
      weekTotal += p;
      reasonTotals.set(e.reason, (reasonTotals.get(e.reason) ?? 0) + p);
    }
    // Require a minimum sample to avoid Monday-morning noise where a single
    // entry would otherwise read as 100% of a tiny denominator.
    const MIN_WEEK_TOTAL_FOR_IMBALANCE = 25;
    if (weekTotal >= MIN_WEEK_TOTAL_FOR_IMBALANCE) {
      let topReason = "";
      let topPoints = 0;
      for (const [r, pts] of reasonTotals) {
        if (pts > topPoints) {
          topPoints = pts;
          topReason = r;
        }
      }
      const pct = Math.round((topPoints / weekTotal) * 100);
      if (pct >= IMBALANCE_PCT && topReason) {
        reasonImbalance = { topReason, percent: pct, weekTotal };
      }
    }
  }

  // ---------- 4. Top-heavy recognition (this month) ----------
  // Find smallest set of students that account for ≥50% of monthly points;
  // flag if they are <10% of the recognized population.
  let topHeavyRecognition:
    | { studentCount: number; percentOfPoints: number; sample: string[] }
    | null = null;
  {
    // D5: scope monthly recognition analytics to caller's school only.
    const monthEntries = await db
      .select({
        studentId: pbisEntriesTable.studentId,
        points: pbisEntriesTable.points,
      })
      .from(pbisEntriesTable)
      .where(
        and(
          isNull(pbisEntriesTable.voidedAt),
          gte(pbisEntriesTable.createdAt, monthStart.toISOString()),
          eq(pbisEntriesTable.schoolId, req.schoolId!),
        ),
      );
    const perStudent = new Map<string, number>();
    let total = 0;
    for (const e of monthEntries) {
      const p = e.points || 0;
      total += p;
      perStudent.set(e.studentId, (perStudent.get(e.studentId) ?? 0) + p);
    }
    if (total > 0 && perStudent.size > 0) {
      const sorted = [...perStudent.entries()].sort((a, b) => b[1] - a[1]);
      let running = 0;
      let count = 0;
      const topIds: string[] = [];
      for (const [sid, pts] of sorted) {
        running += pts;
        count++;
        topIds.push(sid);
        if (running / total >= 0.5) break;
      }
      const recognizedCount = perStudent.size;
      if (count / recognizedCount < 0.1) {
        topHeavyRecognition = {
          studentCount: count,
          percentOfPoints: Math.round((running / total) * 100),
          sample: topIds
            .slice(0, 3)
            .map((id) => studentNameById.get(id) ?? id),
        };
      }
    }
  }

  // ---------- 5. Cold periods (this week) ----------
  // Use the default bell schedule's periods to bucket entries by period.
  const coldPeriods: Array<{
    period: number;
    name: string;
    weekTotal: number;
    schoolAverage: number;
  }> = [];
  {
    // D4: bell schedule is per-school. Cold-period analysis must use
    // THIS school's default schedule, not whichever happens to be first.
    const [defaultSched] = await db
      .select({ id: bellSchedulesTable.id })
      .from(bellSchedulesTable)
      .where(
        and(
          eq(bellSchedulesTable.isDefault, true),
          eq(bellSchedulesTable.active, true),
          eq(bellSchedulesTable.schoolId, req.schoolId!),
        ),
      )
      .limit(1);
    if (defaultSched) {
      const periods = await db
        .select({
          periodNumber: bellSchedulePeriodsTable.periodNumber,
          name: bellSchedulePeriodsTable.name,
          startTime: bellSchedulePeriodsTable.startTime,
          endTime: bellSchedulePeriodsTable.endTime,
        })
        .from(bellSchedulePeriodsTable)
        .where(eq(bellSchedulePeriodsTable.scheduleId, defaultSched.id));

      // Parse "HH:MM" → minutes since midnight.
      const toMin = (t: string): number => {
        const [hh, mm] = t.split(":").map((x) => parseInt(x, 10));
        if (!Number.isFinite(hh) || !Number.isFinite(mm)) return -1;
        return hh * 60 + mm;
      };
      const periodWindows = periods
        .map((p) => ({
          number: p.periodNumber,
          name: p.name,
          start: toMin(p.startTime),
          end: toMin(p.endTime),
        }))
        .filter((p) => p.start >= 0 && p.end >= 0);

      const totals = new Map<number, number>();
      for (const p of periodWindows) totals.set(p.number, 0);

      for (const e of weekEntries) {
        const d = new Date(e.createdAt);
        const dow = d.getDay();
        if (dow === 0 || dow === 6) continue;
        const minutes = d.getHours() * 60 + d.getMinutes();
        const match = periodWindows.find(
          (p) => minutes >= p.start && minutes < p.end,
        );
        if (!match) continue;
        totals.set(
          match.number,
          (totals.get(match.number) ?? 0) + (e.points || 0),
        );
      }

      const values = [...totals.values()];
      const sum = values.reduce((a, b) => a + b, 0);
      const avg = values.length > 0 ? sum / values.length : 0;
      if (avg > 0) {
        for (const p of periodWindows) {
          const t = totals.get(p.number) ?? 0;
          if (t * COLD_MULTIPLE <= avg) {
            coldPeriods.push({
              period: p.number,
              name: p.name,
              weekTotal: t,
              schoolAverage: +avg.toFixed(1),
            });
          }
        }
      }
    }
  }

  res.json({
    thresholds: {
      quietTeacherDays: QUIET_DAYS,
      // Tier-aware invisible windows (school days). Tier 1 = no active plan.
      invisibleStudentDaysByTier: {
        tier1: INVISIBLE_DAYS_TIER1,
        tier2: INVISIBLE_DAYS_TIER2,
        tier3: INVISIBLE_DAYS_TIER3,
      },
      reasonImbalancePct: IMBALANCE_PCT,
      coldPeriodMultiple: COLD_MULTIPLE,
    },
    quietTeachers: {
      count: quietTeachers.length,
      total: teachingStaff.length,
      sampleNames: quietTeacherSample,
    },
    invisibleStudents: {
      count: invisibleStudents.length,
      total: allStudents.length,
      sampleNames: invisibleStudentSample,
    },
    reasonImbalance,
    topHeavyRecognition,
    coldPeriods,
  });
});

// Silence unused-import warnings for staffNameById helper kept for future use.
void staffTable;

export default router;
