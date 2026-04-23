import { Router, type IRouter } from "express";
import { db, hallPassesTable, recordEditsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { config } from "../data/config";
import { requireSchool } from "../lib/scope.js";
import {
  findPolarityConflict,
  polarityConflictMessage,
} from "./polarityPairs";
import {
  findDailyLimitConflict,
  dailyLimitConflictMessage,
} from "./studentHallPassLimits";

const router: IRouter = Router();

router.get("/hall-passes", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const rows = await db
    .select()
    .from(hallPassesTable)
    .where(eq(hallPassesTable.schoolId, schoolId));
  res.json(rows);
});

router.post("/hall-passes", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const {
    studentId,
    destination,
    originRoom,
    teacherName,
    destinationTeacher,
    contactedAcknowledged,
    maxDurationMinutes,
    isTardyReturn,
  } = req.body ?? {};

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

  const destTeacher =
    typeof destinationTeacher === "string" && destinationTeacher.trim()
      ? destinationTeacher.trim()
      : null;
  const acknowledged = contactedAcknowledged === true;

  if (destTeacher && !acknowledged) {
    res.status(400).json({
      error:
        "contactedAcknowledged must be true when destinationTeacher is set",
    });
    return;
  }

  // Polarity / keep-apart enforcement: refuse to issue a pass if any of this
  // student's paired partners is currently out on a pass.
  const conflict = await findPolarityConflict(studentId, schoolId);
  if (conflict) {
    res.status(409).json({ error: polarityConflictMessage(conflict) });
    return;
  }

  // Daily-limit enforcement (per-student override falls back to per-school global).
  const limitConflict = await findDailyLimitConflict(studentId, schoolId);
  if (limitConflict) {
    res.status(409).json({ error: dailyLimitConflictMessage(limitConflict) });
    return;
  }

  const [pass] = await db
    .insert(hallPassesTable)
    .values({
      schoolId,
      studentId,
      destination,
      originRoom,
      teacherName,
      destinationTeacher: destTeacher,
      contactedAcknowledged: acknowledged,
      status: "active",
      createdAt: new Date().toISOString(),
      maxDurationMinutes:
        typeof maxDurationMinutes === "number" &&
        Number.isFinite(maxDurationMinutes) &&
        maxDurationMinutes > 0 &&
        maxDurationMinutes <= 240
          ? Math.round(maxDurationMinutes)
          : config.defaultHallPassDurationMinutes,
      endedAt: null,
      isTardyReturn: isTardyReturn === true,
    })
    .returning();
  res.status(201).json(pass);
});

router.patch("/hall-passes/:id/end", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const id = Number(req.params.id);
  const system = req.body?.system === true;
  const [pass] = await db
    .update(hallPassesTable)
    .set({
      status: system ? "system_ended" : "ended",
      endedAt: new Date().toISOString(),
    })
    .where(
      and(eq(hallPassesTable.id, id), eq(hallPassesTable.schoolId, schoolId)),
    )
    .returning();

  if (!pass) {
    res.status(404).json({ error: "Hall pass not found" });
    return;
  }
  res.json(pass);
});

router.patch("/hall-passes/:id", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const id = Number(req.params.id);
  const { endedAt, createdAt, editedBy } = req.body ?? {};

  if (typeof editedBy !== "string" || !editedBy.includes("(Admin)")) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }

  if (endedAt !== undefined && endedAt !== null && typeof endedAt !== "string") {
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

  if (createdAt !== undefined) {
    if (typeof createdAt !== "string" || !createdAt) {
      res
        .status(400)
        .json({ error: "createdAt must be a non-empty ISO string" });
      return;
    }
    const d = new Date(createdAt);
    if (Number.isNaN(d.getTime())) {
      res.status(400).json({ error: "createdAt is not a valid date" });
      return;
    }
  }

  const [existing] = await db
    .select()
    .from(hallPassesTable)
    .where(
      and(eq(hallPassesTable.id, id), eq(hallPassesTable.schoolId, schoolId)),
    );

  if (!existing) {
    res.status(404).json({ error: "Hall pass not found" });
    return;
  }

  const endedAtProvided = endedAt !== undefined;
  const newEndedAt = endedAtProvided
    ? endedAt === "" || endedAt === null
      ? null
      : (endedAt as string)
    : (existing.endedAt ?? null);
  const newStatus =
    newEndedAt === null
      ? "active"
      : existing.status === "system_ended"
        ? "system_ended"
        : "ended";

  const effectiveCreatedAt =
    createdAt !== undefined ? (createdAt as string) : existing.createdAt;
  if (
    newEndedAt !== null &&
    new Date(newEndedAt).getTime() <= new Date(effectiveCreatedAt).getTime()
  ) {
    res
      .status(400)
      .json({ error: "Started time must be before Ended time." });
    return;
  }

  const updates: Partial<typeof hallPassesTable.$inferInsert> = {};
  if (endedAtProvided) {
    updates.endedAt = newEndedAt;
    updates.status = newStatus;
  }
  if (createdAt !== undefined) {
    updates.createdAt = createdAt as string;
  }

  if (Object.keys(updates).length === 0) {
    res.json(existing);
    return;
  }

  const [updated] = await db
    .update(hallPassesTable)
    .set(updates)
    .where(
      and(eq(hallPassesTable.id, id), eq(hallPassesTable.schoolId, schoolId)),
    )
    .returning();

  const nowIso = new Date().toISOString();
  const edits: Array<typeof recordEditsTable.$inferInsert> = [];
  if (endedAtProvided && (existing.endedAt ?? null) !== (newEndedAt ?? null)) {
    edits.push({
      schoolId,
      recordType: "hall_pass",
      recordId: String(id),
      fieldName: "endedAt",
      oldValue: existing.endedAt,
      newValue: newEndedAt,
      editedBy,
      editedAt: nowIso,
    });
  }
  if (endedAtProvided && existing.status !== newStatus) {
    edits.push({
      schoolId,
      recordType: "hall_pass",
      recordId: String(id),
      fieldName: "status",
      oldValue: existing.status,
      newValue: newStatus,
      editedBy,
      editedAt: nowIso,
    });
  }
  if (
    createdAt !== undefined &&
    existing.createdAt !== (createdAt as string)
  ) {
    edits.push({
      schoolId,
      recordType: "hall_pass",
      recordId: String(id),
      fieldName: "createdAt",
      oldValue: existing.createdAt,
      newValue: createdAt as string,
      editedBy,
      editedAt: nowIso,
    });
  }
  if (edits.length > 0) {
    await db.insert(recordEditsTable).values(edits);
  }

  res.json(updated);
});

// Audit-trail viewer. Anyone with a valid session at the school can read
// their school's edit log. School isolation is enforced server-side: a
// staff member at school A cannot see edits made on school B's records,
// even with a known recordType/recordId pair.
router.get("/record-edits", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  if (!req.staffId) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
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
      .where(
        and(
          eq(recordEditsTable.schoolId, schoolId),
          eq(recordEditsTable.recordType, recordType),
        ),
      );
    rows = rows.filter((r) => r.recordId === recordId);
  } else {
    rows = await db
      .select()
      .from(recordEditsTable)
      .where(eq(recordEditsTable.schoolId, schoolId));
  }
  res.json(rows);
});

export default router;
