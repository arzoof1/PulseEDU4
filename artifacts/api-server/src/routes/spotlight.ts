import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { randomInt } from "node:crypto";
import {
  db,
  spotlightPromptsTable,
  spotlightHistoryTable,
  staffTable,
  studentsTable,
  housesTable,
  pbisEntriesTable,
  pbisReasonsTable,
} from "@workspace/db";
import { and, eq, asc, desc, inArray, sql, isNull } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import { SPOTLIGHT_PBIS_REASON_NAME } from "../seed.js";

const router: IRouter = Router();

// How many of a teacher's most recent picks are excluded from the next
// pick. Keeps a teacher's class from drawing the same kid back-to-back
// while still allowing the rotation to wrap when the candidate pool is
// small.
const NO_REPEAT_WINDOW = 10;

// Time-based cooldown: a student picked within the last N minutes by THIS
// teacher won't be re-picked. Layered on top of NO_REPEAT_WINDOW because a
// count-only rule fails in small classes where the same 10 picks cycle in
// under a minute. Best-effort — we relax this rule before we'd 409, so a
// teacher in a tiny class isn't told "nobody to pick".
const COOLDOWN_MINUTES = 5;

// Maximum prompt cards a school can keep around. Soft cap to prevent the
// rotation from becoming meaningless.
const MAX_PROMPTS_PER_SCHOOL = 200;

// Default seed prompts inserted on first GET if the school has none. Keeps
// the empty state useful so a brand-new admin doesn't see "no prompts" and
// bounce.
const SEED_PROMPTS = [
  "Share one thing you're proud of from this week.",
  "What's a goal you're working on right now?",
  "Teach the class one fun fact you know.",
  "Name one person who helped you this week and why.",
  "What's a question you've been wondering about?",
  "Describe yourself using only three words.",
];

async function requireStaff(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const staffId = req.staffId;
  if (!staffId) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const [staff] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, staffId));
  if (!staff || !staff.active) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  (req as Request & { staff: typeof staff }).staff = staff;
  next();
}

function isAdmin(staff: typeof staffTable.$inferSelect): boolean {
  return Boolean(staff.isAdmin || staff.isSuperUser || staff.isDistrictAdmin);
}

// ---------------------------------------------------------------------------
// Hidden runaway-leader governor (server-side, invisible to all clients)
// ---------------------------------------------------------------------------
//
// Tiered "rubber-band" governor.
// ---------------------------------------------------------------------------
// When the leading house is more than RUNAWAY_LEADER_THRESHOLD points
// ahead of the runner-up, Spotlight switches from the open 1..10 pool
// to per-rank pools that quietly help trailing houses catch up:
//   - top quartile  → {1, 2, 3}   (small adds for the leader)
//   - upper-middle  → {2, 4, 6}
//   - lower-middle  → {4, 6, 8}
//   - bottom quart. → {6, 8, 10}  (max catch-up for the laggards)
// The point value the teacher SEES is the point value that hits the DB —
// no phantom "chosen vs awarded" mismatch. Students just appear to get
// "harder" or "easier" questions depending on their house's standing.
//
// Threshold uses leader-vs-#2 so the rebalancer turns OFF as soon as
// the race is close again, instead of getting stuck because the
// last-place house is permanently far behind.
const RUNAWAY_LEADER_THRESHOLD = 1500;

// Open pool used when the race is healthy (gap ≤ threshold).
const SPOTLIGHT_OPEN_POOL = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
// Rebalanced pools by quartile rank — index 0 = top, 3 = bottom.
const SPOTLIGHT_TIERED_POOLS: ReadonlyArray<readonly number[]> = [
  [1, 2, 3],
  [2, 4, 6],
  [4, 6, 8],
  [6, 8, 10],
];

interface HouseTotalRow {
  id: number;
  totalPoints: number;
}

