import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  db,
  staffTable,
  schoolGradeRunsTable,
  schoolGradeHistoryTable,
  schoolGradeManualInputsTable,
  schoolGradeSurveysTable,
  type SchoolGradeHistoryRow,
} from "@workspace/db";
import { and, eq, desc } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import { canManageSchoolGrade } from "../lib/coreTeam.js";
import {
  schoolYearLabelFor,
  getSchoolTimezone,
} from "../lib/schoolYear.js";
import { getActiveSchoolYear } from "../lib/fastHistory.js";
import {
  componentsFor,
  computeGradeTotal,
  letterForPercent,
  PARTICIPATION_THRESHOLD,
  type SchoolGradeType,
  MANUAL_COMPONENT_COLUMN,
} from "../lib/schoolGrade.js";
import {
  computeFastComponents,
  type PmWindow,
} from "../lib/schoolGradeEngine.js";
import type {
  SchoolGradeRunComponent,
  SchoolGradeRunDetail,
} from "@workspace/db";

// =============================================================================
// School Grade Estimated Calculator (Phase 1) — middle school.
//
// Computes an ESTIMATED Florida school grade for a (school, year, PM window):
// six FAST components from student_fast_scores (engine), three manual
// components (Science / Civics / Acceleration) the admin enters, summed and
// mapped to a letter. Runs are append-only snapshots so the PM1 → PM2 → PM3
// estimate trail is preserved. Survey 2/3 uploads are stored as placeholders
// (Phase 2 parses + filters by a matched cohort).
//
// Audience: admin + Core Team (canManageSchoolGrade). Tenant-scoped via
// req.schoolId. Module talks to the client via authFetch (no OpenAPI codegen).
// =============================================================================

const router: IRouter = Router();

type StaffRow = typeof staffTable.$inferSelect;
const WINDOWS = new Set(["pm1", "pm2", "pm3"]);
const SURVEYS = new Set(["survey2", "survey3"]);
// PM3 end-of-year result uploads (Civics / Science / Algebra I / Geometry).
// Stored in the same school_grade_surveys ledger as placeholders (Phase 1):
// the file + raw CSV are retained, but not yet parsed into the calculation.
const PM3_UPLOADS = new Set([
  "pm3_civics",
  "pm3_science",
  "pm3_algebra",
  "pm3_geometry",
]);
const UPLOAD_KINDS = new Set([...SURVEYS, ...PM3_UPLOADS]);
const SCHOOL_TYPE: SchoolGradeType = "middle"; // Phase 1

async function requireStaff(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const staffId = req.staffId;
  if (!staffId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const [staff] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, staffId));
  if (!staff || !staff.active) {
    res.status(401).json({ error: "Staff not found or inactive" });
    return;
  }
  (req as Request & { staff: StaffRow }).staff = staff;
  next();
}

function staffOf(req: Request): StaffRow {
  return (req as Request & { staff: StaffRow }).staff;
}

function requireGradeManager(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!canManageSchoolGrade(staffOf(req))) {
    res
      .status(403)
      .json({ error: "Not authorized to manage the school grade calculator" });
    return;
  }
  next();
}

async function currentSchoolYear(schoolId: number): Promise<string> {
  const tz = await getSchoolTimezone(schoolId);
  return getActiveSchoolYear(schoolId, tz);
}

