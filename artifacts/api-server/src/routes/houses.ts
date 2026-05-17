import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  db,
  housesTable,
  studentsTable,
  pbisEntriesTable,
  staffTable,
  studentHouseChangesTable,
  studentHouseSortJobsTable,
  parentStudentsTable,
} from "@workspace/db";
import { eq, and, gte, isNull, inArray, sql, desc } from "drizzle-orm";
import { verifyAuthToken } from "../lib/authToken.js";
import { isCoreTeam } from "../lib/coreTeam.js";
import { requireSchool } from "../lib/scope.js";

type StaffRow = typeof staffTable.$inferSelect;

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

// =============================================================================
// Bulk house placement — admin tooling.
//
// Helper: recommendNextHouse(schoolId) returns the active house with the
// fewest students, ties broken by lowest id. Used by the student-add flow
// (the "(recommended — smallest house right now)" label) and the roster
// importer when an unmapped row needs a default. Exported so other route
// files (students.ts, dataImports.ts) can share the exact same heuristic.
// =============================================================================
export async function recommendNextHouse(
  schoolId: number,
  // Optional db/tx handle. Pass the active drizzle transaction when
  // calling from a write path (e.g. roster importer commit) so the
  // count reflects uncommitted inserts and successive calls inside
  // the same chunk rotate through houses instead of all picking the
  // same "smallest" bucket.
  conn: Pick<typeof db, "select"> = db,
): Promise<number | null> {
  const houses = await conn
    .select({ id: housesTable.id })
    .from(housesTable)
    .where(eq(housesTable.schoolId, schoolId))
    .orderBy(housesTable.id);
  if (houses.length === 0) return null;
  const counts = await conn
    .select({
      houseId: studentsTable.houseId,
      count: sql<number>`COUNT(*)::int`,
    })
    .from(studentsTable)
    .where(eq(studentsTable.schoolId, schoolId))
    .groupBy(studentsTable.houseId);
  const countMap = new Map<number, number>();
  for (const r of counts) {
    if (r.houseId !== null) countMap.set(r.houseId, r.count);
  }
  let best = houses[0];
  let bestCount = countMap.get(best.id) ?? 0;
  for (const h of houses) {
    const c = countMap.get(h.id) ?? 0;
    if (c < bestCount) {
      best = h;
      bestCount = c;
    }
  }
  return best.id;
}

// Admin/SuperUser gate for the bulk + audit endpoints. Mirrors the
// inline gate used in adminStaff.ts so a future helper-extraction pass
// can sweep both at once.
//
// IMPORTANT: this only loads + role-checks the actor. The active
// school context still comes from `req.schoolId` (via requireSchool
// inside each handler), not from `staff.schoolId`. SuperUsers can
// switch their active school through the tenancy middleware; reading
// staff.schoolId would lock them to their home tenant and quietly
// operate on the wrong school. See routes/adminStaff.ts for the same
// pattern.
function requireHouseAdmin() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const id = req.staffId;
    if (!id) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    const [staff] = await db
      .select()
      .from(staffTable)
      .where(eq(staffTable.id, id));
    if (!staff || !staff.active) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    // Per spec ("same gate as Staff & Roles"): Admin / SuperUser /
    // District Admin plus Core Team (Behavior Specialist, MTSS
    // Coordinator, School Psychologist). isCoreTeam already includes
    // the admin tier.
    if (!isCoreTeam(staff)) {
      res.status(403).json({ error: "Admin or Core Team only" });
      return;
    }
    (req as Request & { staff: StaffRow }).staff = staff;
    next();
  };
}