// Compute every house's all-time positive PBIS total in this school.
// Used by /pick (to detect the capped house) and /award (to re-enforce
// the cap at write time so a tampered client can't bypass it).
async function computeHouseTotalsForCap(
  schoolId: number,
): Promise<HouseTotalRow[]> {
  const houses = await db
    .select({ id: housesTable.id })
    .from(housesTable)
    .where(eq(housesTable.schoolId, schoolId));
  return Promise.all(
    houses.map(async (h) => {
      const memberRows = await db
        .select({ studentId: studentsTable.studentId })
        .from(studentsTable)
        .where(
          and(
            eq(studentsTable.schoolId, schoolId),
            eq(studentsTable.houseId, h.id),
          ),
        );
      const memberIds = memberRows.map((m) => m.studentId);
      let totalPoints = 0;
      if (memberIds.length > 0) {
        const [agg] = await db
          .select({
            points: sql<number>`COALESCE(SUM(${pbisEntriesTable.points}), 0)::int`,
          })
          .from(pbisEntriesTable)
          .where(
            and(
              eq(pbisEntriesTable.schoolId, schoolId),
              inArray(pbisEntriesTable.studentId, memberIds),
              isNull(pbisEntriesTable.voidedAt),
            ),
          );
        totalPoints = agg?.points ?? 0;
      }
      return { id: h.id, totalPoints };
    }),
  );
}

// True iff the leader is currently >RUNAWAY_LEADER_THRESHOLD points
// ahead of the runner-up. When true, /pick + /award switch from the
// open 1..10 pool to the per-rank tiered pools.
function isRebalancerActive(totals: HouseTotalRow[]): boolean {
  if (totals.length < 2) return false;
  const sorted = [...totals].sort((a, b) => b.totalPoints - a.totalPoints);
  return (
    sorted[0].totalPoints - sorted[1].totalPoints > RUNAWAY_LEADER_THRESHOLD
  );
}

// Maps a house id to its tiered pool given the field's standings.
// Quartile-based so this works for any house count (3-house schools
// collapse to {top, lower-mid, bottom}; 5+ house schools double-up
// neighbouring ranks into the same quartile bucket — no gaps either way).
// Returns the OPEN pool when the rebalancer is inactive.
function poolForHouse(
  houseId: number,
  totals: HouseTotalRow[],
): readonly number[] {
  if (!isRebalancerActive(totals)) return SPOTLIGHT_OPEN_POOL;
  const sorted = [...totals].sort((a, b) => b.totalPoints - a.totalPoints);
  const rank = sorted.findIndex((t) => t.id === houseId);
  if (rank < 0) return SPOTLIGHT_OPEN_POOL; // unknown house — fail-open
  const denom = Math.max(1, sorted.length - 1);
  const percentile = rank / denom; // 0 = leader, 1 = last
  let bucket: number;
  if (percentile < 0.25) bucket = 0;
  else if (percentile < 0.5) bucket = 1;
  else if (percentile < 0.75) bucket = 2;
  else bucket = 3;
  return SPOTLIGHT_TIERED_POOLS[bucket];
}

function pickFromPool(pool: readonly number[]): number {
  return pool[randomInt(0, pool.length)];
}

// Exported for the verification script — keeps the test surface tiny.
export const __spotlightGovernorTestables = {
  isRebalancerActive,
  poolForHouse,
  RUNAWAY_LEADER_THRESHOLD,
  SPOTLIGHT_OPEN_POOL,
  SPOTLIGHT_TIERED_POOLS,
};

// ---------------------------------------------------------------------------
// Prompt management
// ---------------------------------------------------------------------------

