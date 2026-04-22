import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  db,
  issRosterTable,
  pulloutsTable,
  staffTable,
  studentsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { sendPulloutReturnEmail } from "../lib/pulloutEmail";
import { upsertIssAttendance } from "./issAttendance";

const router: IRouter = Router();

type StaffRow = typeof staffTable.$inferSelect;

async function loadStaff(req: Request): Promise<StaffRow | null> {
  const id = req.staffId;
  if (!id) return null;
  const [s] = await db.select().from(staffTable).where(eq(staffTable.id, id));
  return s && s.active ? s : null;
}

const canManageRoster = (s: StaffRow) =>
  s.isSuperUser ||
  s.isAdmin ||
  s.isIssTeacher ||
  s.isBehaviorSpecialist ||
  s.isDean ||
  s.isMtssCoordinator;

function requireRosterMW() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const staff = await loadStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    if (!canManageRoster(staff)) {
      res.status(403).json({ error: "ISS dashboard role required" });
      return;
    }
    (req as Request & { staff: StaffRow }).staff = staff;
    next();
  };
}

router.get("/iss-roster", requireRosterMW(), async (_req, res) => {
  const rows = await db
    .select()
    .from(issRosterTable)
    .orderBy(issRosterTable.createdAt);
  res.json(rows);
});

router.post(
  "/iss-roster",
  requireRosterMW(),
  async (req: Request, res: Response) => {
    const staff = (req as Request & { staff: StaffRow }).staff;
    const { studentId, period, notes } = req.body ?? {};
    if (typeof studentId !== "string" || !studentId.trim()) {
      res.status(400).json({ error: "studentId is required" });
      return;
    }
    const sId = studentId.trim();
    const [student] = await db
      .select()
      .from(studentsTable)
      .where(eq(studentsTable.studentId, sId));
    if (!student) {
      res.status(404).json({ error: "Student not found" });
      return;
    }
    let periodNum: number | null = null;
    if (period !== undefined && period !== null && period !== "") {
      const p = Number(period);
      if (!Number.isInteger(p) || p < 1 || p > 12) {
        res.status(400).json({ error: "period must be an integer 1-12" });
        return;
      }
      periodNum = p;
    }
    const noteStr =
      typeof notes === "string" && notes.trim() ? notes.trim() : null;
    const [row] = await db
      .insert(issRosterTable)
      .values({
        studentId: sId,
        source: "manual",
        pulloutId: null,
        period: periodNum,
        notes: noteStr,
        addedById: staff.id,
        addedByName: staff.displayName,
      })
      .returning();
    try {
      await upsertIssAttendance({
        studentId: sId,
        source: "manual",
        addedById: staff.id,
        addedByName: staff.displayName,
        notes: noteStr,
      });
    } catch (e) {
      console.error("[iss-attendance] manual upsert failed:", e);
    }
    res.status(201).json(row);
  },
);

router.put(
  "/iss-roster/:id",
  requireRosterMW(),
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const { period, notes } = req.body ?? {};
    let periodNum: number | null = null;
    if (period !== undefined && period !== null && period !== "") {
      const p = Number(period);
      if (!Number.isInteger(p) || p < 1 || p > 12) {
        res.status(400).json({ error: "period must be an integer 1-12" });
        return;
      }
      periodNum = p;
    }
    const noteStr =
      typeof notes === "string" && notes.trim() ? notes.trim() : null;
    const [row] = await db
      .update(issRosterTable)
      .set({ period: periodNum, notes: noteStr })
      .where(eq(issRosterTable.id, id))
      .returning();
    if (!row) {
      res.status(404).json({ error: "Roster entry not found" });
      return;
    }
    res.json(row);
  },
);

router.delete(
  "/iss-roster/:id",
  requireRosterMW(),
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [existing] = await db
      .select()
      .from(issRosterTable)
      .where(eq(issRosterTable.id, id));
    if (!existing) {
      res.status(404).json({ error: "Roster entry not found" });
      return;
    }
    let parentEmail: Awaited<ReturnType<typeof sendPulloutReturnEmail>> | null =
      null;
    // If pullout-sourced, mark pullout returned (if not already) and send parent email.
    if (existing.pulloutId) {
      const [pullout] = await db
        .select()
        .from(pulloutsTable)
        .where(eq(pulloutsTable.id, existing.pulloutId));
      if (pullout) {
        if (pullout.status !== "returned" && pullout.status !== "closed") {
          await db
            .update(pulloutsTable)
            .set({ status: "returned", returnedAt: new Date().toISOString() })
            .where(eq(pulloutsTable.id, existing.pulloutId));
        }
        parentEmail = await sendPulloutReturnEmail(existing.pulloutId);
        if (parentEmail && parentEmail.status === "error") {
          console.error(
            `[iss-roster] parent return email failed (rosterId=${id}, pulloutId=${existing.pulloutId}):`,
            parentEmail.errorMsg,
          );
        }
      }
    }
    await db.delete(issRosterTable).where(eq(issRosterTable.id, id));
    res.json({ ok: true, parentEmail });
  },
);

export default router;