// Compute the proposed bulk-sort assignment for `schoolId`. Pure
// function — no writes. Returns the per-student moves and the
// post-sort per-house counts so the UI can render a preview before
// commit. The same routine is invoked by /preview and /commit so the
// two stay byte-identical (commit re-runs it under the row lock to
// guard against a roster change between the two calls).
async function computeSortPlan(
  schoolId: number,
  includeAssigned: boolean,
  keepSiblings: boolean,
): Promise<{
  houses: Array<{ id: number; name: string; color: string }>;
  currentCounts: Record<number, number>;
  proposedCounts: Record<number, number>;
  moves: Array<{
    studentDbId: number;
    fromHouseId: number | null;
    toHouseId: number;
  }>;
  totalEligible: number;
  totalChanged: number;
}> {
  const houseRows = await db
    .select({
      id: housesTable.id,
      name: housesTable.name,
      color: housesTable.color,
    })
    .from(housesTable)
    .where(eq(housesTable.schoolId, schoolId))
    .orderBy(housesTable.id);
  if (houseRows.length === 0) {
    return {
      houses: [],
      currentCounts: {},
      proposedCounts: {},
      moves: [],
      totalEligible: 0,
      totalChanged: 0,
    };
  }
  const allStudents = await db
    .select({ id: studentsTable.id, houseId: studentsTable.houseId })
    .from(studentsTable)
    .where(eq(studentsTable.schoolId, schoolId));

  const currentCounts: Record<number, number> = {};
  for (const h of houseRows) currentCounts[h.id] = 0;
  for (const s of allStudents) {
    if (s.houseId !== null && currentCounts[s.houseId] !== undefined) {
      currentCounts[s.houseId] += 1;
    }
  }

  const eligible = allStudents.filter(
    (s) => includeAssigned || s.houseId === null,
  );
  // Working counts start as "rows that are NOT being moved" — these
  // anchor the buckets so the balancer fills toward parity instead
  // of double-counting students that remain in place.
  const workingCounts: Record<number, number> = {};
  for (const h of houseRows) workingCounts[h.id] = 0;
  if (includeAssigned) {
    // Every student gets re-placed, so working starts empty.
  } else {
    for (const s of allStudents) {
      if (s.houseId !== null && workingCounts[s.houseId] !== undefined) {
        workingCounts[s.houseId] += 1;
      }
    }
  }

  // Sibling groups (connected components through parent_students).
  // Two students share a group iff they share at least one parent.
  //
  // When `keepSiblings` is on, we union *all* students of the school
  // (not just the eligible set), so an unassigned new sibling of an
  // already-assigned student still ends up in the same group. The
  // group is then "pinned" to the assigned sibling's house — the
  // balancer cannot override it. This is what makes "siblings stay
  // together" actually hold for the common onboarding case of one
  // new kid joining a family that's already in House X. If two
  // already-assigned siblings disagree (e.g. legacy roster split),
  // the older/lower house id wins deterministically.
  const houseIds = houseRows.map((h) => h.id);
  const fromMap = new Map<number, number | null>(
    allStudents.map((s) => [s.id, s.houseId]),
  );
  let groups: number[][];
  const groupPin = new Map<number, number>(); // group-index → pinned houseId
  if (keepSiblings && allStudents.length > 0) {
    const allIds = allStudents.map((s) => s.id);
    const allIdSet = new Set(allIds);
    const links = await db
      .select({
        parentId: parentStudentsTable.parentId,
        studentDbId: parentStudentsTable.studentId,
      })
      .from(parentStudentsTable)
      .where(inArray(parentStudentsTable.studentId, allIds));
    const byParent = new Map<number, number[]>();
    for (const l of links) {
      if (!allIdSet.has(l.studentDbId)) continue;
      const arr = byParent.get(l.parentId) ?? [];
      arr.push(l.studentDbId);
      byParent.set(l.parentId, arr);
    }
    // Union-find over every student in the school.
    const parent = new Map<number, number>();
    const find = (x: number): number => {
      let r = x;
      while (parent.get(r)! !== r) r = parent.get(r)!;
      let cur = x;
      while (parent.get(cur)! !== r) {
        const next = parent.get(cur)!;
        parent.set(cur, r);
        cur = next;
      }
      return r;
    };
    const union = (a: number, b: number) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };
    for (const id of allIdSet) parent.set(id, id);
    for (const ids of byParent.values()) {
      for (let i = 1; i < ids.length; i++) union(ids[0], ids[i]);
    }
    // Roll up to components, but emit one group per component that
    // contains ≥1 eligible student; non-eligible siblings only
    // contribute their house id as a pin (they're not in the moves
    // output). This keeps `proposedCounts` honest for assigned rows
    // we never touch.
    const eligibleSet = new Set(eligible.map((s) => s.id));
    const compEligible = new Map<number, number[]>();
    const compAssignedHouses = new Map<number, number[]>();
    for (const s of allStudents) {
      const r = find(s.id);
      if (eligibleSet.has(s.id)) {
        const arr = compEligible.get(r) ?? [];
        arr.push(s.id);
        compEligible.set(r, arr);
      }
      if (!includeAssigned && s.houseId !== null) {
        const arr = compAssignedHouses.get(r) ?? [];
        arr.push(s.houseId);
        compAssignedHouses.set(r, arr);
      }
    }
    groups = [];
    for (const [root, ids] of compEligible) {
      const idx = groups.length;
      groups.push(ids);
      const houses = compAssignedHouses.get(root);
      if (houses && houses.length > 0) {
        // Pin to the most common assigned house; ties by smallest id.
        const tally = new Map<number, number>();
        for (const h of houses) tally.set(h, (tally.get(h) ?? 0) + 1);
        let pinHouse = houses[0];
        let pinScore = -1;
        for (const [h, c] of tally) {
          if (c > pinScore || (c === pinScore && h < pinHouse)) {
            pinHouse = h;
            pinScore = c;
          }
        }
        if (houseIds.includes(pinHouse)) groupPin.set(idx, pinHouse);
      }
    }
  } else {
    groups = eligible.map((s) => [s.id]);
  }
  // Largest groups first so they land in still-empty buckets — keeps
  // sibling families from pushing one house over by a triplet. Pinned
  // groups are sized as-is; unpinned go through the balancer.
  const indexed = groups.map((g, i) => ({ ids: g, idx: i }));
  indexed.sort((a, b) => b.ids.length - a.ids.length);

  const moves: Array<{
    studentDbId: number;
    fromHouseId: number | null;
    toHouseId: number;
  }> = [];
  for (const { ids: group, idx } of indexed) {
    let target: number;
    const pinned = groupPin.get(idx);
    if (pinned !== undefined) {
      target = pinned;
    } else {
      // Pick the bucket with the fewest working students; ties broken
      // by house id (deterministic across re-runs).
      target = houseIds[0];
      let best = workingCounts[target];
      for (const hid of houseIds) {
        const c = workingCounts[hid];
        if (c < best) {
          target = hid;
          best = c;
        }
      }
    }
    for (const sid of group) {
      const from = fromMap.get(sid) ?? null;
      moves.push({ studentDbId: sid, fromHouseId: from, toHouseId: target });
      workingCounts[target] += 1;
    }
  }
  const changed = moves.filter((m) => m.fromHouseId !== m.toHouseId);
  return {
    houses: houseRows,
    currentCounts,
    proposedCounts: workingCounts,
    moves,
    totalEligible: eligible.length,
    totalChanged: changed.length,
  };
}

