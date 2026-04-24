// Classroom Store CRUD — per-teacher catalog of rewards a student can
// "buy" with their PBIS points. Each row is owned by one staffer; only
// that staffer (or a school admin) can edit/delete the row. Reads return
// only the caller's own items so each teacher sees only their own store.
//
// Routes:
//   GET    /api/classroom-store          → list current teacher's items
//   POST   /api/classroom-store          → create
//   PATCH  /api/classroom-store/:id      → edit
//   DELETE /api/classroom-store/:id      → delete (hard delete; no redemption
//                                          history exists yet, so safe to remove)
import { Router, type IRouter } from "express";
import {
  db,
  classroomStoreItemsTable,
  staffTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import { bindObjectToSchool } from "./storage.js";

const router: IRouter = Router();

async function loadStaff(req: import("express").Request, res: import("express").Response) {
  const staffId = req.staffId;
  if (!staffId) {
    res.status(401).json({ error: "Sign-in required" });
    return null;
  }
  const [staff] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, staffId));
  if (!staff || !staff.active) {
    res.status(401).json({ error: "Sign-in required" });
    return null;
  }
  return staff;
}

function canWriteRow(
  staff: typeof staffTable.$inferSelect,
  row: { ownerStaffId: number },
) {
  return !!staff.isAdmin || row.ownerStaffId === staff.id;
}

function nowIso() {
  return new Date().toISOString();
}

// ---- LIST ----
router.get("/classroom-store", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const rows = await db
    .select()
    .from(classroomStoreItemsTable)
    .where(
      and(
        eq(classroomStoreItemsTable.schoolId, schoolId),
        eq(classroomStoreItemsTable.ownerStaffId, staff.id),
      ),
    )
    .orderBy(
      classroomStoreItemsTable.archived,
      classroomStoreItemsTable.sortOrder,
      classroomStoreItemsTable.name,
    );
  res.json(rows);
});

