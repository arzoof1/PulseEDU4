// School-closed-day calendar (no-school days). Maintained at start of
// year by Admin / PBIS Coordinator / Behavior Specialist / MTSS
// Coordinator / Dean. Read-allowed for any signed-in staff (the modal
// calendar greys these days even for non-admins who have Admin Hub
// access).
import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { db, schoolClosedDaysTable, staffTable } from "@workspace/db";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";

const router: IRouter = Router();
type StaffRow = typeof staffTable.$inferSelect;

async function loadStaff(req: Request): Promise<StaffRow | null> {
  const id = req.staffId;
  if (!id) return null;
  const [s] = await db.select().from(staffTable).where(eq(staffTable.id, id));
  return s && s.active ? s : null;
}

const canWrite = (s: StaffRow) =>
  s.isSuperUser ||
  s.isDistrictAdmin ||
  s.isAdmin ||
  s.isPbisCoordinator ||
  s.isBehaviorSpecialist ||
  s.isMtssCoordinator ||
  s.isDean;

function gateWrite() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const staff = await loadStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    if (!canWrite(staff)) {
      res.status(403).json({
        error: "Admin / PBIS / BS / MTSS / Dean only",
      });
      return;
    }
    (req as Request & { staff: StaffRow }).staff = staff;
    next();
  };
}

router.get("/school-closed-days", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const from = String(req.query.from ?? "");
  const to = String(req.query.to ?? "");
  const conds = [eq(schoolClosedDaysTable.schoolId, schoolId)];
  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    conds.push(gte(schoolClosedDaysTable.day, from));
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    conds.push(lte(schoolClosedDaysTable.day, to));
  }
  const rows = await db
    .select()
    .from(schoolClosedDaysTable)
    .where(and(...conds))
    .orderBy(asc(schoolClosedDaysTable.day));
  res.json(rows);
});

router.post("/school-closed-days", gateWrite(), async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const staff = (req as Request & { staff: StaffRow }).staff;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const day = typeof body.day === "string" ? body.day.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    res.status(400).json({ error: "day must be YYYY-MM-DD" });
    return;
  }
  const label =
    typeof body.label === "string" && body.label.trim()
      ? body.label.trim().slice(0, 200)
      : null;
  try {
    const [row] = await db
      .insert(schoolClosedDaysTable)
      .values({
        schoolId,
        day,
        label,
        createdById: staff.id,
        createdByName: staff.displayName,
      })
      .returning();
    res.status(201).json(row);
  } catch (e: unknown) {
    if (e instanceof Error && /duplicate/i.test(e.message)) {
      res.status(409).json({ error: "Day already marked closed" });
      return;
    }
    throw e;
  }
});

router.patch(
  "/school-closed-days/:id",
  gateWrite(),
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const label =
      typeof body.label === "string" ? body.label.trim().slice(0, 200) : null;
    const [row] = await db
      .update(schoolClosedDaysTable)
      .set({ label })
      .where(
        and(
          eq(schoolClosedDaysTable.id, id),
          eq(schoolClosedDaysTable.schoolId, schoolId),
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
  "/school-closed-days/:id",
  gateWrite(),
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const r = await db
      .delete(schoolClosedDaysTable)
      .where(
        and(
          eq(schoolClosedDaysTable.id, id),
          eq(schoolClosedDaysTable.schoolId, schoolId),
        ),
      )
      .returning({ id: schoolClosedDaysTable.id });
    if (r.length === 0) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({ ok: true });
  },
);

export default router;
