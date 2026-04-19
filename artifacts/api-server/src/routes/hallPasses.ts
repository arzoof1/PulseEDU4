import { Router, type IRouter } from "express";
import { db, hallPassesTable, recordEditsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { config } from "../data/config";

const router: IRouter = Router();

router.get("/hall-passes", async (_req, res) => {
  const rows = await db.select().from(hallPassesTable);
  res.json(rows);
});

router.post("/hall-passes", async (req, res) => {
  const { studentId, destination, originRoom, teacherName } = req.body ?? {};

  if (
    typeof studentId !== "string" ||
    typeof destination !== "string" ||
    typeof originRoom !== "string" ||
    typeof teacherName !== "string"
  ) {
    res.status(400).json({
      error:
        "studentId, destination, originRoom, and teacherName are required",
    });
    return;
  }

  const [pass] = await db
    .insert(hallPassesTable)
    .values({
      studentId,
      destination,
      originRoom,
      teacherName,
      status: "active",
      createdAt: new Date().toISOString(),
      maxDurationMinutes: config.defaultHallPassDurationMinutes,
      endedAt: null,
    })
    .returning();
  res.status(201).json(pass);
});

router.patch("/hall-passes/:id/end", async (req, res) => {
  const id = Number(req.params.id);
  const system = req.body?.system === true;
  const [pass] = await db
    .update(hallPassesTable)
    .set({
      status: system ? "system_ended" : "ended",
      endedAt: new Date().toISOString(),
    })
    .where(eq(hallPassesTable.id, id))
    .returning();

  if (!pass) {
    res.status(404).json({ error: "Hall pass not found" });
    return;
  }
  res.json(pass);
});

router.patch("/hall-passes/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { endedAt, editedBy } = req.body ?? {};

  if (typeof editedBy !== "string" || !editedBy.includes("(Admin)")) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }

  if (endedAt !== null && typeof endedAt !== "string") {
    res
      .status(400)
      .json({ error: "endedAt must be an ISO string or null" });
    return;
  }

  if (typeof endedAt === "string" && endedAt) {
    const d = new Date(endedAt);
    if (Number.isNaN(d.getTime())) {
      res.status(400).json({ error: "endedAt is not a valid date" });
      return;
    }
  }

  const [existing] = await db
    .select()
    .from(hallPassesTable)
    .where(eq(hallPassesTable.id, id));

  if (!existing) {
    res.status(404).json({ error: "Hall pass not found" });
    return;
  }

  const newEndedAt = endedAt === "" ? null : (endedAt as string | null);
  const newStatus =
    newEndedAt === null
      ? "active"
      : existing.status === "system_ended"
        ? "system_ended"
        : "ended";

  const [updated] = await db
    .update(hallPassesTable)
    .set({ endedAt: newEndedAt, status: newStatus })
    .where(eq(hallPassesTable.id, id))
    .returning();

  const nowIso = new Date().toISOString();
  const edits: Array<typeof recordEditsTable.$inferInsert> = [];
  if ((existing.endedAt ?? null) !== (newEndedAt ?? null)) {
    edits.push({
      recordType: "hall_pass",
      recordId: String(id),
      fieldName: "endedAt",
      oldValue: existing.endedAt,
      newValue: newEndedAt,
      editedBy,
      editedAt: nowIso,
    });
  }
  if (existing.status !== newStatus) {
    edits.push({
      recordType: "hall_pass",
      recordId: String(id),
      fieldName: "status",
      oldValue: existing.status,
      newValue: newStatus,
      editedBy,
      editedAt: nowIso,
    });
  }
  if (edits.length > 0) {
    await db.insert(recordEditsTable).values(edits);
  }

  res.json(updated);
});

router.get("/record-edits", async (req, res) => {
  const { recordType, recordId } = req.query;
  let rows;
  if (
    typeof recordType === "string" &&
    recordType &&
    typeof recordId === "string" &&
    recordId
  ) {
    rows = await db
      .select()
      .from(recordEditsTable)
      .where(eq(recordEditsTable.recordType, recordType));
    rows = rows.filter((r) => r.recordId === recordId);
  } else {
    rows = await db.select().from(recordEditsTable);
  }
  res.json(rows);
});

export default router;