// ---- CREATE ----
router.post("/classroom-store", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const { name, description, pointsCost, imageUrl } = req.body ?? {};
  if (typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const cleanName = name.trim().slice(0, 80);
  const cleanDesc =
    typeof description === "string" ? description.trim().slice(0, 500) : "";
  let pts = 1;
  if (pointsCost !== undefined && pointsCost !== null) {
    const n = Number(pointsCost);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      res
        .status(400)
        .json({ error: "pointsCost must be a non-negative integer" });
      return;
    }
    pts = n;
  }
  let cleanImage: string | null = null;
  if (typeof imageUrl === "string" && imageUrl.trim()) {
    // Only accept normalized object-storage paths to avoid storing arbitrary
    // off-site URLs.
    const t = imageUrl.trim();
    if (!t.startsWith("/objects/")) {
      res
        .status(400)
        .json({ error: "imageUrl must be a stored object path" });
      return;
    }
    cleanImage = t.slice(0, 500);
  }
  // Default sort_order: append at the end of the teacher's list.
  const [{ maxOrder }] = await db
    .select({
      maxOrder: sql<number>`coalesce(max(${classroomStoreItemsTable.sortOrder}), -1)`,
    })
    .from(classroomStoreItemsTable)
    .where(
      and(
        eq(classroomStoreItemsTable.schoolId, schoolId),
        eq(classroomStoreItemsTable.ownerStaffId, staff.id),
      ),
    );
  const order = (maxOrder ?? -1) + 1;
  const [row] = await db
    .insert(classroomStoreItemsTable)
    .values({
      schoolId,
      ownerStaffId: staff.id,
      name: cleanName,
      description: cleanDesc,
      pointsCost: pts,
      imageUrl: cleanImage,
      sortOrder: order,
      archived: false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .returning();
  // Bind the uploaded image to this school so cross-tenant reads are blocked.
  // If binding refuses (no upload URL was issued to this school for this
  // path, or it's already owned by someone else), tear the row back down
  // and reject — we don't want to persist a thumbnail we can't serve.
  if (row.imageUrl) {
    let bound = false;
    try {
      bound = await bindObjectToSchool(row.imageUrl, schoolId);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[classroomStore] failed to bind image ACL", e);
    }
    if (!bound) {
      await db
        .delete(classroomStoreItemsTable)
        .where(eq(classroomStoreItemsTable.id, row.id));
      res.status(400).json({ error: "Invalid imageUrl" });
      return;
    }
  }
  res.status(201).json(row);
});

// ---- UPDATE ----
router.patch("/classroom-store/:id", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [existing] = await db
    .select()
    .from(classroomStoreItemsTable)
    .where(
      and(
        eq(classroomStoreItemsTable.id, id),
        eq(classroomStoreItemsTable.schoolId, schoolId),
      ),
    );
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (!canWriteRow(staff, existing)) {
    res.status(403).json({ error: "Not allowed to edit this item" });
    return;
  }
  const { name, description, pointsCost, imageUrl, archived, sortOrder } =
    req.body ?? {};
  const updates: Partial<typeof classroomStoreItemsTable.$inferInsert> = {};
  if (typeof name === "string" && name.trim()) {
    updates.name = name.trim().slice(0, 80);
  }
  if (typeof description === "string") {
    updates.description = description.trim().slice(0, 500);
  }
  if (pointsCost !== undefined && pointsCost !== null) {
    const n = Number(pointsCost);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      res
        .status(400)
        .json({ error: "pointsCost must be a non-negative integer" });
      return;
    }
    updates.pointsCost = n;
  }
  if (imageUrl !== undefined) {
    if (imageUrl === null || imageUrl === "") {
      updates.imageUrl = null;
    } else if (typeof imageUrl === "string" && imageUrl.trim()) {
      const t = imageUrl.trim();
      if (!t.startsWith("/objects/")) {
        res
          .status(400)
          .json({ error: "imageUrl must be a stored object path" });
        return;
      }
      updates.imageUrl = t.slice(0, 500);
    }
  }
  if (typeof archived === "boolean") updates.archived = archived;
  if (sortOrder !== undefined) {
    if (typeof sortOrder !== "number" || !Number.isInteger(sortOrder)) {
      res.status(400).json({ error: "sortOrder must be an integer" });
      return;
    }
    updates.sortOrder = sortOrder;
  }
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No updates" });
    return;
  }
  updates.updatedAt = nowIso();
  // If the image was swapped to a new object, validate the bind FIRST and
  // refuse the whole update if we can't claim it. We do this before writing
  // the row so a failed claim doesn't mutate state.
  if (
    typeof updates.imageUrl === "string" &&
    updates.imageUrl !== existing.imageUrl
  ) {
    let bound = false;
    try {
      bound = await bindObjectToSchool(updates.imageUrl, schoolId);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[classroomStore] failed to bind image ACL", e);
    }
    if (!bound) {
      res.status(400).json({ error: "Invalid imageUrl" });
      return;
    }
  }
  const [row] = await db
    .update(classroomStoreItemsTable)
    .set(updates)
    .where(
      and(
        eq(classroomStoreItemsTable.id, id),
        eq(classroomStoreItemsTable.schoolId, schoolId),
      ),
    )
    .returning();
  res.json(row);
});

// ---- DELETE ----
router.delete("/classroom-store/:id", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [existing] = await db
    .select()
    .from(classroomStoreItemsTable)
    .where(
      and(
        eq(classroomStoreItemsTable.id, id),
        eq(classroomStoreItemsTable.schoolId, schoolId),
      ),
    );
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (!canWriteRow(staff, existing)) {
    res.status(403).json({ error: "Not allowed to delete this item" });
    return;
  }
  await db
    .delete(classroomStoreItemsTable)
    .where(
      and(
        eq(classroomStoreItemsTable.id, id),
        eq(classroomStoreItemsTable.schoolId, schoolId),
      ),
    );
  res.json({ ok: true });
});

export default router;