function parseBulkBody(req: Request): {
  includeAssigned: boolean;
  keepSiblings: boolean;
} {
  const b = req.body ?? {};
  return {
    includeAssigned: b.includeAssigned === true,
    keepSiblings: b.keepSiblings === true,
  };
}

// POST /api/houses/sort/preview — dry run for the admin sort panel.
router.post("/houses/sort/preview", requireHouseAdmin(), async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId === null) return;
  const { includeAssigned, keepSiblings } = parseBulkBody(req);
  const plan = await computeSortPlan(
    schoolId,
    includeAssigned,
    keepSiblings,
  );
  res.json({
    ok: true,
    includeAssigned,
    keepSiblings,
    houses: plan.houses,
    currentCounts: plan.currentCounts,
    proposedCounts: plan.proposedCounts,
    totalEligible: plan.totalEligible,
    totalChanged: plan.totalChanged,
  });
});

// POST /api/houses/sort/commit — writes the proposed sort, snapshots
// the prior house_id of every changed row, and appends one audit row
// per change. Re-computes the plan inside the same call so a roster
// edit between preview and commit can't smuggle a stale assignment in.
router.post("/houses/sort/commit", requireHouseAdmin(), async (req, res) => {
  const staff = (req as Request & { staff: StaffRow }).staff;
  const schoolId = requireSchool(req, res);
  if (schoolId === null) return;
  const { includeAssigned, keepSiblings } = parseBulkBody(req);
  const plan = await computeSortPlan(
    schoolId,
    includeAssigned,
    keepSiblings,
  );
  const planChanged = plan.moves.filter((m) => m.fromHouseId !== m.toHouseId);
  if (planChanged.length === 0) {
    res.json({ ok: true, jobId: null, affectedCount: 0, message: "No changes" });
    return;
  }

  const result = await db.transaction(async (tx) => {
    // Race-guard: lock the affected student rows and re-read their
    // current houseId inside the transaction. If anything shifted
    // since the plan was computed (concurrent import, manual edit,
    // another commit), drop those rows from the change set so the
    // snapshot's fromHouseId always matches what we're actually
    // overwriting. This is what makes undo correct under load.
    const ids = planChanged.map((m) => m.studentDbId);
    const locked: Array<{ id: number; houseId: number | null }> = [];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows = await tx
        .select({ id: studentsTable.id, houseId: studentsTable.houseId })
        .from(studentsTable)
        .where(
          and(
            eq(studentsTable.schoolId, schoolId),
            inArray(studentsTable.id, chunk),
          ),
        )
        .for("update");
      locked.push(...rows);
    }
    const lockedById = new Map(locked.map((r) => [r.id, r.houseId]));
    const changed = planChanged.flatMap((m) => {
      if (!lockedById.has(m.studentDbId)) return [];
      const dbFrom = lockedById.get(m.studentDbId) ?? null;
      if (dbFrom === m.toHouseId) return []; // already in target
      return [{ ...m, fromHouseId: dbFrom }];
    });
    if (changed.length === 0) {
      return { jobId: null as number | null, affectedCount: 0 };
    }

    const [job] = await tx
      .insert(studentHouseSortJobsTable)
      .values({
        schoolId,
        committedByStaffId: staff.id,
        includeAssigned: includeAssigned ? 1 : 0,
        keepSiblings: keepSiblings ? 1 : 0,
        affectedCount: changed.length,
        snapshot: changed.map((m) => ({
          studentDbId: m.studentDbId,
          fromHouseId: m.fromHouseId,
        })),
      })
      .returning({ id: studentHouseSortJobsTable.id });

    // Batch updates per target house. School-scoped WHERE on every
    // UPDATE so a stray cross-tenant studentDbId in a hand-crafted
    // request can never escape its school.
    const byTarget = new Map<number, number[]>();
    for (const m of changed) {
      const arr = byTarget.get(m.toHouseId) ?? [];
      arr.push(m.studentDbId);
      byTarget.set(m.toHouseId, arr);
    }
    for (const [houseId, chunkIds] of byTarget) {
      for (let i = 0; i < chunkIds.length; i += 500) {
        const chunk = chunkIds.slice(i, i + 500);
        await tx
          .update(studentsTable)
          .set({ houseId })
          .where(
            and(
              eq(studentsTable.schoolId, schoolId),
              inArray(studentsTable.id, chunk),
            ),
          );
      }
    }
    // Audit rows — one per actual change. Reason is a fixed string;
    // the human accountability lives on the sort job (who, when).
    for (let i = 0; i < changed.length; i += 500) {
      const chunk = changed.slice(i, i + 500);
      await tx.insert(studentHouseChangesTable).values(
        chunk.map((m) => ({
          schoolId,
          studentDbId: m.studentDbId,
          fromHouseId: m.fromHouseId,
          toHouseId: m.toHouseId,
          reason: keepSiblings
            ? "Bulk sort (siblings kept together)"
            : "Bulk sort",
          changedByStaffId: staff.id,
          source: "bulk_sort",
          sortJobId: job.id,
        })),
      );
    }
    return { jobId: job.id as number | null, affectedCount: changed.length };
  });

  res.json({
    ok: true,
    jobId: result.jobId,
    affectedCount: result.affectedCount,
  });
});

