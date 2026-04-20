import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  db,
  hallPassesTable,
  recordEditsTable,
  staffTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { config } from "../data/config";
import {
  findPolarityConflict,
  polarityConflictMessage,
} from "./polarityPairs";

const router: IRouter = Router();

type StaffRow = typeof staffTable.$inferSelect;

async function loadStaff(req: Request): Promise<StaffRow | null> {
  const id = req.session.staffId;
  if (!id) return null;
  const [s] = await db.select().from(staffTable).where(eq(staffTable.id, id));
  return s && s.active ? s : null;
}

function requireStaffMW(check?: (s: StaffRow) => boolean, label = "Sign-in") {
  return async (req: Request, res: Response, next: NextFunction) => {
    const staff = await loadStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    if (check && !check(staff)) {
      res.status(403).json({ error: `${label} only` });
      return;
    }
    (req as Request & { staff: StaffRow }).staff = staff;
    next();
  };
}

// List hall passes. Staff with capHallPassesViewAll see all rows; everyone
// else sees only passes where they are the issuing teacher (matched by
// displayName, the same value written into hallPassesTable.teacherName).
router.get(
  "/hall-passes",
  requireStaffMW(),
  async (req: Request, res: Response) => {
    const staff = (req as Request & { staff: StaffRow }).staff;
    const rows = await db.select().from(hallPassesTable);
    if (staff.capHallPassesViewAll) {
      res.json(rows);
      return;
    }
    const mine = rows.filter((r) => r.teacherName === staff.displayName);
    res.json(mine);
  },
);

// Issue a hall pass. Requires capHallPasses.
router.post(
  "/hall-passes",
  requireStaffMW((s) => s.capHallPasses, "Hall pass issuing"),
  async (req: Request, res: Response) => {
    const staff = (req as Request & { staff: StaffRow }).staff;
    const {
      studentId,
      destination,
      originRoom,
      destinationTeacher,
      contactedAcknowledged,
    } = req.body ?? {};

    if (
      typeof studentId !== "string" ||
      typeof destination !== "string" ||
      typeof originRoom !== "string"
    ) {
      res.status(400).json({
        error: "studentId, destination, and originRoom are required",
      });
      return;
    }

    // Issuing teacher is always the signed-in staff member — never trust
    // a client-supplied teacherName, which would let any caller forge
    // pass ownership and bypass the own/all visibility split below.
    const teacherName = staff.displayName;

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
    const conflict = await findPolarityConflict(studentId);
    if (conflict) {
      res.status(409).json({ error: polarityConflictMessage(conflict) });
      return;
    }

    const [pass] = await db
      .insert(hallPassesTable)
      .values({
        studentId,
        destination,
        originRoom,
        teacherName,
        destinationTeacher: destTeacher,
        contactedAcknowledged: acknowledged,
        status: "active",
        createdAt: new Date().toISOString(),
        maxDurationMinutes: config.defaultHallPassDurationMinutes,
        endedAt: null,
      })
      .returning();
    res.status(201).json(pass);
  },
);

// End a hall pass. You may always end your own pass with capHallPasses;
// ending someone else's pass requires capHallPassesViewAll. The "system"
// auto-end flag (fired by the dashboard when a pass exceeds its max
// duration) is allowed for any signed-in staff with either cap so the
// monitoring loop on every dashboard works.
router.patch(
  "/hall-passes/:id/end",
  requireStaffMW(
    (s) => s.capHallPasses || s.capHallPassesViewAll,
    "Hall pass access",
  ),
  async (req: Request, res: Response) => {
    const staff = (req as Request & { staff: StaffRow }).staff;
    const id = Number(req.params.id);
    const system = req.body?.system === true;

    const [existing] = await db
      .select()
      .from(hallPassesTable)
      .where(eq(hallPassesTable.id, id));
    if (!existing) {
      res.status(404).json({ error: "Hall pass not found" });
      return;
    }

    const isOwn = existing.teacherName === staff.displayName;
    if (!system && !isOwn && !staff.capHallPassesViewAll) {
      res.status(403).json({
        error:
          "Ending another teacher's hall pass requires school-wide view access.",
      });
      return;
    }

    const [pass] = await db
      .update(hallPassesTable)
      .set({
        status: system ? "system_ended" : "ended",
        endedAt: new Date().toISOString(),
      })
      .where(eq(hallPassesTable.id, id))
      .returning();

    res.json(pass);
  },
);

// Edit a hall pass's start/end times. Admin-only — replaces the previous
// trivially-spoofable "(Admin)" string check with a real session check.
router.patch(
  "/hall-passes/:id",
  requireStaffMW((s) => s.isAdmin, "Admin"),
  async (req: Request, res: Response) => {
    const staff = (req as Request & { staff: StaffRow }).staff;
    const id = Number(req.params.id);
    const { endedAt, createdAt } = req.body ?? {};
    const editedBy = `${staff.displayName} (Admin)`;

    if (
      endedAt !== undefined &&
      endedAt !== null &&
      typeof endedAt !== "string"
    ) {
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
      .where(eq(hallPassesTable.id, id));

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
      .where(eq(hallPassesTable.id, id))
      .returning();

    const nowIso = new Date().toISOString();
    const edits: Array<typeof recordEditsTable.$inferInsert> = [];
    if (endedAtProvided && (existing.endedAt ?? null) !== (newEndedAt ?? null)) {
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
    if (endedAtProvided && existing.status !== newStatus) {
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
    if (
      createdAt !== undefined &&
      existing.createdAt !== (createdAt as string)
    ) {
      edits.push({
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
  },
);

// Audit log of record edits. Admin-only (was unauthenticated).
router.get(
  "/record-edits",
  requireStaffMW((s) => s.isAdmin, "Admin"),
  async (req: Request, res: Response) => {
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
  },
);

export default router;
