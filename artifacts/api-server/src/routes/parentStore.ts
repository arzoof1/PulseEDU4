import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import {
  db,
  parentStudentsTable,
  studentsTable,
  schoolStoreItemsTable,
} from "@workspace/db";
import { verifyParentAuthToken } from "../lib/authToken.js";
import { isFeatureEnabled } from "../lib/featureLicensing.js";
import { streamObjectToResponse } from "./storage.js";
import {
  buildStudentStoreView,
  computeWallet,
  redeemItem,
  type RedeemErrorCode,
} from "../lib/storeRedemptions.js";

const router: IRouter = Router();

// Parent identity middleware — mirrors parentSnapshot.ts. Resolves the parent
// from the session OR a Bearer token (the preview iframe falls back to the
// token because the session cookie is blocked inside it).
router.use(async (req, _res, next) => {
  let pid: number | null = req.session.parentId ?? null;
  if (!pid) {
    const auth = req.headers.authorization;
    if (typeof auth === "string" && auth.startsWith("Bearer ")) {
      pid = verifyParentAuthToken(auth.slice(7).trim());
    }
  }
  req.parentId = pid;
  next();
});

// Resolve a parent-owned student. The client passes the NUMERIC students.id
// row id (same value as ParentMe.students[].id / the snapshot's studentId
// query param) — NOT the FLEID. We join parent_students → students so the
// lookup both (a) proves the parent owns this student and (b) yields the
// FLEID + schoolId + localSisId. Returning null = not owned (treated as 404),
// which keeps the FLEID and another family's student invisible.
async function resolveOwnedStudent(
  parentId: number,
  studentRowId: number,
): Promise<{
  studentId: string;
  schoolId: number;
  localSisId: string | null;
} | null> {
  const [row] = await db
    .select({
      studentId: studentsTable.studentId,
      schoolId: studentsTable.schoolId,
      localSisId: studentsTable.localSisId,
    })
    .from(parentStudentsTable)
    .innerJoin(studentsTable, eq(parentStudentsTable.studentId, studentsTable.id))
    .where(
      and(
        eq(parentStudentsTable.parentId, parentId),
        eq(parentStudentsTable.studentId, studentRowId),
      ),
    );
  return row ?? null;
}

function redeemErrorStatus(code: RedeemErrorCode): number {
  switch (code) {
    case "not_found":
      return 404;
    case "insufficient_points":
    case "out_of_stock":
    case "limit_reached":
    case "archived":
    case "invalid_state":
      return 409;
    default:
      return 400;
  }
}

// GET /api/parent/store?studentId=<rowId>
// Returns the per-student store view (wallet + catalog + orders). When the
// school doesn't license the School Store feature we return `enabled: false`
// (instead of a hard 404) so the client can hide the Rewards tab gracefully.
router.get("/parent/store", async (req, res) => {
  const pid = req.parentId;
  if (!pid) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const studentRowId = Number(req.query.studentId);
  if (!Number.isFinite(studentRowId)) {
    res.status(400).json({ error: "studentId is required" });
    return;
  }
  const owned = await resolveOwnedStudent(pid, studentRowId);
  if (!owned) {
    res.status(404).json({ error: "Student not found" });
    return;
  }
  const enabled = await isFeatureEnabled(req, owned.schoolId, "schoolStore");
  if (!enabled) {
    res.json({
      enabled: false,
      wallet: { earned: 0, spent: 0, available: 0 },
      items: [],
      orders: [],
    });
    return;
  }
  const view = await buildStudentStoreView(owned.schoolId, owned.studentId);
  res.json({ enabled: true, ...view });
});

// POST /api/parent/store/redeem  { studentId: <rowId>, itemId }
// Redeems on the student's behalf as a `parent` actor. The engine deducts
// points (or files a pending_approval request) atomically and re-validates
// stock/limit/affordability, so a stale client can't over-spend.
router.post("/parent/store/redeem", async (req, res) => {
  const pid = req.parentId;
  if (!pid) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const body = (req.body ?? {}) as { studentId?: unknown; itemId?: unknown };
  const studentRowId = Number(body.studentId);
  const itemId = Number(body.itemId);
  if (!Number.isFinite(studentRowId) || !Number.isFinite(itemId)) {
    res.status(400).json({ error: "studentId and itemId are required" });
    return;
  }
  const owned = await resolveOwnedStudent(pid, studentRowId);
  if (!owned) {
    res.status(404).json({ error: "Student not found" });
    return;
  }
  const enabled = await isFeatureEnabled(req, owned.schoolId, "schoolStore");
  if (!enabled) {
    res.status(403).json({ error: "School Store is not available" });
    return;
  }
  const result = await redeemItem({
    schoolId: owned.schoolId,
    studentId: owned.studentId,
    itemId,
    actor: { type: "parent", id: pid },
  });
  if (!result.ok) {
    res
      .status(redeemErrorStatus(result.code))
      .json({ error: result.message, code: result.code });
    return;
  }
  // Strip the FLEID off the redemption row before it leaves the server — the
  // family only ever sees the local SIS id.
  const { studentId: _fleid, ...rest } = result.redemption;
  const wallet = await computeWallet(owned.schoolId, owned.studentId);
  res.json({
    redemption: { ...rest, localSisId: owned.localSisId },
    wallet,
  });
});

// GET /api/parent/store/item/:itemId/image?studentId=<rowId>
// Parent-authed thumbnail proxy. Staff read object storage via a staff-only
// route the parent can't use; here we re-authorize by (a) proving the parent
// owns a student and (b) loading the item school-scoped to that student's
// school, then stream its stored thumbnail. The FLEID is never involved.
router.get("/parent/store/item/:itemId/image", async (req, res) => {
  const pid = req.parentId;
  if (!pid) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const studentRowId = Number(req.query.studentId);
  const itemId = Number(req.params.itemId);
  if (!Number.isFinite(studentRowId) || !Number.isFinite(itemId)) {
    res.status(400).json({ error: "studentId and itemId are required" });
    return;
  }
  const owned = await resolveOwnedStudent(pid, studentRowId);
  if (!owned) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const [item] = await db
    .select({ imageUrl: schoolStoreItemsTable.imageUrl })
    .from(schoolStoreItemsTable)
    .where(
      and(
        eq(schoolStoreItemsTable.id, itemId),
        eq(schoolStoreItemsTable.schoolId, owned.schoolId),
      ),
    );
  if (!item || !item.imageUrl) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  try {
    const ok = await streamObjectToResponse(item.imageUrl, res);
    if (!ok) res.status(404).json({ error: "Not found" });
  } catch {
    res.status(500).json({ error: "Failed to read image" });
  }
});

export default router;