// POST /api/houses/sort/undo/:jobId — restores prior house_id for every
// row in the sort snapshot. Only valid within 24 hours of the commit
// and only once per job. Writes audit rows tagged source='undo' so the
// trail stays append-only.
router.post(
  "/houses/sort/undo/:jobId",
  requireHouseAdmin(),
  async (req, res) => {
    const staff = (req as Request & { staff: StaffRow }).staff;
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const jobId = Number(req.params.jobId);
    if (!Number.isFinite(jobId) || jobId <= 0) {
      res.status(400).json({ error: "Invalid jobId" });
      return;
    }
    const [job] = await db
      .select()
      .from(studentHouseSortJobsTable)
      .where(
        and(
          eq(studentHouseSortJobsTable.id, jobId),
          eq(studentHouseSortJobsTable.schoolId, schoolId),
        ),
      );
    if (!job) {
      res.status(404).json({ error: "Sort job not found" });
      return;
    }
    if (job.undoneAt) {
      res.status(409).json({ error: "This sort has already been undone." });
      return;
    }
    const ageMs = Date.now() - new Date(job.committedAt).getTime();
    if (ageMs > 24 * 60 * 60_000) {
      res
        .status(409)
        .json({ error: "Undo window has closed (24 hours)." });
      return;
    }
    const snap = Array.isArray(job.snapshot) ? job.snapshot : [];

    // Race-safe one-shot: the conditional UPDATE on `undoneAt IS NULL`
    // returns the row only if WE were the writer that closed the job.
    // Two concurrent undo requests will race here; the loser sees zero
    // rows returned and gets a 409 instead of double-restoring.
    const claim = await db.transaction(async (tx) => {
      const won = await tx
        .update(studentHouseSortJobsTable)
        .set({ undoneAt: new Date(), undoneByStaffId: staff.id })
        .where(
          and(
            eq(studentHouseSortJobsTable.id, jobId),
            eq(studentHouseSortJobsTable.schoolId, schoolId),
            isNull(studentHouseSortJobsTable.undoneAt),
          ),
        )
        .returning({ id: studentHouseSortJobsTable.id });
      if (won.length === 0) return { claimed: false };

      if (snap.length === 0) return { claimed: true };

      // Group rollbacks by prior house id (including the null bucket)
      // so we can issue one UPDATE per target instead of N per row.
      const byPrior = new Map<number | null, number[]>();
      for (const row of snap) {
        const arr = byPrior.get(row.fromHouseId) ?? [];
        arr.push(row.studentDbId);
        byPrior.set(row.fromHouseId, arr);
      }
      for (const [prior, ids] of byPrior) {
        for (let i = 0; i < ids.length; i += 500) {
          const chunk = ids.slice(i, i + 500);
          await tx
            .update(studentsTable)
            .set({ houseId: prior })
            .where(
              and(
                eq(studentsTable.schoolId, schoolId),
                inArray(studentsTable.id, chunk),
              ),
            );
        }
      }
      // Audit rows — one per restore. fromHouseId on the audit row is
      // the *post-sort* value (i.e. the value being undone away from);
      // toHouseId is the restored prior value. Reads naturally in the
      // history feed as "moved back to X (undo)".
      // We need to know the post-sort target to fill that in; pull it
      // from the original audit row by sortJobId so the trail joins up.
      const originals = await tx
        .select({
          studentDbId: studentHouseChangesTable.studentDbId,
          toHouseId: studentHouseChangesTable.toHouseId,
        })
        .from(studentHouseChangesTable)
        .where(eq(studentHouseChangesTable.sortJobId, jobId));
      const postByStudent = new Map<number, number | null>(
        originals.map((o) => [o.studentDbId, o.toHouseId]),
      );
      // toHouseId on the audit table is nullable, so we can fully
      // mirror the reverse direction — including restores back to
      // "unassigned" (fromHouseId === null in the snapshot). The
      // sort job's undoneAt timestamp remains the record-of-truth
      // for the batch.
      const auditRows = snap
        .filter((row) => postByStudent.has(row.studentDbId))
        .map((row) => ({
          schoolId,
          studentDbId: row.studentDbId,
          fromHouseId: postByStudent.get(row.studentDbId) ?? null,
          toHouseId: row.fromHouseId,
          reason: "Undo bulk sort",
          changedByStaffId: staff.id,
          source: "undo" as const,
          sortJobId: jobId,
        }));
      for (let i = 0; i < auditRows.length; i += 500) {
        const chunk = auditRows.slice(i, i + 500);
        if (chunk.length > 0) await tx.insert(studentHouseChangesTable).values(chunk);
      }
      return { claimed: true };
    });

    if (!claim.claimed) {
      res.status(409).json({ error: "This sort has already been undone." });
      return;
    }
    res.json({ ok: true, restored: snap.length });
  },
);

