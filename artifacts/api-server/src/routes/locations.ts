import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { db, locationsTable, staffTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { verifyAuthToken } from "../lib/authToken.js";

const router: IRouter = Router();

type StaffRow = typeof staffTable.$inferSelect;

async function loadStaff(req: Request): Promise<StaffRow | null> {
  let id = req.session.staffId ?? null;
  if (!id) {
    const auth = req.headers.authorization;
    if (typeof auth === "string" && auth.startsWith("Bearer ")) {
      id = verifyAuthToken(auth.slice(7).trim());
    }
  }
  if (!id) return null;
  const [s] = await db.select().from(staffTable).where(eq(staffTable.id, id));
  return s && s.active ? s : null;
}

function requireAdminOrSuper() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const staff = await loadStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    if (!staff.isAdmin && !staff.isSuperUser) {
      res.status(403).json({ error: "Admin access required" });
      return;
    }
    next();
  };
}

const KINDS = new Set(["classroom", "common_area", "restroom", "office"]);

function parseLocationBody(body: unknown): {
  name?: string;
  kind?: string;
  isOrigin?: boolean;
  isDestination?: boolean;
  studentVisible?: boolean;
  active?: boolean;
  error?: string;
} {
  const b = (body ?? {}) as Record<string, unknown>;
  const out: {
    name?: string;
    kind?: string;
    isOrigin?: boolean;
    isDestination?: boolean;
    studentVisible?: boolean;
    active?: boolean;
    error?: string;
  } = {};
  if ("name" in b) {
    if (typeof b.name !== "string" || !b.name.trim()) {
      out.error = "name must be a non-empty string";
      return out;
    }
    out.name = b.name.trim();
  }
  if ("kind" in b) {
    if (typeof b.kind !== "string" || !KINDS.has(b.kind)) {
      out.error = `kind must be one of ${Array.from(KINDS).join(", ")}`;
      return out;
    }
    out.kind = b.kind;
  }
  for (const f of ["isOrigin", "isDestination", "studentVisible", "active"] as const) {
    if (f in b) {
      if (typeof b[f] !== "boolean") {
        out.error = `${f} must be boolean`;
        return out;
      }
      out[f] = b[f] as boolean;
    }
  }
  return out;
}

router.get("/locations", async (_req, res) => {
  const rows = await db.select().from(locationsTable);
  rows.sort((a, b) => a.name.localeCompare(b.name));
  res.json(rows);
});

router.post("/locations", requireAdminOrSuper(), async (req, res) => {
  const parsed = parseLocationBody(req.body);
  if (parsed.error) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  if (!parsed.name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  try {
    const [row] = await db
      .insert(locationsTable)
      .values({
        name: parsed.name,
        kind: parsed.kind ?? "classroom",
        isOrigin: parsed.isOrigin ?? false,
        isDestination: parsed.isDestination ?? false,
        studentVisible: parsed.studentVisible ?? false,
        active: parsed.active ?? true,
      })
      .returning();
    res.status(201).json(row);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to create location";
    if (msg.toLowerCase().includes("unique")) {
      res.status(409).json({ error: "A location with that name already exists." });
      return;
    }
    res.status(500).json({ error: msg });
  }
});

router.patch("/locations/:id", requireAdminOrSuper(), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const parsed = parseLocationBody(req.body);
  if (parsed.error) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const updates: Record<string, unknown> = {};
  for (const k of [
    "name",
    "kind",
    "isOrigin",
    "isDestination",
    "studentVisible",
    "active",
  ] as const) {
    if (parsed[k] !== undefined) updates[k] = parsed[k];
  }
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }
  try {
    const [row] = await db
      .update(locationsTable)
      .set(updates)
      .where(eq(locationsTable.id, id))
      .returning();
    if (!row) {
      res.status(404).json({ error: "Location not found" });
      return;
    }
    res.json(row);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to update location";
    if (msg.toLowerCase().includes("unique")) {
      res.status(409).json({ error: "A location with that name already exists." });
      return;
    }
    res.status(500).json({ error: msg });
  }
});

export default router;
