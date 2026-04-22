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
  staffTable,
} from "@workspace/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { verifyAuthToken } from "../lib/authToken.js";
import { requireSchool } from "../lib/scope.js";

const router: IRouter = Router();

type StaffRow = typeof staffTable.$inferSelect;

async function loadStaff(req: Request): Promise<StaffRow | null> {
  let id = req.staffId ?? null;
  if (!id) {
    const auth = req.headers.authorization;
    if (typeof auth === "string" && auth.startsWith("Bearer ")) {
      id = verifyAuthToken(auth.slice(7).trim());
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
    out.push({ periodNumber, name, startTime, endTime });
  }
  return out;
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
  return schedules.map((s) => ({
    ...s,
    periods: periods.filter((p) => p.scheduleId === s.id),
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

export default router;