// Clamp an incoming component score to a 0..100 integer, or null.
function clampScore(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

// Compute total/percent/letter for a hand-entered history row.
function historyTotals(row: SchoolGradeHistoryRow) {
  const values: Record<string, number | null> = {
    ela_ach: row.elaAch,
    math_ach: row.mathAch,
    sci_ach: row.sciAch,
    ss_ach: row.ssAch,
    ela_lg: row.elaLg,
    math_lg: row.mathLg,
    ela_lg_l25: row.elaLgL25,
    math_lg_l25: row.mathLgL25,
    accel: row.accel,
  };
  const computed = computeGradeTotal(
    (row.schoolType as SchoolGradeType) ?? "middle",
    values,
  );
  if (row.totalOverride != null) {
    // Override path (legacy FSA years): trust the typed total. Percent is
    // still over the computed possible if any components were entered, else
    // null. Letter follows the override letter if present.
    const percent =
      computed.totalPossible > 0
        ? Math.round((row.totalOverride / computed.totalPossible) * 100)
        : null;
    return {
      ...computed,
      totalPoints: row.totalOverride,
      percent: percent ?? computed.percent,
      letter:
        (row.letterOverride as "A" | "B" | "C" | "D" | "F" | null) ??
        (percent != null
          ? letterForPercent(
              (row.schoolType as SchoolGradeType) ?? "middle",
              percent,
            )
          : computed.letter),
    };
  }
  if (row.letterOverride) {
    return {
      ...computed,
      letter: row.letterOverride as "A" | "B" | "C" | "D" | "F",
    };
  }
  return computed;
}

// ---- Overview --------------------------------------------------------------

router.get(
  "/school-grade/overview",
  requireStaff,
  requireGradeManager,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const schoolYear =
      typeof req.query.year === "string" && req.query.year
        ? req.query.year
        : await currentSchoolYear(schoolId);

    const [history, manualRows, surveys, runs] = await Promise.all([
      db
        .select()
        .from(schoolGradeHistoryTable)
        .where(eq(schoolGradeHistoryTable.schoolId, schoolId))
        .orderBy(
          schoolGradeHistoryTable.displayOrder,
          schoolGradeHistoryTable.id,
        ),
      db
        .select()
        .from(schoolGradeManualInputsTable)
        .where(
          and(
            eq(schoolGradeManualInputsTable.schoolId, schoolId),
            eq(schoolGradeManualInputsTable.schoolYear, schoolYear),
          ),
        ),
      db
        .select()
        .from(schoolGradeSurveysTable)
        .where(
          and(
            eq(schoolGradeSurveysTable.schoolId, schoolId),
            eq(schoolGradeSurveysTable.schoolYear, schoolYear),
          ),
        ),
      db
        .select()
        .from(schoolGradeRunsTable)
        .where(
          and(
            eq(schoolGradeRunsTable.schoolId, schoolId),
            eq(schoolGradeRunsTable.schoolYear, schoolYear),
          ),
        )
        .orderBy(desc(schoolGradeRunsTable.createdAt)),
    ]);

    // Latest run per window.
    const latestRuns: Record<string, unknown> = {};
    for (const r of runs) {
      if (!latestRuns[r.pmWindow]) latestRuns[r.pmWindow] = r;
    }

    // Manual inputs keyed by window.
    const manualByWindow: Record<string, unknown> = {};
    for (const m of manualRows) {
      manualByWindow[m.pmWindow] = {
        science: m.science,
        socialStudies: m.socialStudies,
        acceleration: m.acceleration,
      };
    }

    res.json({
      schoolYear,
      schoolType: SCHOOL_TYPE,
      components: componentsFor(SCHOOL_TYPE),
      participationThreshold: PARTICIPATION_THRESHOLD,
      history: history.map((h) => ({
        ...h,
        totals: historyTotals(h),
      })),
      manualInputs: manualByWindow,
      surveys: surveys.map((s) => ({
        id: s.id,
        survey: s.survey,
        filename: s.filename,
        byteSize: s.byteSize,
        rowCount: s.rowCount,
        status: s.status,
        uploadedAt: s.uploadedAt,
      })),
      latestRuns,
    });
  },
);

// ---- Calculate (append a run) ---------------------------------------------

