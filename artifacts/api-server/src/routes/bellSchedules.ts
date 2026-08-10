import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  db,
  bellSchedulesTable,
  bellSchedulePeriodsTable,
  bellScheduleVariantsTable,
  bellVariantBlocksTable,
  bellVariantAssignmentsTable,
  staffTable,
  BELL_BLOCK_TYPES,
} from "@workspace/db";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { staffIdFromBearerToken } from "../lib/staffBearerAuth.js";
import { requireSchool } from "../lib/scope.js";
import {
  loadDayTypeContext,
  variantForGrade,
} from "../lib/scheduleResolver.js";

const router: IRouter = Router();

type StaffRow = typeof staffTable.$inferSelect;

async function loadStaff(req: Request): Promise<StaffRow | null> {
  let id = req.staffId ?? null;
  if (!id) {
    const auth = req.headers.authorization;
    if (typeof auth === "string" && auth.startsWith("Bearer ")) {
      id = await staffIdFromBearerToken(auth.slice(7).trim());
    }
  }
  if (!id) return null;
  const [s] = await db.select().from(staffTable).where(eq(staffTable.id, id));
  return s && s.active ? s : null;
}

function canManageBellSchedules(s: StaffRow): boolean {
  return Boolean(
    s.isSuperUser ||
      s.isAdmin ||
      s.isMtssCoordinator ||
      s.isBehaviorSpecialist,
  );
}

function requireAccess() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const staff = await loadStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    if (!canManageBellSchedules(staff)) {
      res.status(403).json({ error: "Bell schedule access required" });
      return;
    }
    next();
  };
}

const KINDS = new Set(["regular", "activity", "early_release"]);
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

interface PeriodInput {
  periodNumber: number;
  name: string;
  startTime: string;
  endTime: string;
  // Defaults TRUE so legacy bodies that don't send the flag keep
  // counting every period (matches DB column default).
  includedInOnTimeStreak: boolean;
}

