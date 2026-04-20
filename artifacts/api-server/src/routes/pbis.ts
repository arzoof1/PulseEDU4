import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  pbisEntriesTable,
  staffTable,
  recordEditsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  processMilestonesForStudent,
  processMilestonesForStudents,
} from "../lib/pbisMilestones";

const router: IRouter = Router();

type StaffRow = typeof staffTable.$inferSelect;

async function loadSessionStaff(req: Request): Promise<StaffRow | null> {
  const id = req.session.staffId;
  if (!id) return null;
  const [s] = await db.select().from(staffTable).where(eq(staffTable.id, id));
  return s && s.active ? s : null;
}

function canManageEntry(
  staff: StaffRow,
  entry: typeof pbisEntriesTable.$inferSelect,
): boolean {
  if (staff.isAdmin || staff.isPbisCoordinator) return true;
  return entry.staffId !== null && entry.staffId === staff.id;
}

async function logEdit(
  entryId: number,
  field: string,
  oldVal: string | null,
  newVal: string | null,
  staff: StaffRow,
) {
  await db.insert(recordEditsTable).values({
    recordType: "pbis_entry",
    recordId: String(entryId),
    fieldName: field,
    oldValue: oldVal,
    newValue: newVal,
    editedBy: staff.displayName,
    editedAt: new Date().toISOString(),
  });
}

router.get("/pbis", async (_req, res) => {
  const rows = await db.select().from(pbisEntriesTable);
  res.json(rows);
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

  const all = await db.select().from(pbisEntriesTable);
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

  const students = Array.from(studentTotals.entries())
    .map(([studentId, v]) => ({ studentId, total: v.total, count: v.count }))
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
  const { studentId, reason, points, staffName } = req.body ?? {};
  const sessionStaffId = req.session.staffId;
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
  const pts = Number(points);
  if (!Number.isFinite(pts)) {
    res.status(400).json({ error: "points must be a number" });
    return;
  }

  const [entry] = await db
    .insert(pbisEntriesTable)
    .values({
      studentId,
      reason,
      points: pts,
      staffId: resolvedStaffId,
      staffName: resolvedStaffName,
      createdAt: new Date().toISOString(),
    })
    .returning();

  const milestoneResults = await processMilestonesForStudent(studentId);
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
  const { studentIds, reason, points } = req.body ?? {};
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

  const nowIso = new Date().toISOString();
  const created: Array<typeof pbisEntriesTable.$inferSelect> = [];
  const errors: Array<{ studentId: string; error: string }> = [];
  for (const id of ids) {
    try {
      const [row] = await db
        .insert(pbisEntriesTable)
        .values({
          studentId: id,
          reason: reason.trim(),
          points: pts,
          staffId: staff.id,
          staffName: staff.displayName,
          createdAt: nowIso,
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
  void processMilestonesForStudents(idsToProcess).catch((err) => {
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
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const [entry] = await db
    .select()
    .from(pbisEntriesTable)
    .where(eq(pbisEntriesTable.id, id));
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
    .where(eq(pbisEntriesTable.id, id))
    .returning();

  if (updates.reason !== undefined && updates.reason !== entry.reason) {
    await logEdit(id, "reason", entry.reason, updates.reason, staff);
  }
  if (updates.points !== undefined && updates.points !== entry.points) {
    await logEdit(
      id,
      "points",
      String(entry.points),
      String(updates.points),
      staff,
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
  const [entry] = await db
    .select()
    .from(pbisEntriesTable)
    .where(eq(pbisEntriesTable.id, id));
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
    .where(eq(pbisEntriesTable.id, id))
    .returning();
  await logEdit(id, "voided", null, reasonText, staff);
  res.json(updated);
});

export default router;