router.post(
  "/school-grade/calculate",
  requireStaff,
  requireGradeManager,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const staff = staffOf(req);
    const body = (req.body ?? {}) as { window?: string };
    const w = body.window;
    if (!w || !WINDOWS.has(w)) {
      res.status(400).json({ error: "window must be pm1, pm2, or pm3" });
      return;
    }
    const pmWindow = w as PmWindow;
    const schoolYear = await currentSchoolYear(schoolId);

    const fast = await computeFastComponents(schoolId, schoolYear, pmWindow);

    const [manual] = await db
      .select()
      .from(schoolGradeManualInputsTable)
      .where(
        and(
          eq(schoolGradeManualInputsTable.schoolId, schoolId),
          eq(schoolGradeManualInputsTable.schoolYear, schoolYear),
          eq(schoolGradeManualInputsTable.pmWindow, pmWindow),
        ),
      );
    const manualValues: Record<string, number | null> = {
      science: manual?.science ?? null,
      socialStudies: manual?.socialStudies ?? null,
      acceleration: manual?.acceleration ?? null,
    };

    const defs = componentsFor(SCHOOL_TYPE);
    const fastMap = fast.components as Record<
      string,
      {
        value: number | null;
        status: "computed" | "projected" | "pending";
        numerator: number | null;
        denominator: number | null;
      }
    >;

    const components: SchoolGradeRunComponent[] = [];
    const values: Record<string, number | null> = {};
    for (const def of defs) {
      if (def.source === "fast") {
        const r = fastMap[def.key];
        values[def.key] = r?.value ?? null;
        const tested =
          def.subject === "ela"
            ? fast.participation.ela
            : fast.participation.math;
        components.push({
          key: def.key,
          label: def.label,
          value: r?.value ?? null,
          source: "fast",
          status:
            r?.status === "projected"
              ? "projected"
              : r?.value == null
                ? "pending"
                : "computed",
          testedPct: tested.testedPct,
          testedCount: tested.tested,
          eligibleCount: tested.eligible,
          numerator: r?.numerator ?? null,
          denominator: r?.denominator ?? null,
          note:
            r?.status === "projected"
              ? "Projected from prior-year FAST (estimate)"
              : null,
        });
      } else {
        const col = MANUAL_COMPONENT_COLUMN[def.key];
        const v = col ? manualValues[col] : null;
        values[def.key] = v;
        components.push({
          key: def.key,
          label: def.label,
          value: v,
          source: "manual",
          status: v == null ? "pending" : "manual",
          note:
            v == null ? "Awaiting manual entry / PM3 upload (Phase 2)" : null,
        });
      }
    }

    const totals = computeGradeTotal(SCHOOL_TYPE, values);
    const detail: SchoolGradeRunDetail = {
      components,
      participation: {
        ela: {
          testedPct: fast.participation.ela.testedPct,
          tested: fast.participation.ela.tested,
          eligible: fast.participation.ela.eligible,
        },
        math: {
          testedPct: fast.participation.math.testedPct,
          tested: fast.participation.math.tested,
          eligible: fast.participation.math.eligible,
        },
      },
    };

    const [run] = await db
      .insert(schoolGradeRunsTable)
      .values({
        schoolId,
        schoolYear,
        pmWindow,
        schoolType: SCHOOL_TYPE,
        status: "estimated",
        detail,
        totalPoints: totals.totalPoints,
        totalPossible: totals.totalPossible,
        percent: totals.percent,
        letter: totals.letter,
        createdByStaffId: staff.id,
      })
      .returning();

    res.json({ run, totals });
  },
);

// ---- Manual inputs (upsert) -----------------------------------------------

router.put(
  "/school-grade/manual-inputs",
  requireStaff,
  requireGradeManager,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const staff = staffOf(req);
    const body = (req.body ?? {}) as {
      window?: string;
      science?: unknown;
      socialStudies?: unknown;
      acceleration?: unknown;
    };
    if (!body.window || !WINDOWS.has(body.window)) {
      res.status(400).json({ error: "window must be pm1, pm2, or pm3" });
      return;
    }
    const schoolYear = await currentSchoolYear(schoolId);
    const row = {
      schoolId,
      schoolYear,
      pmWindow: body.window,
      science: clampScore(body.science),
      socialStudies: clampScore(body.socialStudies),
      acceleration: clampScore(body.acceleration),
      updatedByStaffId: staff.id,
      updatedAt: new Date(),
    };
    const [saved] = await db
      .insert(schoolGradeManualInputsTable)
      .values(row)
      .onConflictDoUpdate({
        target: [
          schoolGradeManualInputsTable.schoolId,
          schoolGradeManualInputsTable.schoolYear,
          schoolGradeManualInputsTable.pmWindow,
        ],
        set: {
          science: row.science,
          socialStudies: row.socialStudies,
          acceleration: row.acceleration,
          updatedByStaffId: row.updatedByStaffId,
          updatedAt: row.updatedAt,
        },
      })
      .returning();
    res.json({ manualInput: saved });
  },
);

// ---- History CRUD ----------------------------------------------------------

function historyValuesFromBody(body: Record<string, unknown>) {
  return {
    elaAch: clampScore(body.elaAch),
    mathAch: clampScore(body.mathAch),
    sciAch: clampScore(body.sciAch),
    ssAch: clampScore(body.ssAch),
    elaLg: clampScore(body.elaLg),
    mathLg: clampScore(body.mathLg),
    elaLgL25: clampScore(body.elaLgL25),
    mathLgL25: clampScore(body.mathLgL25),
    accel: clampScore(body.accel),
    totalOverride:
      body.totalOverride == null || body.totalOverride === ""
        ? null
        : Math.round(Number(body.totalOverride)),
    letterOverride:
      typeof body.letterOverride === "string" && body.letterOverride
        ? body.letterOverride.toUpperCase().slice(0, 1)
        : null,
  };
}

