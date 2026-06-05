// Per-school onboarding checklist endpoints. Admin/SuperUser only.
//
//   GET  /api/onboarding/status   — current state of all steps (auto + manual)
//   POST /api/onboarding/state    — toggle the manual checkmark on a step
//   GET  /api/onboarding/pdf      — printable PDF copy of the checklist
//
// Auto-checks are wrapped in try/catch so any schema drift just produces
// "empty" rather than blowing up the whole page.

import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  db,
  onboardingChecklistStateTable,
  schoolsTable,
  staffTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import {
  ONBOARDING_STEPS,
  type AutoStatus,
  type OnboardingStepDef,
} from "../lib/onboardingSteps.js";
import { renderOnboardingPdf } from "../lib/onboardingPdf.js";

const router: IRouter = Router();

type StaffRow = typeof staffTable.$inferSelect;

async function loadStaff(req: Request): Promise<StaffRow | null> {
  const id = req.staffId;
  if (!id) return null;
  const [s] = await db.select().from(staffTable).where(eq(staffTable.id, id));
  return s && s.active ? s : null;
}

function requireAdmin() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const staff = await loadStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    if (!staff.isAdmin && !staff.isSuperUser) {
      res.status(403).json({ error: "Admin only" });
      return;
    }
    next();
  };
}

async function safeAutoCheck(
  step: OnboardingStepDef,
  schoolId: number,
  log: Request["log"],
): Promise<AutoStatus> {
  try {
    return await step.autoCheck(db, schoolId);
  } catch (err) {
    log?.warn(
      { err: (err as Error).message, stepKey: step.key, schoolId },
      "[onboarding] autoCheck failed, falling back to empty",
    );
    return "empty";
  }
}

router.get("/onboarding/status", requireAdmin(), async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;

  const rows = await db
    .select()
    .from(onboardingChecklistStateTable)
    .where(eq(onboardingChecklistStateTable.schoolId, schoolId));
  const stateByKey = new Map(rows.map((r) => [r.stepKey, r]));

  const steps = await Promise.all(
    ONBOARDING_STEPS.map(async (s) => {
      const state = stateByKey.get(s.key);
      const autoStatus = await safeAutoCheck(s, schoolId, req.log);
      const manualChecked = state?.manualChecked ?? false;
      const complete = manualChecked || autoStatus === "complete";
      return {
        key: s.key,
        phase: s.phase,
        role: s.role,
        label: s.label,
        hint: s.hint,
        route: s.route,
        autoStatus,
        manualChecked,
        complete,
        completedByStaffId: state?.completedByStaffId ?? null,
        completedAt: state?.completedAt
          ? state.completedAt.toISOString()
          : null,
      };
    }),
  );

  // Weighted progress: complete = 1, partial = 0.5, empty/none = 0.
  // Partials only count when the manual override isn't set (a manual
  // tick implies the admin called it done). Rendered as "X / N" or
  // "X.5 / N" — half-points are the whole point of the rework.
  const weighted = steps.reduce((acc, s) => {
    if (s.complete) return acc + 1;
    if (s.autoStatus === "partial") return acc + 0.5;
    return acc;
  }, 0);
  res.json({
    steps,
    progress: { complete: weighted, total: steps.length },
  });
});

router.post("/onboarding/state", requireAdmin(), async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const body = (req.body ?? {}) as { key?: unknown; manualChecked?: unknown };
  const key = typeof body.key === "string" ? body.key.trim() : "";
  const manualChecked = body.manualChecked === true;
  if (!key || key.length > 64) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }
  const known = ONBOARDING_STEPS.find((s) => s.key === key);
  if (!known) {
    res.status(400).json({ error: "Unknown step key" });
    return;
  }

  const staff = await loadStaff(req);
  const now = new Date();

  // Upsert: school+step is unique. Update on conflict.
  await db
    .insert(onboardingChecklistStateTable)
    .values({
      schoolId,
      stepKey: key,
      manualChecked,
      completedByStaffId: manualChecked ? (staff?.id ?? null) : null,
      completedAt: manualChecked ? now : null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        onboardingChecklistStateTable.schoolId,
        onboardingChecklistStateTable.stepKey,
      ],
      set: {
        manualChecked,
        completedByStaffId: manualChecked ? (staff?.id ?? null) : null,
        completedAt: manualChecked ? now : null,
        updatedAt: now,
      },
    });

  req.log?.info(
    { schoolId, stepKey: key, manualChecked, by: staff?.id ?? null },
    "[onboarding] step state updated",
  );

  res.json({ ok: true });
});

router.get("/onboarding/pdf", requireAdmin(), async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;

  const [school] = await db
    .select({ name: schoolsTable.name })
    .from(schoolsTable)
    .where(eq(schoolsTable.id, schoolId));

  const rows = await db
    .select()
    .from(onboardingChecklistStateTable)
    .where(eq(onboardingChecklistStateTable.schoolId, schoolId));
  const stateByKey = new Map(rows.map((r) => [r.stepKey, r]));

  const steps = await Promise.all(
    ONBOARDING_STEPS.map(async (s) => ({
      key: s.key,
      manualChecked: stateByKey.get(s.key)?.manualChecked ?? false,
      autoStatus: await safeAutoCheck(s, schoolId, req.log),
    })),
  );
  const completeCount = steps.filter(
    (s) => s.manualChecked || s.autoStatus === "complete",
  ).length;

  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await renderOnboardingPdf({
      schoolName: school?.name,
      generatedAt: new Date(),
      steps,
      totalCount: steps.length,
      completeCount,
    });
  } catch (err) {
    req.log?.error(
      { err: (err as Error).message, schoolId },
      "[onboarding] PDF render failed",
    );
    res.status(500).json({ error: "Failed to render PDF" });
    return;
  }

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="onboarding-checklist.pdf"`,
  );
  res.status(200).end(pdfBuffer);
});

export default router;
