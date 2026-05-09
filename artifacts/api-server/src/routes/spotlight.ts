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
} from "@workspace/db";
import { and, eq, asc, desc, inArray, sql } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";

const router: IRouter = Router();

// How many of a teacher's most recent picks are excluded from the next
// pick. Keeps a teacher's class from drawing the same kid back-to-back
// while still allowing the rotation to wrap when the candidate pool is
// small.
const NO_REPEAT_WINDOW = 10;

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

  const upperCandidates = candidates.map((s: string) => s.toUpperCase());
  let pool = upperCandidates.filter(
    (s: string) => !skip.has(s) && !recentSet.has(s),
  );
  // If everyone in the room was picked recently, relax the no-repeat rule
  // (but keep the absent-skip rule) so the teacher isn't told "nobody to
  // pick" in a small class.
  if (pool.length === 0) {
    pool = upperCandidates.filter((s: string) => !skip.has(s));
  }
  if (pool.length === 0) {
    res.status(409).json({
      error: "Everyone in the current-period roster has been skipped.",
    });
    return;
  }

  // crypto.randomInt is uniform across [0, pool.length).
  const idx = randomInt(0, pool.length);
  const pickedId = pool[idx];

  // Resolve the picked student's name (and verify they're in this school).
  const [student] = await db
    .select({
      studentId: studentsTable.studentId,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
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
    },
    prompt,
    poolSize: pool.length,
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