// GET /api/houses/changes — append-only audit feed for the Houses
// settings "Recent changes" tab. Returns the 200 most recent rows
// joined with student + house display fields so the UI can render in
// one pass. Optional ?houseId= filter narrows to a single bucket.
router.get("/houses/changes", requireHouseAdmin(), async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId === null) return;
  const houseFilterRaw = req.query.houseId;
  const houseFilter = Number(
    Array.isArray(houseFilterRaw) ? houseFilterRaw[0] : houseFilterRaw,
  );
  const conds = [eq(studentHouseChangesTable.schoolId, schoolId)];
  if (Number.isFinite(houseFilter) && houseFilter > 0) {
    conds.push(eq(studentHouseChangesTable.toHouseId, houseFilter));
  }
  const rows = await db
    .select({
      id: studentHouseChangesTable.id,
      studentDbId: studentHouseChangesTable.studentDbId,
      fromHouseId: studentHouseChangesTable.fromHouseId,
      toHouseId: studentHouseChangesTable.toHouseId,
      reason: studentHouseChangesTable.reason,
      source: studentHouseChangesTable.source,
      sortJobId: studentHouseChangesTable.sortJobId,
      changedAt: studentHouseChangesTable.changedAt,
      changedByStaffId: studentHouseChangesTable.changedByStaffId,
    })
    .from(studentHouseChangesTable)
    .where(and(...conds))
    .orderBy(desc(studentHouseChangesTable.changedAt))
    .limit(200);

  if (rows.length === 0) {
    res.json({ rows: [], houses: [], staff: [], students: [] });
    return;
  }
  const studentIds = [...new Set(rows.map((r) => r.studentDbId))];
  const houseIds = [
    ...new Set(
      rows.flatMap((r) =>
        [r.fromHouseId, r.toHouseId].filter((x): x is number => x !== null),
      ),
    ),
  ];
  const staffIds = [...new Set(rows.map((r) => r.changedByStaffId))];

  const [studentRows, houseRows, staffRows, latestJob] = await Promise.all([
    db
      .select({
        id: studentsTable.id,
        studentId: studentsTable.studentId,
        firstName: studentsTable.firstName,
        lastName: studentsTable.lastName,
      })
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.schoolId, schoolId),
          inArray(studentsTable.id, studentIds),
        ),
      ),
    houseIds.length > 0
      ? db
          .select({
            id: housesTable.id,
            name: housesTable.name,
            color: housesTable.color,
          })
          .from(housesTable)
          .where(
            and(
              eq(housesTable.schoolId, schoolId),
              inArray(housesTable.id, houseIds),
            ),
          )
      : Promise.resolve([] as Array<{ id: number; name: string; color: string }>),
    db
      .select({
        id: staffTable.id,
        displayName: staffTable.displayName,
      })
      .from(staffTable)
      .where(
        and(
          eq(staffTable.schoolId, schoolId),
          inArray(staffTable.id, staffIds),
        ),
      ),
    // Surface the most recent undo-eligible job so the panel can show
    // a single, top-of-page "Undo last sort" button rather than per-row.
    db
      .select()
      .from(studentHouseSortJobsTable)
      .where(
        and(
          eq(studentHouseSortJobsTable.schoolId, schoolId),
          isNull(studentHouseSortJobsTable.undoneAt),
        ),
      )
      .orderBy(desc(studentHouseSortJobsTable.committedAt))
      .limit(1),
  ]);

  const latest = latestJob[0] ?? null;
  let undoable: {
    jobId: number;
    committedAt: string;
    affectedCount: number;
    expiresAt: string;
  } | null = null;
  if (latest) {
    const committed = new Date(latest.committedAt).getTime();
    const expires = committed + 24 * 60 * 60_000;
    if (Date.now() < expires) {
      undoable = {
        jobId: latest.id,
        committedAt: new Date(latest.committedAt).toISOString(),
        affectedCount: latest.affectedCount,
        expiresAt: new Date(expires).toISOString(),
      };
    }
  }

  res.json({
    rows: rows.map((r) => ({
      ...r,
      changedAt:
        r.changedAt instanceof Date ? r.changedAt.toISOString() : r.changedAt,
    })),
    houses: houseRows,
    staff: staffRows,
    students: studentRows,
    undoable,
  });
});

export default router;