function parsePeriods(raw: unknown): PeriodInput[] | string {
  if (!Array.isArray(raw)) return "periods must be an array";
  if (raw.length === 0) return "At least one period is required";
  const out: PeriodInput[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i] as Record<string, unknown> | undefined;
    if (!p || typeof p !== "object") return `periods[${i}] must be an object`;
    const periodNumber = Number(p.periodNumber);
    if (!Number.isInteger(periodNumber) || periodNumber < 1)
      return `periods[${i}].periodNumber must be a positive integer`;
    if (seen.has(periodNumber))
      return `Duplicate periodNumber ${periodNumber}`;
    seen.add(periodNumber);
    const name = typeof p.name === "string" ? p.name.trim() : "";
    if (!name) return `periods[${i}].name is required`;
    const startTime = typeof p.startTime === "string" ? p.startTime.trim() : "";
    const endTime = typeof p.endTime === "string" ? p.endTime.trim() : "";
    if (!TIME_RE.test(startTime))
      return `periods[${i}].startTime must be HH:MM (24h)`;
    if (!TIME_RE.test(endTime))
      return `periods[${i}].endTime must be HH:MM (24h)`;
    // Accept anything explicitly `false` as opt-out; treat missing /
    // anything else as `true` so legacy bodies keep working.
    const includedInOnTimeStreak = p.includedInOnTimeStreak === false ? false : true;
    out.push({ periodNumber, name, startTime, endTime, includedInOnTimeStreak });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Schedule VARIANTS (multi-grade bell schedules). A bell_schedules row is a
// "Day Type"; each variant is one simultaneous timing pattern under it
// (e.g. Grade 6 / Grade 7 / Grade 8 with staggered lunches). Blocks are the
// typed timeline (period | lunch | passing | advisory | homeroom | custom);
// assignments map grades to variants. The central resolver
// (lib/scheduleResolver.ts) is the only consumer of this data at runtime.
// ---------------------------------------------------------------------------

const BLOCK_TYPES = new Set<string>(BELL_BLOCK_TYPES);

interface BlockInput {
  blockType: string;
  periodNumber: number | null;
  name: string;
  startTime: string;
  endTime: string;
  includedInOnTimeStreak: boolean;
  sortOrder: number;
}

// Parse + validate a variant's block list. Enforces: valid types, HH:MM
// times, end > start, period blocks carry unique positive period numbers,
// and no overlapping blocks within the variant.
function parseBlocks(raw: unknown): BlockInput[] | string {
  if (!Array.isArray(raw)) return "blocks must be an array";
  if (raw.length === 0) return "At least one block is required";
  const out: BlockInput[] = [];
  const seenPeriods = new Set<number>();
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i] as Record<string, unknown> | undefined;
    if (!b || typeof b !== "object") return `blocks[${i}] must be an object`;
    const blockType =
      typeof b.blockType === "string" ? b.blockType : "period";
    if (!BLOCK_TYPES.has(blockType))
      return `blocks[${i}].blockType must be one of ${Array.from(BLOCK_TYPES).join(", ")}`;
    let periodNumber: number | null = null;
    if (blockType === "period") {
      periodNumber = Number(b.periodNumber);
      if (!Number.isInteger(periodNumber) || periodNumber < 1)
        return `blocks[${i}].periodNumber must be a positive integer for period blocks`;
      if (seenPeriods.has(periodNumber))
        return `Duplicate period number ${periodNumber}`;
      seenPeriods.add(periodNumber);
    }
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (!name) return `blocks[${i}].name is required`;
    const startTime = typeof b.startTime === "string" ? b.startTime.trim() : "";
    const endTime = typeof b.endTime === "string" ? b.endTime.trim() : "";
    if (!TIME_RE.test(startTime))
      return `blocks[${i}].startTime must be HH:MM (24h)`;
    if (!TIME_RE.test(endTime))
      return `blocks[${i}].endTime must be HH:MM (24h)`;
    if (endTime <= startTime)
      return `"${name}" must end after it starts (${startTime}–${endTime})`;
    const includedInOnTimeStreak =
      b.includedInOnTimeStreak === false ? false : blockType === "period";
    out.push({
      blockType,
      periodNumber,
      name,
      startTime,
      endTime,
      includedInOnTimeStreak,
      sortOrder: i,
    });
  }
  // Overlap check: sort by start and make sure each block ends before the
  // next begins (back-to-back is fine; overlap is a config error).
  const sorted = [...out].sort((a, b) =>
    a.startTime < b.startTime ? -1 : a.startTime > b.startTime ? 1 : 0,
  );
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].startTime < sorted[i - 1].endTime) {
      return `"${sorted[i - 1].name}" and "${sorted[i].name}" overlap`;
    }
  }
  return out;
}

// Valid grade values for assignments (kept permissive: K, PK, 1-12).
const GRADE_RE = /^(PK|KG?|K|\d{1,2})$/i;

function parseGrades(raw: unknown): string[] | string {
  if (!Array.isArray(raw)) return "grades must be an array";
  const out: string[] = [];
  const seen = new Set<string>();
  for (const g of raw) {
    const v = String(g).trim();
    if (!GRADE_RE.test(v)) return `"${v}" is not a valid grade`;
    const norm = String(Number.isFinite(Number(v)) ? Number(v) : v.toUpperCase());
    if (seen.has(norm)) return `Grade ${norm} listed twice`;
    seen.add(norm);
    out.push(norm);
  }
  return out;
}

