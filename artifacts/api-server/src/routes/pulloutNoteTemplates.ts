// Pullout note templates — school-scoped catalog of canned parent
// messages the verifier can drop into the Verify modal's notes
// textarea. Mirrors the pulloutReasons.ts pattern (per-school, edit
// gated to admin / behavior specialist / MTSS / dean / SuperUser).
//
// The Verify modal substitutes placeholders client-side before send:
//   {firstName} {lastName} {teacherName} {reason} {period} {schoolName}

import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { db, pulloutNoteTemplatesTable, staffTable } from "@workspace/db";
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

function requireSignedIn() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const staff = await loadStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    (req as Request & { staff: StaffRow }).staff = staff;
    next();
  };
}

// Same gate as pulloutReasons.ts.
function requireTemplateAdmin() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const staff = await loadStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    if (
      !staff.isSuperUser &&
      !staff.isAdmin &&
      !staff.isBehaviorSpecialist &&
      !staff.isMtssCoordinator &&
      !staff.isDean
    ) {
      res.status(403).json({
        error:
          "Admin, behavior specialist, MTSS coordinator, or dean only",
      });
      return;
    }
    (req as Request & { staff: StaffRow }).staff = staff;
    next();
  };
}

router.get(
  "/pullout-note-templates",
  requireSignedIn(),
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const rows = await db
      .select()
      .from(pulloutNoteTemplatesTable)
      .where(eq(pulloutNoteTemplatesTable.schoolId, schoolId))
      .orderBy(
        asc(pulloutNoteTemplatesTable.sortOrder),
        asc(pulloutNoteTemplatesTable.id),
      );
    res.json(rows);
  },
);

router.post(
  "/pullout-note-templates",
  requireTemplateAdmin(),
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const body = (req.body ?? {}) as {
      title?: unknown;
      body?: unknown;
      sortOrder?: unknown;
    };
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const tplBody = typeof body.body === "string" ? body.body.trim() : "";
    if (!title || title.length > 200) {
      res.status(400).json({ error: "title required (1-200 chars)" });
      return;
    }
    if (!tplBody || tplBody.length > 4000) {
      res.status(400).json({ error: "body required (1-4000 chars)" });
      return;
    }
    const sortOrder =
      typeof body.sortOrder === "number" && Number.isFinite(body.sortOrder)
        ? body.sortOrder
        : 0;
    const [row] = await db
      .insert(pulloutNoteTemplatesTable)
      .values({
        schoolId,
        title,
        body: tplBody,
        sortOrder,
        active: "true",
        createdAt: new Date().toISOString(),
      })
      .returning();
    res.status(201).json(row);
  },
);

router.patch(
  "/pullout-note-templates/:id",
  requireTemplateAdmin(),
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const body = (req.body ?? {}) as {
      title?: unknown;
      body?: unknown;
      sortOrder?: unknown;
      active?: unknown;
    };
    const updates: Partial<typeof pulloutNoteTemplatesTable.$inferInsert> = {};
    if (typeof body.title === "string") {
      const t = body.title.trim();
      if (!t || t.length > 200) {
        res.status(400).json({ error: "title must be 1-200 chars" });
        return;
      }
      updates.title = t;
    }
    if (typeof body.body === "string") {
      const b = body.body.trim();
      if (!b || b.length > 4000) {
        res.status(400).json({ error: "body must be 1-4000 chars" });
        return;
      }
      updates.body = b;
    }
    if (typeof body.sortOrder === "number") updates.sortOrder = body.sortOrder;
    if (typeof body.active === "boolean") {
      updates.active = body.active ? "true" : "false";
    }
    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "No updates" });
      return;
    }
    updates.updatedAt = new Date().toISOString();
    const [row] = await db
      .update(pulloutNoteTemplatesTable)
      .set(updates)
      .where(
        and(
          eq(pulloutNoteTemplatesTable.id, id),
          eq(pulloutNoteTemplatesTable.schoolId, schoolId),
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
  "/pullout-note-templates/:id",
  requireTemplateAdmin(),
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [row] = await db
      .delete(pulloutNoteTemplatesTable)
      .where(
        and(
          eq(pulloutNoteTemplatesTable.id, id),
          eq(pulloutNoteTemplatesTable.schoolId, schoolId),
        ),
      )
      .returning();
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({ ok: true, id: row.id });
  },
);

export default router;
