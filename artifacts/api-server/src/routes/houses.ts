import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  housesTable,
  studentsTable,
  pbisEntriesTable,
  staffTable,
} from "@workspace/db";
import { eq, and, gte, isNull, inArray, sql } from "drizzle-orm";
import { verifyAuthToken } from "../lib/authToken.js";

// =============================================================================
// HOUSES — PBIS team standings for the houses signage screen.
// -----------------------------------------------------------------------------
// Same auth model as /api/pulse: signed-in staff use req.schoolId; signage
// kiosks pass `?schoolId=N`. See SECURITY NOTE in routes/pulse.ts.
// =============================================================================

const router: IRouter = Router();

function resolveSchoolId(req: Request, res: Response): number | null {
  if (req.schoolId) return req.schoolId;
  const raw = req.query.schoolId;
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isFinite(n) || n <= 0) {
    res.status(400).json({ error: "schoolId required (sign in or pass ?schoolId=N)" });
    return null;
  }
  return n;
}

// GET /api/houses?schoolId=N&windowDays=7
// Returns each house with: memberCount, totalPoints (all-time, non-voided),
// weekPoints, positiveCount, negativeCount (within the window).
router.get("/houses", async (req, res) => {
  const schoolId = resolveSchoolId(req, res);
  if (schoolId === null) return;

  const rawDays = Number(req.query.windowDays);
  const windowDays = Number.isFinite(rawDays) && rawDays > 0 ? Math.min(Math.floor(rawDays), 90) : 7;
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60_000);

  try {
    const houses = await db
      .select()
      .from(housesTable)
      .where(eq(housesTable.schoolId, schoolId));

    if (houses.length === 0) {
      res.json({ schoolId, windowDays, houses: [] });
      return;
    }

    // Member counts grouped by house.
    const memberRows = await db
      .select({
        houseId: studentsTable.houseId,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(studentsTable)
      .where(eq(studentsTable.schoolId, schoolId))
      .groupBy(studentsTable.houseId);
    const memberCountByHouse = new Map<number, number>();
    for (const r of memberRows) {
      if (r.houseId !== null) memberCountByHouse.set(r.houseId, r.count);
    }

    // Per-house aggregates over PBIS entries: join via student.house_id.
    // We do this in one query per house so we can use Drizzle's typed
    // builder cleanly; with 4 houses per school the cost is negligible.
    const enriched = await Promise.all(
      houses.map(async (h: typeof houses[number]) => {
        const studentRows = await db
          .select({ studentId: studentsTable.studentId })
          .from(studentsTable)
          .where(and(eq(studentsTable.schoolId, schoolId), eq(studentsTable.houseId, h.id)));
        const studentIds = studentRows.map((r: { studentId: string }) => r.studentId);

        if (studentIds.length === 0) {
          return {
            id: h.id,
            name: h.name,
            color: h.color,
            motto: h.motto,
            iconKey: h.iconKey,
            memberCount: 0,
            totalPoints: 0,
            weekPoints: 0,
            positiveCount: 0,
            negativeCount: 0,
          };
        }

        const [allRows, weekRows] = await Promise.all([
          db
            .select({
              points: sql<number>`COALESCE(SUM(${pbisEntriesTable.points}), 0)::int`,
            })
            .from(pbisEntriesTable)
            .where(
              and(
                eq(pbisEntriesTable.schoolId, schoolId),
                inArray(pbisEntriesTable.studentId, studentIds),
                isNull(pbisEntriesTable.voidedAt),
              ),
            ),
          db
            .select({
              polarity: pbisEntriesTable.polarity,
              points: sql<number>`COALESCE(SUM(${pbisEntriesTable.points}), 0)::int`,
              n: sql<number>`COUNT(*)::int`,
            })
            .from(pbisEntriesTable)
            .where(
              and(
                eq(pbisEntriesTable.schoolId, schoolId),
                inArray(pbisEntriesTable.studentId, studentIds),
                isNull(pbisEntriesTable.voidedAt),
                gte(pbisEntriesTable.createdAt, since.toISOString()),
              ),
            )
            .groupBy(pbisEntriesTable.polarity),
        ]);

        let positiveCount = 0;
        let negativeCount = 0;
        let weekPoints = 0;
        for (const w of weekRows) {
          if (w.polarity === "positive") {
            positiveCount = w.n;
            weekPoints += w.points;
          } else if (w.polarity === "negative") {
            negativeCount = w.n;
            weekPoints -= Math.abs(w.points);
          }
        }

        return {
          id: h.id,
          name: h.name,
          color: h.color,
          motto: h.motto,
          iconKey: h.iconKey,
          memberCount: memberCountByHouse.get(h.id) ?? studentIds.length,
          totalPoints: allRows[0]?.points ?? 0,
          weekPoints,
          positiveCount,
          negativeCount,
        };
      }),
    );

    res.json({ schoolId, windowDays, houses: enriched });
  } catch (_err) {
    // Avoid leaking SQL/stack to anonymous callers.
    res.status(500).json({ error: "Failed to load houses" });
  }
});

// GET /api/houses/with-staff-counts
// Admin endpoint used by the Staff & Roles house picker. For every
// house in the *authenticated staff member's* school, returns its
// student count + assigned-staff count so admins can pick the smallest
// house when assigning a new staff member.
//
// Auth: we deliberately do NOT use the signage-friendly resolveSchoolId
// fallback (which would accept `?schoolId=N` from unauthenticated
// signage kiosks). Staffing distribution is internal data, so this
// route requires a real authenticated staff session and ignores any
// `?schoolId=` query parameter — the school is always taken from the
// staff record. Anyone signed in to the app may call it (the picker
// only renders for admins, but counts themselves aren't restricted
// beyond "must be a staff member of this school").
router.get("/houses/with-staff-counts", async (req, res) => {
  let staffId = req.staffId ?? null;
  if (!staffId) {
    const auth = req.headers.authorization;
    if (typeof auth === "string" && auth.startsWith("Bearer ")) {
      staffId = verifyAuthToken(auth.slice(7).trim());
    }
  }
  if (!staffId) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const [me] = await db
    .select({ schoolId: staffTable.schoolId, active: staffTable.active })
    .from(staffTable)
    .where(eq(staffTable.id, staffId));
  if (!me || !me.active) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const schoolId = me.schoolId;
  try {
    const houses = await db
      .select()
      .from(housesTable)
      .where(eq(housesTable.schoolId, schoolId));
    if (houses.length === 0) {
      res.json({ schoolId, houses: [] });
      return;
    }
    const [studentRows, staffRows] = await Promise.all([
      db
        .select({
          houseId: studentsTable.houseId,
          count: sql<number>`COUNT(*)::int`,
        })
        .from(studentsTable)
        .where(eq(studentsTable.schoolId, schoolId))
        .groupBy(studentsTable.houseId),
      db
        .select({
          houseId: staffTable.houseId,
          count: sql<number>`COUNT(*)::int`,
        })
        .from(staffTable)
        .where(
          and(eq(staffTable.schoolId, schoolId), eq(staffTable.active, true)),
        )
        .groupBy(staffTable.houseId),
    ]);
    const studentCounts = new Map<number, number>();
    for (const r of studentRows) {
      if (r.houseId !== null) studentCounts.set(r.houseId, r.count);
    }
    const staffCounts = new Map<number, number>();
    for (const r of staffRows) {
      if (r.houseId !== null) staffCounts.set(r.houseId, r.count);
    }
    res.json({
      schoolId,
      houses: houses.map((h: typeof houses[number]) => ({
        id: h.id,
        name: h.name,
        color: h.color,
        iconKey: h.iconKey,
        studentCount: studentCounts.get(h.id) ?? 0,
        staffCount: staffCounts.get(h.id) ?? 0,
      })),
    });
  } catch (_err) {
    res.status(500).json({ error: "Failed to load houses" });
  }
});

export default router;