// Mirror a legacy flat period list into the schedule's DEFAULT variant so
// the old single-schedule editor keeps working: its saves stay authoritative
// for schools that never touch variants. Runs inside the caller's tx.
async function syncDefaultVariantFromPeriods(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  scheduleId: number,
  periods: PeriodInput[],
) {
  // SAFETY: once grade-specific variants exist, the variant editor is
  // authoritative and the legacy flat-period editor must NOT overwrite
  // any variant (a promoted grade variant could be default). Only mirror
  // while the schedule has at most its single backfilled default.
  const existing = await tx
    .select({
      id: bellScheduleVariantsTable.id,
      isDefault: bellScheduleVariantsTable.isDefault,
    })
    .from(bellScheduleVariantsTable)
    .where(eq(bellScheduleVariantsTable.scheduleId, scheduleId));
  if (existing.length > 1) return;
  let variant = existing.find((v) => v.isDefault) ?? existing[0] ?? null;
  if (!variant) {
    [variant] = await tx
      .insert(bellScheduleVariantsTable)
      .values({
        scheduleId,
        name: "Default Schedule",
        isDefault: true,
        sortOrder: 0,
      })
      .returning();
  }
  await tx
    .delete(bellVariantBlocksTable)
    .where(eq(bellVariantBlocksTable.variantId, variant.id));
  // Same name-based type detection as the boot backfill: a "Lunch" period
  // becomes a typed lunch block, etc.
  const detect = (name: string): string => {
    const n = name.toLowerCase();
    if (/\blunch\b/.test(n)) return "lunch";
    if (/\badvisory\b/.test(n)) return "advisory";
    if (/\bhome\s*room\b|\bhomeroom\b/.test(n)) return "homeroom";
    if (/\bpassing\b/.test(n)) return "passing";
    return "period";
  };
  await tx.insert(bellVariantBlocksTable).values(
    periods.map((p, i) => {
      const blockType = detect(p.name);
      return {
        variantId: variant.id,
        blockType,
        periodNumber: blockType === "period" ? p.periodNumber : null,
        name: p.name,
        startTime: p.startTime,
        endTime: p.endTime,
        includedInOnTimeStreak:
          blockType === "period" ? p.includedInOnTimeStreak : false,
        sortOrder: i,
      };
    }),
  );
}

async function listSchedules(schoolId: number) {
  const schedules = await db
    .select()
    .from(bellSchedulesTable)
    .where(eq(bellSchedulesTable.schoolId, schoolId))
    .orderBy(asc(bellSchedulesTable.sortOrder), asc(bellSchedulesTable.id));
  if (schedules.length === 0) return [];
  const periods = await db
    .select()
    .from(bellSchedulePeriodsTable)
    .where(
      inArray(
        bellSchedulePeriodsTable.scheduleId,
        schedules.map((s) => s.id),
      ),
    )
    .orderBy(asc(bellSchedulePeriodsTable.periodNumber));
  // Variants + blocks + grade assignments for the new multi-schedule UI.
  const scheduleIds = schedules.map((s) => s.id);
  const variants = await db
    .select()
    .from(bellScheduleVariantsTable)
    .where(inArray(bellScheduleVariantsTable.scheduleId, scheduleIds))
    .orderBy(
      asc(bellScheduleVariantsTable.sortOrder),
      asc(bellScheduleVariantsTable.id),
    );
  const variantIds = variants.map((v) => v.id);
  const [blocks, assignments] = variantIds.length
    ? await Promise.all([
        db
          .select()
          .from(bellVariantBlocksTable)
          .where(inArray(bellVariantBlocksTable.variantId, variantIds))
          .orderBy(
            asc(bellVariantBlocksTable.startTime),
            asc(bellVariantBlocksTable.id),
          ),
        db
          .select()
          .from(bellVariantAssignmentsTable)
          .where(inArray(bellVariantAssignmentsTable.scheduleId, scheduleIds)),
      ])
    : [[], []];
  return schedules.map((s) => ({
    ...s,
    periods: periods.filter((p) => p.scheduleId === s.id),
    variants: variants
      .filter((v) => v.scheduleId === s.id)
      .map((v) => ({
        ...v,
        blocks: blocks.filter((b) => b.variantId === v.id),
        grades: assignments
          .filter((a) => a.variantId === v.id && a.kind === "grade")
          .map((a) => a.value),
      })),
  }));
}

