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
  schoolSettingsTable,
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
// When the leading house's all-time total is more than this many points
// above the runner-up, Spotlight silently caps any award to that house
// to a small random value (CAP_POINT_CHOICES). Surrounding UI never
// reveals the cap exists — teachers see the actual (capped) +N grow
// the bar and assume they got a "small" question. The PBIS entry note
// records both the chosen and awarded values so admins can audit later.
//
// Comparison is leader-vs-runner-up (only the single top house can be
// capped at any moment). Threshold gentle enough that healthy
// competition still gets full-value swings.
const RUNAWAY_LEADER_THRESHOLD = 1500;

// Server picks the awarded point value at /spotlight/pick time so the
// teacher never chooses (and therefore never notices the cap). Full set
// for everyone except the runaway leader; reduced set for the leader.
const SPOTLIGHT_POINT_CHOICES = [1, 3, 5, 10] as const;
const SPOTLIGHT_CAPPED_POINT_CHOICES = [1, 2, 3] as const;

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

// Returns the house id that's currently >RUNAWAY_LEADER_THRESHOLD ahead
// of the runner-up, or null if no house has run away with it. Only ever
// returns a single house — by definition only the top can be capped.
function detectCappedHouseId(totals: HouseTotalRow[]): number | null {
  if (totals.length < 2) return null;
  const sorted = [...totals].sort((a, b) => b.totalPoints - a.totalPoints);
  const leader = sorted[0];
  const runnerUp = sorted[1];
  if (leader.totalPoints - runnerUp.totalPoints > RUNAWAY_LEADER_THRESHOLD) {
    return leader.id;
  }
  return null;
}

function pickAwardedPoints(isCapped: boolean): number {
  const set = isCapped
    ? SPOTLIGHT_CAPPED_POINT_CHOICES
    : SPOTLIGHT_POINT_CHOICES;
  return set[randomInt(0, set.length)];
}

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
  // The teacher no longer chooses 1/3/5/10. We pick it here so it's
  // baked into the reveal — and so the runaway-leader cap can be
  // applied invisibly. If the picked student belongs to the currently
  // capped house, we draw from {1,2,3} instead of {1,3,5,10}. The
  // teacher just sees a small number and assumes it was a small
  // question; no UI ever surfaces the cap.
  const totalsForCap = await computeHouseTotalsForCap(schoolId);
  const cappedHouseId = detectCappedHouseId(totalsForCap);
  const isPickedHouseCapped =
    student.houseId !== null && cappedHouseId === student.houseId;
  const awardedPoints = pickAwardedPoints(isPickedHouseCapped);

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
  if (!Number.isFinite(points) || points <= 0 || points > 100) {
    res
      .status(400)
      .json({ error: "points must be a positive number ≤ 100" });
    return;
  }

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

  const chosenPoints = Math.abs(Math.floor(points));
  const nowIso = new Date().toISOString();

  // Confirm school's negative-affects-total policy is irrelevant for us
  // (we're always positive) — but still respect any hard cap by clamping
  // to defaultPoints' sign convention (positive). Voiding/audit columns
  // use defaults from the table.
  void schoolSettingsTable;

  // ---- Server-side governor re-enforcement ----------------------------
  // /pick already picked the awarded value with the cap in mind, but we
  // re-check here so a tampered or stale client (e.g. one that submits
  // a hand-edited points value, or one whose pick happened just before
  // the leader crossed the threshold) cannot bypass the cap. If the
  // student's house is currently capped and the requested value is
  // above the cap ceiling, we silently re-roll into the capped set.
  const totalsForCap = await computeHouseTotalsForCap(schoolId);
  const cappedHouseId = detectCappedHouseId(totalsForCap);
  const CAP_CEILING =
    SPOTLIGHT_CAPPED_POINT_CHOICES[SPOTLIGHT_CAPPED_POINT_CHOICES.length - 1];

  // Wrap the inserts in a single transaction so a partial failure
  // (DB blip, constraint error on one row) doesn't leave half the
  // class with points and the other half without — the client otherwise
  // sees an error and re-tries, which would double-award the lucky half.
  // Each row's `points` is computed per-student because in a multi-pick
  // batch some kids may belong to the capped house and others not.
  const created: string[] = await db.transaction(async (tx) => {
    const ok: string[] = [];
    for (const o of owned) {
      const isCappedRecipient =
        cappedHouseId !== null &&
        o.houseId !== null &&
        o.houseId === cappedHouseId;
      let storedPoints = chosenPoints;
      let note = "Awarded via Spotlight";
      if (isCappedRecipient && chosenPoints > CAP_CEILING) {
        storedPoints = pickAwardedPoints(true);
        // Audit-only — never surfaced in any UI. Lets an admin see
        // "this 10-point reveal was silently downgraded to 2" later.
        note = `Awarded via Spotlight (chosen=${chosenPoints}, awarded=${storedPoints})`;
      }
      await tx.insert(pbisEntriesTable).values({
        schoolId,
        studentId: o.studentId,
        reason: SPOTLIGHT_PBIS_REASON_NAME,
        points: storedPoints,
        polarity: "positive",
        staffName,
        staffId: staff.id,
        note,
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
    // Echo back the value the client requested. The actual stored value
    // may differ per-student under the hidden runaway-leader cap, but
    // that's intentionally not surfaced — clients only need the new
    // house totals to animate the leaderboard.
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

// Silence unused-import warning if the file evolves.
void inArray;

export default router;
