import { Router, type IRouter } from "express";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import {
  db,
  studentsTable,
  pbisEntriesTable,
  tardiesTable,
  studentAttendanceDayTable,
  housesTable,
  schoolStoreItemsTable,
} from "@workspace/db";
import { verifyStudentAuthToken } from "../lib/authToken.js";
import { isFeatureEnabled } from "../lib/featureLicensing.js";
import { streamObjectToResponse } from "./storage.js";
import {
  buildStudentStoreView,
  computeWallet,
  redeemItem,
  type RedeemErrorCode,
} from "../lib/storeRedemptions.js";

// -----------------------------------------------------------------------------
// Student HeartBEAT portal — personal data + School Store self-redeem.
//
// Identity: req.studentId (NUMERIC students.id) from the session OR a
// student-kind bearer token (the Replit preview iframe blocks session
// cookies, so the client also sends a Bearer token — same pattern as the
// parent portal). EVERY query is school-scoped from the student's own row;
// the FLEID (students.student_id) is used only as an internal join key and
// is NEVER serialized — surfaces carry localSisId only.
//
// Self-redeem REUSES the existing redemption engine (redeemItem) with a
// `{type:"student"}` actor, so student redemptions land in the SAME
// school_store_redemptions ledger the Core Team fulfills and families see.
// -----------------------------------------------------------------------------

const router: IRouter = Router();

router.use(async (req, _res, next) => {
  let sid: number | null = req.session.studentId ?? null;
  if (!sid) {
    const auth = req.headers.authorization;
    if (typeof auth === "string" && auth.startsWith("Bearer ")) {
      sid = verifyStudentAuthToken(auth.slice(7).trim());
    }
  }
  req.studentId = sid;
  next();
});

