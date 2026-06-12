import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  pbisMilestonesTable,
  pbisMilestoneEmailsTable,
  staffTable,
  studentsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";

const router: IRouter = Router();

type StaffRow = typeof staffTable.$inferSelect;

async function loadStaff(req: Request): Promise<StaffRow | null> {
  const id = req.staffId;
  if (!id) return null;
  const [s] = await db.select().from(staffTable).where(eq(staffTable.id, id));
  return s && s.active ? s : null;
}

function isManager(s: StaffRow): boolean {
  return s.isSuperUser || s.isAdmin || s.isPbisCoordinator;
}

router.get("/pbis-milestones", async (req: Request, res: Response) => {
  const staff = await loadStaff(req);
  if (!staff) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const rows = await db
    .select()
    .from(pbisMilestonesTable)
    .where(eq(pbisMilestonesTable.schoolId, schoolId));
  rows.sort((a, b) => a.points - b.points);
  res.json(rows);
});

router.post("/pbis-milestones", async (req: Request, res: Response) => {
  const staff = await loadStaff(req);
  if (!staff || !isManager(staff)) {
    res.status(403).json({ error: "Admin or PBIS coordinator only" });
    return;
  }
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const points = Number(req.body?.points);
  if (!Number.isFinite(points) || points <= 0) {
    res.status(400).json({ error: "points must be a positive number" });
    return;
  }
  // Per-school duplicate check (the old table-wide unique on `points` was
  // dropped in D4 to allow two schools to use the same milestone value).
  const existing = await db
    .select({ id: pbisMilestonesTable.id })
    .from(pbisMilestonesTable)
    .where(
      and(
        eq(pbisMilestonesTable.schoolId, schoolId),
        eq(pbisMilestonesTable.points, Math.trunc(points)),
      ),
    );
  if (existing.length > 0) {
    res.status(409).json({ error: "That milestone already exists" });
    return;
  }
  try {
    const [row] = await db
      .insert(pbisMilestonesTable)
      .values({
        schoolId,
        points: Math.trunc(points),
        active: true,
        createdAt: new Date().toISOString(),
      })
      .returning();
    res.status(201).json(row);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/unique/i.test(msg)) {
      res.status(409).json({ error: "That milestone already exists" });
      return;
    }
    res.status(500).json({ error: msg });
  }
});

router.patch("/pbis-milestones/:id", async (req: Request, res: Response) => {
  const staff = await loadStaff(req);
  if (!staff || !isManager(staff)) {
    res.status(403).json({ error: "Admin or PBIS coordinator only" });
    return;
  }
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Bad id" });
    return;
  }
  const active = req.body?.active;
  if (typeof active !== "boolean") {
    res.status(400).json({ error: "active boolean required" });
    return;
  }
  const [row] = await db
    .update(pbisMilestonesTable)
    .set({ active })
    .where(
      and(
        eq(pbisMilestonesTable.id, id),
        eq(pbisMilestonesTable.schoolId, schoolId),
      ),
    )
    .returning();
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(row);
});

router.get(
  "/pbis-milestone-emails",
  async (req: Request, res: Response) => {
    const staff = await loadStaff(req);
    if (!staff || !isManager(staff)) {
      res.status(403).json({ error: "Admin or PBIS coordinator only" });
      return;
    }
    // D5: scope email log to caller's school. Email rows are stamped with
    // school_id when the milestone helper inserts them (D5 follow-up).
    const rows = await db
      .select()
      .from(pbisMilestoneEmailsTable)
      .where(eq(pbisMilestoneEmailsTable.schoolId, req.schoolId!));
    rows.sort((a, b) => (a.sentAt < b.sentAt ? 1 : -1));
    const top = rows.slice(0, 100);
    const idsNeeded = Array.from(
      new Set(top.map((r) => r.studentId).filter(Boolean)),
    );
    const studentRows = idsNeeded.length
      ? await db
          .select({
            studentId: studentsTable.studentId,
            localSisId: studentsTable.localSisId,
          })
          .from(studentsTable)
          .where(
            and(
              eq(studentsTable.schoolId, req.schoolId!),
              inArray(studentsTable.studentId, idsNeeded),
            ),
          )
      : [];
    const localSisById = new Map(
      studentRows.map((s) => [s.studentId, s.localSisId ?? null]),
    );
    res.json(
      top.map((r) => ({
        ...r,
        localSisId: localSisById.get(r.studentId) ?? null,
      })),
    );
  },
);

export default router;