router.get(
  "/bell-schedules",
  requireAccess(),
  async (req: Request, res: Response) => {
    try {
      const schoolId = requireSchool(req, res);
      if (!schoolId) return;
      const data = await listSchedules(schoolId);
      res.json({ schedules: data });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

// Read-only "what's the active schedule and its periods" endpoint usable by
// any signed-in staff member (teachers need it so the Class Log can
// autodetect the current period). Returns just the periods of the school's
// default schedule — no schedule-management metadata.
router.get(
  "/bell-schedules/active",
  async (req: Request, res: Response) => {
    try {
      const staff = await loadStaff(req);
      if (!staff) {
        res.status(401).json({ error: "Sign-in required" });
        return;
      }
      const schoolId = requireSchool(req, res);
      if (!schoolId) return;
      // MULTI-SCHEDULE: serve the requested grade's variant (?grade=7) or
      // the Day Type's default variant. The legacy `periods` shape is kept
      // for existing clients (Class Log current-period autodetect); the
      // full typed `blocks` list rides alongside.
      const ctx = await loadDayTypeContext(schoolId);
      if (ctx.status !== "ok" || !ctx.dayType) {
        res.json({ schedule: null, periods: [], blocks: [], variant: null });
        return;
      }
      const gradeParam =
        typeof req.query.grade === "string" && req.query.grade.trim() !== ""
          ? req.query.grade.trim()
          : null;
      const variant = gradeParam
        ? variantForGrade(ctx, gradeParam)
        : ctx.defaultVariant;
      const fmt = (min: number) =>
        `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
      const blocks = (variant?.blocks ?? []).map((b) => ({
        blockType: b.blockType,
        periodNumber: b.periodNumber,
        name: b.name,
        startTime: fmt(b.startMin),
        endTime: fmt(b.endMin),
        includedInOnTimeStreak: b.includedInOnTimeStreak,
      }));
      res.json({
        schedule: {
          id: ctx.dayType.id,
          name: ctx.dayType.name,
          kind: ctx.dayType.kind,
        },
        variant: variant
          ? { id: variant.id, name: variant.name, isDefault: variant.isDefault }
          : null,
        periods: blocks
          .filter((b) => b.blockType === "period" && b.periodNumber != null)
          .map((b) => ({
            periodNumber: b.periodNumber as number,
            name: b.name,
            startTime: b.startTime,
            endTime: b.endTime,
            includedInOnTimeStreak: b.includedInOnTimeStreak,
          }))
          .sort((a, b) => a.periodNumber - b.periodNumber),
        blocks,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

router.post(
  "/bell-schedules",
  requireAccess(),
  async (req: Request, res: Response) => {
    try {
      const schoolId = requireSchool(req, res);
      if (!schoolId) return;
      const b = (req.body ?? {}) as Record<string, unknown>;
      const name = typeof b.name === "string" ? b.name.trim() : "";
      if (!name) {
        res.status(400).json({ error: "name is required" });
        return;
      }
      const kind = typeof b.kind === "string" ? b.kind : "regular";
      if (!KINDS.has(kind)) {
        res.status(400).json({
          error: `kind must be one of ${Array.from(KINDS).join(", ")}`,
        });
        return;
      }
      const isDefault = b.isDefault === true;
      const periodsParsed = parsePeriods(b.periods ?? []);
      if (typeof periodsParsed === "string") {
        res.status(400).json({ error: periodsParsed });
        return;
      }
      await db.transaction(async (tx) => {
        if (isDefault) {
          // Only clear the default within THIS school.
          await tx
            .update(bellSchedulesTable)
            .set({ isDefault: false })
            .where(
              and(
                eq(bellSchedulesTable.isDefault, true),
                eq(bellSchedulesTable.schoolId, schoolId),
              ),
            );
        }
        const [created] = await tx
          .insert(bellSchedulesTable)
          .values({ schoolId, name, kind, isDefault, active: true })
          .returning();
        if (!created) throw new Error("Failed to create schedule");
        await tx
          .insert(bellSchedulePeriodsTable)
          .values(periodsParsed.map((p) => ({ ...p, scheduleId: created.id })));
        // Mirror into the Day Type's default variant — the schedule
        // resolver only reads variants.
        await syncDefaultVariantFromPeriods(tx, created.id, periodsParsed);
      });
      const data = await listSchedules(schoolId);
      res.status(201).json({ schedules: data });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

router.put(
  "/bell-schedules/:id",
  requireAccess(),
  async (req: Request, res: Response) => {
    try {
      const schoolId = requireSchool(req, res);
      if (!schoolId) return;
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ error: "Invalid id" });
        return;
      }
      const [existing] = await db
        .select()
        .from(bellSchedulesTable)
        .where(
          and(
            eq(bellSchedulesTable.id, id),
            eq(bellSchedulesTable.schoolId, schoolId),
          ),
        );
      if (!existing) {
        res.status(404).json({ error: "Schedule not found" });
        return;
      }
      const b = (req.body ?? {}) as Record<string, unknown>;
      const updates: Partial<typeof bellSchedulesTable.$inferInsert> = {};
      if (typeof b.name === "string") {
        const v = b.name.trim();
        if (!v) {
          res.status(400).json({ error: "name must not be empty" });
          return;
        }
        updates.name = v;
      }
      if (typeof b.kind === "string") {
        if (!KINDS.has(b.kind)) {
          res.status(400).json({
            error: `kind must be one of ${Array.from(KINDS).join(", ")}`,
          });
          return;
        }
        updates.kind = b.kind;
      }
      if (typeof b.active === "boolean") updates.active = b.active;

      let periodsParsed: PeriodInput[] | null = null;
      if (b.periods !== undefined) {
        const parsed = parsePeriods(b.periods);
        if (typeof parsed === "string") {
          res.status(400).json({ error: parsed });
          return;
        }
        periodsParsed = parsed;
      }
      const setDefault = b.isDefault === true;

      await db.transaction(async (tx) => {
        if (setDefault) {
          // Only clear the default within THIS school.
          await tx
            .update(bellSchedulesTable)
            .set({ isDefault: false })
            .where(
              and(
                eq(bellSchedulesTable.isDefault, true),
                eq(bellSchedulesTable.schoolId, schoolId),
              ),
            );
          updates.isDefault = true;
        }
        if (Object.keys(updates).length > 0) {
          await tx
            .update(bellSchedulesTable)
            .set(updates)
            .where(
              and(
                eq(bellSchedulesTable.id, id),
                eq(bellSchedulesTable.schoolId, schoolId),
              ),
            );
        }
        if (periodsParsed !== null) {
          await tx
            .delete(bellSchedulePeriodsTable)
            .where(eq(bellSchedulePeriodsTable.scheduleId, id));
          await tx
            .insert(bellSchedulePeriodsTable)
            .values(periodsParsed.map((p) => ({ ...p, scheduleId: id })));
          // Keep the resolver's view (default variant blocks) in lockstep
          // with the legacy period editor.
          await syncDefaultVariantFromPeriods(tx, id, periodsParsed);
        }
      });
      const data = await listSchedules(schoolId);
      res.json({ schedules: data });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

router.delete(
  "/bell-schedules/:id",
  requireAccess(),
  async (req: Request, res: Response) => {
    try {
      const schoolId = requireSchool(req, res);
      if (!schoolId) return;
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ error: "Invalid id" });
        return;
      }
      const [existing] = await db
        .select()
        .from(bellSchedulesTable)
        .where(
          and(
            eq(bellSchedulesTable.id, id),
            eq(bellSchedulesTable.schoolId, schoolId),
          ),
        );
      if (!existing) {
        res.status(404).json({ error: "Schedule not found" });
        return;
      }
      await db
        .delete(bellSchedulesTable)
        .where(
          and(
            eq(bellSchedulesTable.id, id),
            eq(bellSchedulesTable.schoolId, schoolId),
          ),
        );
      const data = await listSchedules(schoolId);
      res.json({ schedules: data });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

// ---------------------------------------------------------------------------
// Variant management endpoints (Day Type → variants → blocks/grades).
// ---------------------------------------------------------------------------

async function loadOwnedSchedule(schoolId: number, id: number) {
  const [s] = await db
    .select()
    .from(bellSchedulesTable)
    .where(
      and(
        eq(bellSchedulesTable.id, id),
        eq(bellSchedulesTable.schoolId, schoolId),
      ),
    );
  return s ?? null;
}

// POST /bell-schedules/:id/variants  { name, isDefault?, blocks, grades? }
router.post(
  "/bell-schedules/:id/variants",
  requireAccess(),
  async (req: Request, res: Response) => {
    try {
      const schoolId = requireSchool(req, res);
      if (!schoolId) return;
      const id = Number(req.params.id);
      const sched = Number.isInteger(id) && id > 0
        ? await loadOwnedSchedule(schoolId, id)
        : null;
      if (!sched) {
        res.status(404).json({ error: "Schedule not found" });
        return;
      }
      const b = (req.body ?? {}) as Record<string, unknown>;
      const name = typeof b.name === "string" ? b.name.trim() : "";
      if (!name) {
        res.status(400).json({ error: "name is required" });
        return;
      }
      const blocksParsed = parseBlocks(b.blocks ?? []);
      if (typeof blocksParsed === "string") {
        res.status(400).json({ error: blocksParsed });
        return;
      }
      const gradesParsed =
        b.grades !== undefined ? parseGrades(b.grades) : [];
      if (typeof gradesParsed === "string") {
        res.status(400).json({ error: gradesParsed });
        return;
      }
      const isDefault = b.isDefault === true;
      // Duplicate-grade guard: a grade may belong to exactly ONE variant
      // of a Day Type.
      if (gradesParsed.length > 0) {
        const existing = await db
          .select({ value: bellVariantAssignmentsTable.value })
          .from(bellVariantAssignmentsTable)
          .where(
            and(
              eq(bellVariantAssignmentsTable.scheduleId, sched.id),
              eq(bellVariantAssignmentsTable.kind, "grade"),
              inArray(bellVariantAssignmentsTable.value, gradesParsed),
            ),
          );
        if (existing.length > 0) {
          res.status(409).json({
            error: `Grade ${existing[0].value} is already assigned to another schedule variant`,
          });
          return;
        }
      }
      await db.transaction(async (tx) => {
        if (isDefault) {
          await tx
            .update(bellScheduleVariantsTable)
            .set({ isDefault: false })
            .where(eq(bellScheduleVariantsTable.scheduleId, sched.id));
        }
        const [variant] = await tx
          .insert(bellScheduleVariantsTable)
          .values({ scheduleId: sched.id, name, isDefault, sortOrder: 99 })
          .returning();
        await tx.insert(bellVariantBlocksTable).values(
          blocksParsed.map((blk) => ({ ...blk, variantId: variant.id })),
        );
        if (gradesParsed.length > 0) {
          await tx.insert(bellVariantAssignmentsTable).values(
            gradesParsed.map((g) => ({
              scheduleId: sched.id,
              variantId: variant.id,
              kind: "grade",
              value: g,
            })),
          );
        }
      });
      res.status(201).json({ schedules: await listSchedules(schoolId) });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

// PUT /bell-schedules/:id/variants/:variantId  { name?, isDefault?, blocks?, grades? }
router.put(
  "/bell-schedules/:id/variants/:variantId",
  requireAccess(),
  async (req: Request, res: Response) => {
    try {
      const schoolId = requireSchool(req, res);
      if (!schoolId) return;
      const id = Number(req.params.id);
      const variantId = Number(req.params.variantId);
      const sched =
        Number.isInteger(id) && id > 0
          ? await loadOwnedSchedule(schoolId, id)
          : null;
      if (!sched) {
        res.status(404).json({ error: "Schedule not found" });
        return;
      }
      const [variant] = await db
        .select()
        .from(bellScheduleVariantsTable)
        .where(
          and(
            eq(bellScheduleVariantsTable.id, variantId),
            eq(bellScheduleVariantsTable.scheduleId, sched.id),
          ),
        );
      if (!variant) {
        res.status(404).json({ error: "Variant not found" });
        return;
      }
      const b = (req.body ?? {}) as Record<string, unknown>;
      let name: string | null = null;
      if (typeof b.name === "string") {
        name = b.name.trim();
        if (!name) {
          res.status(400).json({ error: "name must not be empty" });
          return;
        }
      }
      let blocksParsed: BlockInput[] | null = null;
      if (b.blocks !== undefined) {
        const parsed = parseBlocks(b.blocks);
        if (typeof parsed === "string") {
          res.status(400).json({ error: parsed });
          return;
        }
        blocksParsed = parsed;
      }
      let gradesParsed: string[] | null = null;
      if (b.grades !== undefined) {
        const parsed = parseGrades(b.grades);
        if (typeof parsed === "string") {
          res.status(400).json({ error: parsed });
          return;
        }
        gradesParsed = parsed;
        // Duplicate-grade guard against OTHER variants of this Day Type.
        if (gradesParsed.length > 0) {
          const clash = await db
            .select({ value: bellVariantAssignmentsTable.value })
            .from(bellVariantAssignmentsTable)
            .where(
              and(
                eq(bellVariantAssignmentsTable.scheduleId, sched.id),
                eq(bellVariantAssignmentsTable.kind, "grade"),
                inArray(bellVariantAssignmentsTable.value, gradesParsed),
                ne(bellVariantAssignmentsTable.variantId, variant.id),
              ),
            );
          if (clash.length > 0) {
            res.status(409).json({
              error: `Grade ${clash[0].value} is already assigned to another schedule variant`,
            });
            return;
          }
        }
      }
      const setDefault = b.isDefault === true;
      // Guard: un-defaulting is only possible by defaulting another
      // variant; a Day Type must always keep exactly one default.
      if (b.isDefault === false && variant.isDefault) {
        res.status(400).json({
          error:
            "Make another variant the default instead — every Day Type needs one default schedule.",
        });
        return;
      }
      await db.transaction(async (tx) => {
        if (setDefault && !variant.isDefault) {
          await tx
            .update(bellScheduleVariantsTable)
            .set({ isDefault: false })
            .where(eq(bellScheduleVariantsTable.scheduleId, sched.id));
        }
        if (name !== null || (setDefault && !variant.isDefault)) {
          await tx
            .update(bellScheduleVariantsTable)
            .set({
              ...(name !== null ? { name } : {}),
              ...(setDefault ? { isDefault: true } : {}),
            })
            .where(eq(bellScheduleVariantsTable.id, variant.id));
        }
        if (blocksParsed !== null) {
          await tx
            .delete(bellVariantBlocksTable)
            .where(eq(bellVariantBlocksTable.variantId, variant.id));
          await tx.insert(bellVariantBlocksTable).values(
            blocksParsed.map((blk) => ({ ...blk, variantId: variant.id })),
          );
        }
        if (gradesParsed !== null) {
          await tx
            .delete(bellVariantAssignmentsTable)
            .where(
              and(
                eq(bellVariantAssignmentsTable.variantId, variant.id),
                eq(bellVariantAssignmentsTable.kind, "grade"),
              ),
            );
          if (gradesParsed.length > 0) {
            await tx.insert(bellVariantAssignmentsTable).values(
              gradesParsed.map((g) => ({
                scheduleId: sched.id,
                variantId: variant.id,
                kind: "grade",
                value: g,
              })),
            );
          }
        }
      });
      res.json({ schedules: await listSchedules(schoolId) });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

// DELETE /bell-schedules/:id/variants/:variantId
router.delete(
  "/bell-schedules/:id/variants/:variantId",
  requireAccess(),
  async (req: Request, res: Response) => {
    try {
      const schoolId = requireSchool(req, res);
      if (!schoolId) return;
      const id = Number(req.params.id);
      const variantId = Number(req.params.variantId);
      const sched =
        Number.isInteger(id) && id > 0
          ? await loadOwnedSchedule(schoolId, id)
          : null;
      if (!sched) {
        res.status(404).json({ error: "Schedule not found" });
        return;
      }
      const [variant] = await db
        .select()
        .from(bellScheduleVariantsTable)
        .where(
          and(
            eq(bellScheduleVariantsTable.id, variantId),
            eq(bellScheduleVariantsTable.scheduleId, sched.id),
          ),
        );
      if (!variant) {
        res.status(404).json({ error: "Variant not found" });
        return;
      }
      if (variant.isDefault) {
        res.status(409).json({
          error:
            "The default variant can't be deleted — make another variant the default first.",
        });
        return;
      }
      // Cascades take blocks + assignments with it (FK ON DELETE CASCADE).
      await db
        .delete(bellScheduleVariantsTable)
        .where(eq(bellScheduleVariantsTable.id, variant.id));
      res.json({ schedules: await listSchedules(schoolId) });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

export default router;