router.get("/spotlight/prompts", requireStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  let rows = await db
    .select()
    .from(spotlightPromptsTable)
    .where(eq(spotlightPromptsTable.schoolId, schoolId))
    .orderBy(
      asc(spotlightPromptsTable.sortOrder),
      asc(spotlightPromptsTable.id),
    );
  // First-time visit: lazily seed a starter set so the admin sees a usable
  // list immediately. Idempotent — only fires when the table is empty for
  // this school.
  if (rows.length === 0) {
    await db
      .insert(spotlightPromptsTable)
      .values(
        SEED_PROMPTS.map((text, i) => ({
          schoolId,
          text,
          sortOrder: i,
        })),
      );
    rows = await db
      .select()
      .from(spotlightPromptsTable)
      .where(eq(spotlightPromptsTable.schoolId, schoolId))
      .orderBy(
        asc(spotlightPromptsTable.sortOrder),
        asc(spotlightPromptsTable.id),
      );
  }
  res.json({ prompts: rows });
});

router.post("/spotlight/prompts", requireStaff, async (req, res) => {
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;
  if (!isAdmin(staff)) {
    res.status(403).json({ error: "Admin required" });
    return;
  }
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const { text, active } = req.body ?? {};
  if (typeof text !== "string" || !text.trim()) {
    res.status(400).json({ error: "text is required" });
    return;
  }
  const [{ count }] = (await db
    .select({ count: sql<number>`count(*)::int` })
    .from(spotlightPromptsTable)
    .where(eq(spotlightPromptsTable.schoolId, schoolId))) as Array<{
    count: number;
  }>;
  if (count >= MAX_PROMPTS_PER_SCHOOL) {
    res
      .status(409)
      .json({ error: `Limit of ${MAX_PROMPTS_PER_SCHOOL} prompts reached` });
    return;
  }
  const [row] = await db
    .insert(spotlightPromptsTable)
    .values({
      schoolId,
      text: text.trim(),
      active: typeof active === "boolean" ? active : true,
      sortOrder: count,
    })
    .returning();
  res.json({ prompt: row });
});

router.put("/spotlight/prompts/:id", requireStaff, async (req, res) => {
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;
  if (!isAdmin(staff)) {
    res.status(403).json({ error: "Admin required" });
    return;
  }
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const { text, active, sortOrder } = req.body ?? {};
  const updates: Partial<typeof spotlightPromptsTable.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (typeof text === "string" && text.trim()) updates.text = text.trim();
  if (typeof active === "boolean") updates.active = active;
  if (typeof sortOrder === "number" && Number.isFinite(sortOrder)) {
    updates.sortOrder = Math.floor(sortOrder);
  }
  const [row] = await db
    .update(spotlightPromptsTable)
    .set(updates)
    .where(
      and(
        eq(spotlightPromptsTable.id, id),
        eq(spotlightPromptsTable.schoolId, schoolId),
      ),
    )
    .returning();
  if (!row) {
    res.status(404).json({ error: "Prompt not found" });
    return;
  }
  res.json({ prompt: row });
});

