import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { db, staffTable, customRolesTable } from "@workspace/db";
import { eq, asc } from "drizzle-orm";

const router: IRouter = Router();

// Whitelist of capability strings that may live in a custom role bundle.
// Notably excludes role flags (isAdmin, isSuperUser, etc.) and the two
// role-management caps (capStaffRoles, capManageRoles) so a non-SuperUser
// with capManageRoles cannot mint a "god mode" custom role.
const ALLOWED_CUSTOM_ROLE_CAPS = new Set<string>([
  "capHallPasses",
  "capTardies",
  "capStudentActivity",
  "capPbisAward",
  "capParentEmail",
  "capSupportNotes",
  "capAccommodationLog",
  "capPulloutsRequest",
  "capInterventionLog",
  "capReports",
  "capKioskActivate",
  "capHallPassesViewAll",
  "capPbisManage",
  "capAccommodationManage",
  "capPulloutsVerify",
  "capPulloutsReview",
  "capInterventionManage",
  "capIssDashboard",
  "capManageLocations",
]);

function sanitizeCaps(actor: { isSuperUser: boolean }, caps: string[]): string[] {
  const out: string[] = [];
  for (const c of caps) {
    if (ALLOWED_CUSTOM_ROLE_CAPS.has(c)) out.push(c);
    else if (
      actor.isSuperUser &&
      (c === "capStaffRoles" || c === "capManageRoles")
    ) {
      out.push(c);
    }
  }
  return Array.from(new Set(out));
}

type StaffRow = typeof staffTable.$inferSelect;

async function loadStaff(req: Request): Promise<StaffRow | null> {
  // Privileged surface (custom-role CRUD). Session-only — never trust a
  // client-supplied actor id, or anyone could create roles as SuperUser.
  const id = req.session.staffId;
  if (!id) return null;
  const [s] = await db.select().from(staffTable).where(eq(staffTable.id, id));
  return s && s.active ? s : null;
}

function requireRead() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const s = await loadStaff(req);
    if (!s) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    if (!s.isAdmin && !s.isSuperUser && !s.capStaffRoles) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    (req as Request & { staff: StaffRow }).staff = s;
    next();
  };
}

function requireSuper() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const s = await loadStaff(req);
    if (!s) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    if (!s.isSuperUser && !s.capManageRoles) {
      res.status(403).json({ error: "SuperUser only" });
      return;
    }
    (req as Request & { staff: StaffRow }).staff = s;
    next();
  };
}

router.get("/custom-roles", requireRead(), async (_req, res: Response) => {
  const rows = await db
    .select()
    .from(customRolesTable)
    .orderBy(asc(customRolesTable.label));
  res.json(rows);
});

router.post("/custom-roles", requireSuper(), async (req: Request, res: Response) => {
  const { key, label, capabilities } = (req.body ?? {}) as {
    key?: unknown;
    label?: unknown;
    capabilities?: unknown;
  };
  if (
    typeof key !== "string" ||
    typeof label !== "string" ||
    !key.trim() ||
    !label.trim() ||
    !Array.isArray(capabilities) ||
    !capabilities.every((c) => typeof c === "string")
  ) {
    res.status(400).json({ error: "key, label, capabilities[] required" });
    return;
  }
  const actor = (req as Request & { staff: StaffRow }).staff;
  const safeCaps = sanitizeCaps(actor, capabilities as string[]);
  const [row] = await db
    .insert(customRolesTable)
    .values({
      key: key.trim().toLowerCase().replace(/\s+/g, "_"),
      label: label.trim(),
      capabilities: safeCaps,
    })
    .returning();
  res.status(201).json(row);
});

router.patch("/custom-roles/:id", requireSuper(), async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const { label, capabilities } = (req.body ?? {}) as {
    label?: unknown;
    capabilities?: unknown;
  };
  const updates: { label?: string; capabilities?: string[] } = {};
  if (typeof label === "string" && label.trim()) updates.label = label.trim();
  if (
    Array.isArray(capabilities) &&
    capabilities.every((c) => typeof c === "string")
  ) {
    const actor = (req as Request & { staff: StaffRow }).staff;
    updates.capabilities = sanitizeCaps(actor, capabilities as string[]);
  }
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "Nothing to update" });
    return;
  }
  const [row] = await db
    .update(customRolesTable)
    .set(updates)
    .where(eq(customRolesTable.id, id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(row);
});

router.delete("/custom-roles/:id", requireSuper(), async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  await db.delete(customRolesTable).where(eq(customRolesTable.id, id));
  res.status(204).end();
});

export default router;
