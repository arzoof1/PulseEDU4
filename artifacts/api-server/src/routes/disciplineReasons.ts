// Per-school discipline reasons (used by Add ISS / OSS Log modals).
// Read-allowed for any signed-in staff with Admin Hub access; write-
// gated to school admin tier.
import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { db, disciplineReasonsTable, staffTable } from "@workspace/db";
import { and, asc, eq } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";

const router: IRouter = Router();
type StaffRow = typeof staffTable.$inferSelect;

async function loadStaff(req: Request): Promise<StaffRow | null> {
  const id = req.staffId;
  if (!id) return null;
  const [s] = await db.select().from(staffTable).where(eq(staffTable.id, id));
  return s && s.active ? s : null;
}

const canRead = (s: StaffRow) =>
  s.isSuperUser ||
  s.isDistrictAdmin ||
  s.isAdmin ||
  s.isDean ||
  s.isBehaviorSpecialist ||
  s.isMtssCoordinator;

const canWrite = (s: StaffRow) =>
  s.isSuperUser || s.isDistrictAdmin || s.isAdmin;

function gate(check: (s: StaffRow) => boolean, label: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const staff = await loadStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    if (!check(staff)) {
      res.status(403).json({ error: `${label} only` });
      return;
    }
    (req as Request & { staff: StaffRow }).staff = staff;
    next();
  };
}

router.get("/discipline-reasons", gate(canRead, "Admin Hub"), async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const rows = await db
    .select()
    .from(disciplineReasonsTable)
    .where(eq(disciplineReasonsTable.schoolId, schoolId))
    .orderBy(asc(disciplineReasonsTable.sortOrder), asc(disciplineReasonsTable.label));
  res.json(rows);
});

router.post("/discipline-reasons", gate(canWrite, "Admin"), async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!label || label.length > 200) {
    res.status(400).json({ error: "label is required (1-200 chars)" });
    return;
  }
  const sortOrder = Number.isInteger(body.sortOrder) ? Number(body.sortOrder) : 0;
  try {
    const [row] = await db
      .insert(disciplineReasonsTable)
      .values({ schoolId, label, sortOrder })
      .returning();
    res.status(201).json(row);
  } catch (e: unknown) {
    if (e instanceof Error && /duplicate/i.test(e.message)) {
      res.status(409).json({ error: "Reason already exists" });
      return;
    }
    throw e;
  }
});

router.patch(
  "/discipline-reasons/:id",
  gate(canWrite, "Admin"),
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const updates: Partial<typeof disciplineReasonsTable.$inferInsert> = {};
    if (typeof body.label === "string" && body.label.trim()) {
      updates.label = body.label.trim().slice(0, 200);
    }
    if (typeof body.active === "boolean") updates.active = body.active;
    if (Number.isInteger(body.sortOrder)) {
      updates.sortOrder = Number(body.sortOrder);
    }
    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }
    const [row] = await db
      .update(disciplineReasonsTable)
      .set(updates)
      .where(
        and(
          eq(disciplineReasonsTable.id, id),
          eq(disciplineReasonsTable.schoolId, schoolId),
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
  "/discipline-reasons/:id",
  gate(canWrite, "Admin"),
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    // Soft-delete by clearing `active` so historical logs that reference
    // this reason still display the label correctly.
    const [row] = await db
      .update(disciplineReasonsTable)
      .set({ active: false })
      .where(
        and(
          eq(disciplineReasonsTable.id, id),
          eq(disciplineReasonsTable.schoolId, schoolId),
        ),
      )
      .returning();
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({ ok: true });
  },
);

export default router;