router.delete("/spotlight/prompts/:id", requireStaff, async (req, res) => {
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;
  if (!isAdmin(staff)) {
    res.status(403).json({ error: "Admin required" });
    return;
  }
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const result = await db
    .delete(spotlightPromptsTable)
    .where(
      and(
        eq(spotlightPromptsTable.id, id),
        eq(spotlightPromptsTable.schoolId, schoolId),
      ),
    )
    .returning({ id: spotlightPromptsTable.id });
  if (result.length === 0) {
    res.status(404).json({ error: "Prompt not found" });
    return;
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Pick endpoint
// ---------------------------------------------------------------------------
//
// Body: {
//   candidateStudentIds: string[],   // current-period roster from client
//   skipStudentIds?: string[],       // students the teacher marked absent
//                                    // for this session
// }
//
// The client supplies the candidate pool (from /api/teacher-roster?period=N)
// because the routing/period detection is already a solved problem there.
// We layer (1) recent-history exclusion and (2) crypto-grade randomness on
// top, then return the picked student + a random active prompt. We also
// log the pick to spotlight_history so the next call avoids it.
router.post("/spotlight/pick", requireStaff, async (req, res) => {
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const body = req.body ?? {};
  const candidates = Array.isArray(body.candidateStudentIds)
    ? body.candidateStudentIds.filter(
        (s: unknown): s is string => typeof s === "string" && s.trim() !== "",
      )
    : [];
  const skip = Array.isArray(body.skipStudentIds)
    ? new Set<string>(
        body.skipStudentIds
          .filter(
            (s: unknown): s is string =>
              typeof s === "string" && s.trim() !== "",
          )
          .map((s: string) => s.toUpperCase()),
      )
    : new Set<string>();

  // Per-session per-house rotation: client tracks which houses have
  // already been served a question this Spotlight session (since panel
  // open / last reset). We prefer to pick from a student whose house
  // has NOT been served yet, so a teacher who runs 4 questions on a
  // 4-house school sees one question per house. Fallback: if filtering
  // empties the pool, ignore the rotation filter rather than refusing.
  // Students with no house assigned (houseId=null) are always eligible
  // and never count against the rotation.
  const servedHouseIds = new Set<number>(
    Array.isArray(body.servedHouseIds)
      ? body.servedHouseIds.filter(
          (n: unknown): n is number =>
            typeof n === "number" && Number.isFinite(n),
        )
      : [],
  );

  if (candidates.length === 0) {
    res.status(400).json({
      error:
        "No students in the current-period roster. Make sure your class schedule is set up.",
    });
    return;
  }

  // Recent picks for this teacher → exclude (no-repeat memory).
  // Scope by BOTH staffId and schoolId — a teacher who works across two
  // schools (district admin, traveling counselor) would otherwise see
  // their School A history bleed into a School B pick. Multi-tenancy:
  // every read that touches a tenant-scoped table must include schoolId.
  const recent = await db
    .select({ studentId: spotlightHistoryTable.studentId })
    .from(spotlightHistoryTable)
    .where(
      and(
        eq(spotlightHistoryTable.staffId, staff.id),
        eq(spotlightHistoryTable.schoolId, schoolId),
      ),
    )
    .orderBy(desc(spotlightHistoryTable.pickedAt))
    .limit(NO_REPEAT_WINDOW);
  const recentSet = new Set(recent.map((r) => r.studentId.toUpperCase()));

  // Time-based cooldown: anyone this teacher picked within the last
  // COOLDOWN_MINUTES is excluded regardless of NO_REPEAT_WINDOW. Keeps
  // the teacher from accidentally calling on the same kid twice in the
  // same warm-up. Best-effort — relaxed below if it would empty the pool.
  const cooldownThreshold = new Date(
    Date.now() - COOLDOWN_MINUTES * 60_000,
  );
  const cooldownRows = await db
    .select({ studentId: spotlightHistoryTable.studentId })
    .from(spotlightHistoryTable)
    .where(
      and(
        eq(spotlightHistoryTable.staffId, staff.id),
        eq(spotlightHistoryTable.schoolId, schoolId),
        sql`${spotlightHistoryTable.pickedAt} > ${cooldownThreshold}`,
      ),
    );
  const cooldownSet = new Set(
    cooldownRows.map((r) => r.studentId.toUpperCase()),
  );

  const upperCandidates = candidates.map((s: string) => s.toUpperCase());
  // Tiered fallback so a small class never hits "nobody to pick":
  //   1. Strictest: skip + cooldown + no-repeat-window.
  //   2. Drop no-repeat (count-based) but keep cooldown (time-based).
  //   3. Drop cooldown too — only honour the absent-skip list.
  // 409 only if literally everyone was marked absent.
  let pool = upperCandidates.filter(
    (s: string) =>
      !skip.has(s) && !cooldownSet.has(s) && !recentSet.has(s),
  );
  if (pool.length === 0) {
    pool = upperCandidates.filter(
      (s: string) => !skip.has(s) && !cooldownSet.has(s),
    );
  }
  if (pool.length === 0) {
    pool = upperCandidates.filter((s: string) => !skip.has(s));
  }
  if (pool.length === 0) {
    res.status(409).json({
      error: "Everyone in the current-period roster has been skipped.",
    });
    return;
  }

  // ---- Per-house rotation filter --------------------------------------
  // Resolve houseId for every student in the current pool so we can
  // (a) prefer unserved-house students, and (b) decide on the awarded
  // points value once the winner is picked. Single query, scoped to
  // school for tenant isolation.
  const poolStudentRows = await db
    .select({
      studentId: studentsTable.studentId,
      houseId: studentsTable.houseId,
    })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.schoolId, schoolId),
        inArray(studentsTable.studentId, pool),
      ),
    );
  const houseByStudent = new Map<string, number | null>(
    poolStudentRows.map((r) => [r.studentId.toUpperCase(), r.houseId]),
  );
  // A student is "rotation-eligible" if their house hasn't been served
  // this session OR they have no house at all (no-house students never
  // block the cycle and never advance it).
  const rotationPool = pool.filter((s: string) => {
    const hid = houseByStudent.get(s);
    if (hid === null || hid === undefined) return true;
    return !servedHouseIds.has(hid);
  });
  // Use the rotation-filtered pool when it's non-empty; otherwise fall
  // back to the full pool so we never tell the teacher "no one to pick"
  // just because every remaining student is in an already-served house.
  const finalPool = rotationPool.length > 0 ? rotationPool : pool;

  // crypto.randomInt is uniform across [0, finalPool.length).
  const idx = randomInt(0, finalPool.length);
  const pickedId = finalPool[idx];

  // Resolve the picked student's name (and verify they're in this school).
  // Pull houseId at the same time so we can enrich the response with the
  // student's house — Spotlight's "Correct!" reveal renders a house badge.
  const [student] = await db
    .select({
      studentId: studentsTable.studentId,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
      houseId: studentsTable.houseId,
    })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.studentId, pickedId),
        eq(studentsTable.schoolId, schoolId),
      ),
    );
  if (!student) {
    res.status(404).json({ error: `Student ${pickedId} not found` });
    return;
  }

  // Enrich with the student's house — null is fine (UI hides the badge).
  // Scoped by schoolId on top of the FK to defend against any future
  // cross-school house leak.
  let house: {
    id: number;
    name: string;
    color: string;
    iconKey: string | null;
  } | null = null;
  if (student.houseId !== null) {
    const [hRow] = await db
      .select({
        id: housesTable.id,
        name: housesTable.name,
        color: housesTable.color,
        iconKey: housesTable.iconKey,
      })
      .from(housesTable)
      .where(
        and(
          eq(housesTable.id, student.houseId),
          eq(housesTable.schoolId, schoolId),
        ),
      );
    if (hRow) house = hRow;
  }

  // ---- Auto-pick the awarded point value (server-side governor) -------
  // The teacher no longer chooses a number — we pick it here from the
  // pool that fits the picked student's house standing. When the race
  // is healthy, every house draws from the open 1..10 pool; when the
  // leader is >RUNAWAY_LEADER_THRESHOLD ahead of #2, we switch to
  // per-rank pools (top quartile gets {1,2,3}; bottom quartile gets
  // {6,8,10}). The number we pick here is exactly what gets stored on
  // the PBIS row at /award time — no phantom mismatch.
  const totalsForCap = await computeHouseTotalsForCap(schoolId);
  const pointPool =
    student.houseId !== null
      ? poolForHouse(student.houseId, totalsForCap)
      : SPOTLIGHT_OPEN_POOL;
  const awardedPoints = pickFromPool(pointPool);

  // Record the pick so it's excluded next time.
  await db.insert(spotlightHistoryTable).values({
    schoolId,
    staffId: staff.id,
    studentId: pickedId,
  });

  // Random active prompt. Optional — if the school disabled all prompts
  // we just return null and the UI shows "Your turn!" with no question.
  const activePrompts = await db
    .select()
    .from(spotlightPromptsTable)
    .where(
      and(
        eq(spotlightPromptsTable.schoolId, schoolId),
        eq(spotlightPromptsTable.active, true),
      ),
    );
  let prompt: { id: number; text: string } | null = null;
  if (activePrompts.length > 0) {
    const p = activePrompts[randomInt(0, activePrompts.length)];
    prompt = { id: p.id, text: p.text };
  }

  res.json({
    pick: {
      studentId: student.studentId,
      firstName: student.firstName,
      lastName: student.lastName,
      house,
    },
    prompt,
    poolSize: pool.length,
    awardedPoints,
  });
});