// Resolve the signed-in student's identifying fields (FLEID stays server-side).
async function resolveStudent(studentRowId: number): Promise<{
  studentId: string;
  schoolId: number;
  localSisId: string | null;
  firstName: string;
  lastName: string;
  grade: number;
  houseId: number | null;
} | null> {
  const [row] = await db
    .select({
      studentId: studentsTable.studentId,
      schoolId: studentsTable.schoolId,
      localSisId: studentsTable.localSisId,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
      grade: studentsTable.grade,
      houseId: studentsTable.houseId,
    })
    .from(studentsTable)
    .where(eq(studentsTable.id, studentRowId))
    .limit(1);
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

// Start of the current school year (Aug 1) as a local YYYY-MM-DD string. Used
// to window YTD attendance/tardy/points totals consistently (the project
// convention is local date strings — see the timezone gotcha in replit.md).
function schoolYearStartDay(): string {
  const now = new Date();
  const year = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
  return `${year}-08-01`;
}

// Monday (local) of the current week as a YYYY-MM-DD string, for "this week"
// point tallies.
function startOfWeekDay(): string {
  const now = new Date();
  const dow = now.getDay(); // 0=Sun
  const diff = dow === 0 ? 6 : dow - 1;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diff);
  const y = monday.getFullYear();
  const m = String(monday.getMonth() + 1).padStart(2, "0");
  const d = String(monday.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// GET /api/student/snapshot — the signed-in student's personal HeartBEAT.
router.get("/student/snapshot", async (req, res) => {
  const sid = req.studentId;
  if (!sid) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const student = await resolveStudent(sid);
  if (!student) {
    res.status(404).json({ error: "Student not found" });
    return;
  }
  const { studentId, schoolId } = student;
  const weekStart = startOfWeekDay();
  const yearStart = schoolYearStartDay();

  // Wallet (lifetime earned vs available) — reuse the engine so the number
  // matches the store + Teacher Roster + parent portal exactly.
  const wallet = await computeWallet(schoolId, studentId);

  const [
    weekPointsRow,
    byTeacherRows,
    polarityRows,
    recentRecognitions,
    tardyRow,
    attendanceRows,
    house,
  ] = await Promise.all([
    // This week's net points.
    db
      .select({
        total: sql<number>`coalesce(sum(${pbisEntriesTable.points}), 0)::int`,
      })
      .from(pbisEntriesTable)
      .where(
        and(
          eq(pbisEntriesTable.schoolId, schoolId),
          eq(pbisEntriesTable.studentId, studentId),
          sql`${pbisEntriesTable.voidedAt} IS NULL`,
          gte(pbisEntriesTable.createdAt, weekStart),
        ),
      ),
    // Points by teacher (non-voided, lifetime). staffName is the snapshot
    // recorded at award time.
    db
      .select({
        staffName: pbisEntriesTable.staffName,
        points: sql<number>`coalesce(sum(${pbisEntriesTable.points}), 0)::int`,
        count: sql<number>`count(*)::int`,
      })
      .from(pbisEntriesTable)
      .where(
        and(
          eq(pbisEntriesTable.schoolId, schoolId),
          eq(pbisEntriesTable.studentId, studentId),
          sql`${pbisEntriesTable.voidedAt} IS NULL`,
        ),
      )
      .groupBy(pbisEntriesTable.staffName)
      .orderBy(sql`2 desc`),
    // Positive vs negative counts (lifetime, non-voided).
    db
      .select({
        polarity: pbisEntriesTable.polarity,
        count: sql<number>`count(*)::int`,
      })
      .from(pbisEntriesTable)
      .where(
        and(
          eq(pbisEntriesTable.schoolId, schoolId),
          eq(pbisEntriesTable.studentId, studentId),
          sql`${pbisEntriesTable.voidedAt} IS NULL`,
        ),
      )
      .groupBy(pbisEntriesTable.polarity),
    // Recent recognitions (non-voided), newest first.
    db
      .select({
        reason: pbisEntriesTable.reason,
        points: pbisEntriesTable.points,
        staffName: pbisEntriesTable.staffName,
        polarity: pbisEntriesTable.polarity,
        note: pbisEntriesTable.note,
        createdAt: pbisEntriesTable.createdAt,
      })
      .from(pbisEntriesTable)
      .where(
        and(
          eq(pbisEntriesTable.schoolId, schoolId),
          eq(pbisEntriesTable.studentId, studentId),
          sql`${pbisEntriesTable.voidedAt} IS NULL`,
        ),
      )
      .orderBy(desc(pbisEntriesTable.createdAt))
      .limit(15),
    // Tardies YTD.
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(tardiesTable)
      .where(
        and(
          eq(tardiesTable.schoolId, schoolId),
          eq(tardiesTable.studentId, studentId),
          gte(tardiesTable.createdAt, yearStart),
        ),
      ),
    // Attendance days YTD, grouped by status (present|tardy|excused|unexcused).
    db
      .select({
        status: studentAttendanceDayTable.status,
        count: sql<number>`count(*)::int`,
      })
      .from(studentAttendanceDayTable)
      .where(
        and(
          eq(studentAttendanceDayTable.schoolId, schoolId),
          eq(studentAttendanceDayTable.studentId, studentId),
          gte(studentAttendanceDayTable.day, yearStart),
        ),
      )
      .groupBy(studentAttendanceDayTable.status),
    // House (optional).
    student.houseId
      ? db
          .select({
            name: housesTable.name,
            color: housesTable.color,
          })
          .from(housesTable)
          .where(
            and(
              eq(housesTable.id, student.houseId),
              eq(housesTable.schoolId, schoolId),
            ),
          )
          .limit(1)
          .then((r) => r[0] ?? null)
      : Promise.resolve(null),
  ]);

  let positive = 0;
  let negative = 0;
  for (const r of polarityRows) {
    if (r.polarity === "negative") negative = r.count;
    else positive += r.count;
  }

  // Attendance %: present + tardy count as "in attendance" (matches FLDOE +
  // the parent snapshot). null when no days are logged yet.
  let presentDays = 0;
  let totalDays = 0;
  let absences = 0;
  for (const r of attendanceRows) {
    totalDays += r.count;
    if (r.status === "present" || r.status === "tardy") presentDays += r.count;
    if (r.status === "excused" || r.status === "unexcused") absences += r.count;
  }
  const attendancePct =
    totalDays > 0 ? Math.round((presentDays / totalDays) * 100) : null;

  res.json({
    student: {
      localSisId: student.localSisId,
      firstName: student.firstName,
      lastName: student.lastName,
      grade: student.grade,
    },
    points: {
      lifetimeEarned: wallet.earned,
      available: wallet.available,
      spent: wallet.spent,
      thisWeek: weekPointsRow[0]?.total ?? 0,
      positiveCount: positive,
      negativeCount: negative,
      byTeacher: byTeacherRows,
    },
    recentRecognitions,
    attendance: {
      pct: attendancePct,
      presentDays,
      totalDays,
      absences,
      tardiesYtd: tardyRow[0]?.count ?? 0,
    },
    house,
  });
});

// GET /api/student/store — the student's own School Store view (wallet +
// catalog + their orders). Returns enabled:false when the school doesn't
// license the feature, so the client hides the tab gracefully.
router.get("/student/store", async (req, res) => {
  const sid = req.studentId;
  if (!sid) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const student = await resolveStudent(sid);
  if (!student) {
    res.status(404).json({ error: "Student not found" });
    return;
  }
  const enabled = await isFeatureEnabled(req, student.schoolId, "schoolStore");
  if (!enabled) {
    res.json({
      enabled: false,
      wallet: { earned: 0, spent: 0, available: 0 },
      items: [],
      orders: [],
    });
    return;
  }
  const view = await buildStudentStoreView(student.schoolId, student.studentId);
  res.json({ enabled: true, ...view });
});

// POST /api/student/store/redeem  { itemId }
// Student self-redeem. Reuses redeemItem with a `student` actor; the engine
// atomically re-validates affordability/stock/limit and files a
// pending_approval request when the item requires approval. requested_by_id
// is null for students (the studentId column identifies them) per schema.
router.post("/student/store/redeem", async (req, res) => {
  const sid = req.studentId;
  if (!sid) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const student = await resolveStudent(sid);
  if (!student) {
    res.status(404).json({ error: "Student not found" });
    return;
  }
  const itemId = Number((req.body ?? {}).itemId);
  if (!Number.isFinite(itemId)) {
    res.status(400).json({ error: "itemId is required" });
    return;
  }
  const enabled = await isFeatureEnabled(req, student.schoolId, "schoolStore");
  if (!enabled) {
    res.status(403).json({ error: "School Store is not available" });
    return;
  }
  const result = await redeemItem({
    schoolId: student.schoolId,
    studentId: student.studentId,
    itemId,
    actor: { type: "student", id: null },
  });
  if (!result.ok) {
    res
      .status(redeemErrorStatus(result.code))
      .json({ error: result.message, code: result.code });
    return;
  }
  // Never leak the FLEID — return localSisId on the redemption row.
  const { studentId: _fleid, ...rest } = result.redemption;
  const wallet = await computeWallet(student.schoolId, student.studentId);
  res.json({
    redemption: { ...rest, localSisId: student.localSisId },
    wallet,
  });
});

// GET /api/student/store/item/:itemId/image — student-authed thumbnail proxy,
// school-scoped to the signed-in student's school. FLEID never involved.
router.get("/student/store/item/:itemId/image", async (req, res) => {
  const sid = req.studentId;
  if (!sid) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const student = await resolveStudent(sid);
  if (!student) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const itemId = Number(req.params.itemId);
  if (!Number.isFinite(itemId)) {
    res.status(400).json({ error: "Not found" });
    return;
  }
  const [item] = await db
    .select({ imageUrl: schoolStoreItemsTable.imageUrl })
    .from(schoolStoreItemsTable)
    .where(
      and(
        eq(schoolStoreItemsTable.id, itemId),
        eq(schoolStoreItemsTable.schoolId, student.schoolId),
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