// PATCH-only variant for PUT: include ONLY the component/override fields
// the caller actually sent. `historyValuesFromBody` always returns every
// key (correct for INSERT, where absent = null), but on UPDATE that would
// silently wipe existing columns the caller never touched. Keyed off the
// request-body keys so a partial edit (e.g. fixing one cell) leaves the
// rest of the row intact.
function historyPatchFromBody(body: Record<string, unknown>) {
  const full = historyValuesFromBody(body);
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(full) as (keyof typeof full)[]) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      patch[key] = full[key];
    }
  }
  return patch;
}

router.post(
  "/school-grade/history",
  requireStaff,
  requireGradeManager,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const staff = staffOf(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const yearLabel =
      typeof body.yearLabel === "string" ? body.yearLabel.trim() : "";
    if (!yearLabel) {
      res.status(400).json({ error: "yearLabel is required" });
      return;
    }
    const [saved] = await db
      .insert(schoolGradeHistoryTable)
      .values({
        schoolId,
        yearLabel,
        displayOrder:
          body.displayOrder == null ? 0 : Math.round(Number(body.displayOrder)),
        schoolType: SCHOOL_TYPE,
        ...historyValuesFromBody(body),
        createdByStaffId: staff.id,
      })
      .returning();
    res.json({ history: { ...saved, totals: historyTotals(saved) } });
  },
);

router.put(
  "/school-grade/history/:id",
  requireStaff,
  requireGradeManager,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const set: Record<string, unknown> = {
      ...historyPatchFromBody(body),
      updatedAt: new Date(),
    };
    if (typeof body.yearLabel === "string" && body.yearLabel.trim()) {
      set.yearLabel = body.yearLabel.trim();
    }
    if (body.displayOrder != null) {
      set.displayOrder = Math.round(Number(body.displayOrder));
    }
    const [saved] = await db
      .update(schoolGradeHistoryTable)
      .set(set)
      .where(
        and(
          eq(schoolGradeHistoryTable.id, id),
          eq(schoolGradeHistoryTable.schoolId, schoolId),
        ),
      )
      .returning();
    if (!saved) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json({ history: { ...saved, totals: historyTotals(saved) } });
  },
);

router.delete(
  "/school-grade/history/:id",
  requireStaff,
  requireGradeManager,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }
    await db
      .delete(schoolGradeHistoryTable)
      .where(
        and(
          eq(schoolGradeHistoryTable.id, id),
          eq(schoolGradeHistoryTable.schoolId, schoolId),
        ),
      );
    res.json({ ok: true });
  },
);

// ---- Survey upload (Phase 1 placeholder) ----------------------------------

router.post(
  "/school-grade/surveys",
  requireStaff,
  requireGradeManager,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const staff = staffOf(req);
    const body = (req.body ?? {}) as {
      survey?: string;
      filename?: string;
      byteSize?: unknown;
      rawCsv?: unknown;
    };
    if (!body.survey || !UPLOAD_KINDS.has(body.survey)) {
      res.status(400).json({
        error:
          "survey must be survey2, survey3, or a PM3 result upload (pm3_civics, pm3_science, pm3_algebra, pm3_geometry)",
      });
      return;
    }
    const filename =
      typeof body.filename === "string" && body.filename
        ? body.filename.slice(0, 255)
        : "upload.csv";
    const rawCsv =
      typeof body.rawCsv === "string" ? body.rawCsv.slice(0, 2_000_000) : null;
    const byteSize =
      body.byteSize != null && Number.isFinite(Number(body.byteSize))
        ? Math.round(Number(body.byteSize))
        : rawCsv
          ? Buffer.byteLength(rawCsv, "utf8")
          : 0;
    const schoolYear = await currentSchoolYear(schoolId);
    const [saved] = await db
      .insert(schoolGradeSurveysTable)
      .values({
        schoolId,
        schoolYear,
        survey: body.survey,
        filename,
        byteSize,
        rawCsv,
        status: "uploaded",
        uploadedByStaffId: staff.id,
        uploadedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          schoolGradeSurveysTable.schoolId,
          schoolGradeSurveysTable.schoolYear,
          schoolGradeSurveysTable.survey,
        ],
        set: {
          filename,
          byteSize,
          rawCsv,
          status: "uploaded",
          uploadedByStaffId: staff.id,
          uploadedAt: new Date(),
        },
      })
      .returning();
    res.json({
      survey: {
        id: saved.id,
        survey: saved.survey,
        filename: saved.filename,
        byteSize: saved.byteSize,
        status: saved.status,
        uploadedAt: saved.uploadedAt,
      },
    });
  },
);

export default router;