// ---------------------------------------------------------------------------
// Award endpoint — Spotlight "Correct!" flow
// ---------------------------------------------------------------------------
//
// Body: { studentIds: string[], points: number }
//
// Files a positive PBIS entry against each student under the seeded
// "Class Participation (Spotlight)" reason. House totals are computed by
// summing each student's awards (see /api/houses), so points credit the
// student's house automatically.
//
// Returns the freshly-computed house totals so the client can animate the
// bars without a separate /api/houses round-trip. Multi-student calls are
// supported (1..50 ids per request).
router.post("/spotlight/award", requireStaff, async (req, res) => {
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;

  const body = req.body ?? {};
  const rawIds = Array.isArray(body.studentIds) ? body.studentIds : [];
  const points = Number(body.points);
  // Strict: must be a positive integer in the legal Spotlight range.
  // We do NOT silently floor/abs — coercing tampered input to a "valid"
  // value re-creates the displayed-vs-stored mismatch this redesign
  // exists to eliminate.
  if (
    !Number.isInteger(points) ||
    points < SPOTLIGHT_OPEN_POOL[0] ||
    points > SPOTLIGHT_OPEN_POOL[SPOTLIGHT_OPEN_POOL.length - 1]
  ) {
    res.status(400).json({
      error: `points must be an integer between ${SPOTLIGHT_OPEN_POOL[0]} and ${SPOTLIGHT_OPEN_POOL[SPOTLIGHT_OPEN_POOL.length - 1]}`,
    });
    return;
  }
  const chosenPoints = points;

  const seen = new Set<string>();
  const ids: string[] = [];
  for (const raw of rawIds) {
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (!id || seen.has(id.toUpperCase())) continue;
    seen.add(id.toUpperCase());
    ids.push(id);
  }
  if (ids.length === 0) {
    res.status(400).json({ error: "studentIds (non-empty array) required" });
    return;
  }
  if (ids.length > 50) {
    res
      .status(400)
      .json({ error: "Spotlight awards are capped at 50 students per call" });
    return;
  }

  // Cross-school safety: every id must live in this school's roster, and
  // we want the houseId in the same query so we can return updated house
  // totals without a second pass.
  const owned = await db
    .select({
      studentId: studentsTable.studentId,
      houseId: studentsTable.houseId,
    })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.schoolId, schoolId),
        inArray(studentsTable.studentId, ids),
      ),
    );
  if (owned.length !== ids.length) {
    res
      .status(403)
      .json({ error: "Some students are not in your school" });
    return;
  }

  // Resolve the seeded reason row. ensureSpotlightPbisReason runs at boot
  // so this should always exist; if it doesn't (admin manually deleted it)
  // we recreate it here so the award doesn't 500.
  let [reasonRow] = await db
    .select()
    .from(pbisReasonsTable)
    .where(
      and(
        eq(pbisReasonsTable.schoolId, schoolId),
        eq(pbisReasonsTable.name, SPOTLIGHT_PBIS_REASON_NAME),
      ),
    );
  if (!reasonRow) {
    [reasonRow] = await db
      .insert(pbisReasonsTable)
      .values({
        schoolId,
        name: SPOTLIGHT_PBIS_REASON_NAME,
        category: "Effort",
        defaultPoints: 5,
        polarity: "positive",
        sortOrder: 100,
        ownerScope: "school",
      })
      .returning();
  }

  const staffName = staff.displayName || "Staff";
  const nowIso = new Date().toISOString();

  // ---- Server-side governor re-enforcement ----------------------------
  // /pick handed the client a pool-correct value baked into the reveal,
  // and the client just echoes it back. We re-validate here so a stale
  // or tampered client (hand-edited body, or one whose pick happened
  // just before the leader crossed the threshold) can't slip a value
  // outside the legit pool through. Unlike the old design we DO NOT
  // silently downgrade — the displayed value must equal the awarded
  // value, so we reject mismatches and let the client re-pick.
  const totalsForCap = await computeHouseTotalsForCap(schoolId);
  for (const o of owned) {
    const studentPool =
      o.houseId !== null
        ? poolForHouse(o.houseId, totalsForCap)
        : SPOTLIGHT_OPEN_POOL;
    if (!studentPool.includes(chosenPoints)) {
      res.status(409).json({
        error:
          "Point value is no longer valid for this student's house — please re-spin.",
      });
      return;
    }
  }

  // Wrap the inserts in a single transaction so a partial failure
  // (DB blip, constraint error on one row) doesn't leave half the
  // class with points and the other half without — the client otherwise
  // sees an error and re-tries, which would double-award the lucky half.
  const created: string[] = await db.transaction(async (tx) => {
    const ok: string[] = [];
    for (const o of owned) {
      await tx.insert(pbisEntriesTable).values({
        schoolId,
        studentId: o.studentId,
        reason: SPOTLIGHT_PBIS_REASON_NAME,
        points: chosenPoints,
        polarity: "positive",
        staffName,
        staffId: staff.id,
        note: "Awarded via Spotlight",
        createdAt: nowIso,
      });
      ok.push(o.studentId);
    }
    return ok;
  });

  // Recompute updated house totals (same shape as /api/houses) so the
  // client can animate without a follow-up request. We compute totals
  // for ALL houses in the school, not just the affected ones, because
  // the leaderboard ordering depends on every house's total.
  const houses = await db
    .select()
    .from(housesTable)
    .where(eq(housesTable.schoolId, schoolId));

  const totals = await Promise.all(
    houses.map(async (h) => {
      const memberRows = await db
        .select({ studentId: studentsTable.studentId })
        .from(studentsTable)
        .where(
          and(
            eq(studentsTable.schoolId, schoolId),
            eq(studentsTable.houseId, h.id),
          ),
        );
      const memberIds = memberRows.map((m) => m.studentId);
      let totalPoints = 0;
      if (memberIds.length > 0) {
        const [agg] = await db
          .select({
            points: sql<number>`COALESCE(SUM(${pbisEntriesTable.points}), 0)::int`,
          })
          .from(pbisEntriesTable)
          .where(
            and(
              eq(pbisEntriesTable.schoolId, schoolId),
              inArray(pbisEntriesTable.studentId, memberIds),
              isNull(pbisEntriesTable.voidedAt),
            ),
          );
        totalPoints = agg?.points ?? 0;
      }
      return {
        id: h.id,
        name: h.name,
        color: h.color,
        iconKey: h.iconKey,
        memberCount: memberIds.length,
        totalPoints,
      };
    }),
  );

  res.json({
    awarded: created.length,
    // The displayed value IS the stored value — server validates
    // pool membership above and rejects mismatches with 409.
    pointsEach: chosenPoints,
    houses: totals,
  });
});

// Re-roll just the prompt without picking a new student. Useful when the
// teacher likes the student but the rotated prompt doesn't fit.
router.get("/spotlight/prompt", requireStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const activePrompts = await db
    .select()
    .from(spotlightPromptsTable)
    .where(
      and(
        eq(spotlightPromptsTable.schoolId, schoolId),
        eq(spotlightPromptsTable.active, true),
      ),
    );
  if (activePrompts.length === 0) {
    res.json({ prompt: null });
    return;
  }
  const p = activePrompts[randomInt(0, activePrompts.length)];
  res.json({ prompt: { id: p.id, text: p.text } });
});


export default router;
