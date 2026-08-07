import {
  db,
  bellSchedulesTable,
  bellScheduleVariantsTable,
  bellVariantBlocksTable,
  bellVariantAssignmentsTable,
  studentsTable,
  type BellScheduleVariantRow,
  type BellVariantBlockRow,
} from "@workspace/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { getSchoolTimezone } from "./schoolYear.js";

// ---------------------------------------------------------------------------
// Central schedule resolver — THE authoritative answer to "what period is it
// for THIS student?". One Day Type (the school's default active
// bell_schedules row) can contain multiple simultaneous schedule variants
// (Grade 6 / Grade 7 / ... / Default Schedule). Resolution:
//
//   student → grade → variant with a matching 'grade' assignment
//           → else the Day Type's default variant
//           → else status:"not_configured" (never guess).
//
// Nothing outside this module should compute current periods from
// bell_schedule_periods / bell_variant_blocks directly.
// ---------------------------------------------------------------------------

export interface ScheduleBlock {
  id: number;
  blockType: string; // period | lunch | passing | advisory | homeroom | custom
  periodNumber: number | null;
  name: string;
  startMin: number; // minutes since local midnight
  endMin: number;
  includedInOnTimeStreak: boolean;
}

export interface ScheduleVariant {
  id: number;
  name: string;
  isDefault: boolean;
  blocks: ScheduleBlock[]; // sorted by startMin
  // grade values assigned to this variant (kind='grade')
  gradeValues: string[];
}

export interface DayTypeContext {
  // "no_default" = variants exist but none is flagged default (inconsistent
  // config); treated as not-configured everywhere — we never guess.
  status: "ok" | "no_day_type" | "no_default";
  schoolId: number;
  timezone: string;
  dayType: { id: number; name: string; kind: string } | null;
  variants: ScheduleVariant[];
  // grade value ("6") → variant id
  gradeAssignment: Map<string, number>;
  defaultVariant: ScheduleVariant | null;
}

export type BlockPhase = "in_block" | "passing" | "before_school" | "after_school";

export interface ScheduleContext {
  status: "ok" | "no_day_type" | "no_variant";
  schoolId: number;
  timezone: string;
  dayType: { id: number; name: string; kind: string } | null;
  variant: { id: number; name: string; isDefault: boolean } | null;
  phase: BlockPhase;
  currentBlock: ScheduleBlock | null; // when phase = in_block
  previousBlock: ScheduleBlock | null;
  nextBlock: ScheduleBlock | null; // upcoming block (passing/before_school)
  periodNumber: number | null; // instructional period number, if in one
  isLunch: boolean;
  isPassing: boolean;
  minutesOfDay: number;
}

export function hmToMin(hm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(hm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mi)) return null;
  return h * 60 + mi;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();

export function minutesOfDayInTz(d: Date, tz: string): number {
  let fmt = fmtCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    fmtCache.set(tz, fmt);
  }
  const parts = fmt.formatToParts(d);
  let h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const mi = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const s = Number(parts.find((p) => p.type === "second")?.value ?? "0");
  if (h === 24) h = 0;
  return h * 60 + mi + s / 60;
}

// Load the school's active Day Type with all variants, blocks, and grade
// assignments in three queries. Callers reuse the context across many
// students (bulk paths) instead of re-querying per student.
export async function loadDayTypeContext(
  schoolId: number,
): Promise<DayTypeContext> {
  const timezone = await getSchoolTimezone(schoolId);
  const empty: DayTypeContext = {
    status: "no_day_type",
    schoolId,
    timezone,
    dayType: null,
    variants: [],
    gradeAssignment: new Map(),
    defaultVariant: null,
  };
  const [sched] = await db
    .select({
      id: bellSchedulesTable.id,
      name: bellSchedulesTable.name,
      kind: bellSchedulesTable.kind,
    })
    .from(bellSchedulesTable)
    .where(
      and(
        eq(bellSchedulesTable.schoolId, schoolId),
        eq(bellSchedulesTable.isDefault, true),
        eq(bellSchedulesTable.active, true),
      ),
    )
    .limit(1);
  if (!sched) return empty;

  const variantRows = await db
    .select()
    .from(bellScheduleVariantsTable)
    .where(eq(bellScheduleVariantsTable.scheduleId, sched.id))
    .orderBy(
      asc(bellScheduleVariantsTable.sortOrder),
      asc(bellScheduleVariantsTable.id),
    );
  if (variantRows.length === 0) {
    return { ...empty, dayType: sched, status: "no_day_type" };
  }
  const variantIds = variantRows.map((v) => v.id);
  const [blockRows, assignmentRows] = await Promise.all([
    db
      .select()
      .from(bellVariantBlocksTable)
      .where(inArray(bellVariantBlocksTable.variantId, variantIds)),
    db
      .select()
      .from(bellVariantAssignmentsTable)
      .where(eq(bellVariantAssignmentsTable.scheduleId, sched.id)),
  ]);

  const gradeAssignment = new Map<string, number>();
  const gradeValuesByVariant = new Map<number, string[]>();
  for (const a of assignmentRows) {
    if (a.kind !== "grade") continue;
    gradeAssignment.set(a.value, a.variantId);
    const list = gradeValuesByVariant.get(a.variantId) ?? [];
    list.push(a.value);
    gradeValuesByVariant.set(a.variantId, list);
  }

  const variants: ScheduleVariant[] = variantRows.map(
    (v: BellScheduleVariantRow) => ({
      id: v.id,
      name: v.name,
      isDefault: v.isDefault,
      blocks: blockRows
        .filter((b: BellVariantBlockRow) => b.variantId === v.id)
        .map((b) => {
          const startMin = hmToMin(b.startTime);
          const endMin = hmToMin(b.endTime);
          if (startMin == null || endMin == null) return null;
          return {
            id: b.id,
            blockType: b.blockType,
            periodNumber: b.periodNumber,
            name: b.name,
            startMin,
            endMin,
            includedInOnTimeStreak: b.includedInOnTimeStreak,
          } as ScheduleBlock;
        })
        .filter((b): b is ScheduleBlock => b !== null)
        .sort((a, b) => a.startMin - b.startMin),
      gradeValues: gradeValuesByVariant.get(v.id) ?? [],
    }),
  );

  const defaultVariant = variants.find((v) => v.isDefault) ?? null;
  return {
    // No default variant = explicitly not configured, never guess.
    status: defaultVariant ? "ok" : "no_default",
    schoolId,
    timezone,
    dayType: sched,
    variants,
    gradeAssignment,
    defaultVariant,
  };
}

// Variant for a grade: explicit assignment → default variant → null.
export function variantForGrade(
  ctx: DayTypeContext,
  grade: number | string | null | undefined,
): ScheduleVariant | null {
  if (grade !== null && grade !== undefined && grade !== "") {
    const id = ctx.gradeAssignment.get(String(grade));
    if (id !== undefined) {
      const v = ctx.variants.find((x) => x.id === id);
      if (v) return v;
    }
  }
  return ctx.defaultVariant;
}

// Pure block math for one variant at a given minutes-of-day.
export function blockContextAt(
  blocks: ScheduleBlock[],
  minutesOfDay: number,
): {
  phase: BlockPhase;
  currentBlock: ScheduleBlock | null;
  previousBlock: ScheduleBlock | null;
  nextBlock: ScheduleBlock | null;
} {
  if (blocks.length === 0) {
    return {
      phase: "before_school",
      currentBlock: null,
      previousBlock: null,
      nextBlock: null,
    };
  }
  // Inside a block? [start, end). On exact boundary shared by two blocks,
  // the LATER block wins (its start is inclusive; the earlier one's end is
  // exclusive) — no ambiguous overlap at boundaries.
  let previous: ScheduleBlock | null = null;
  let next: ScheduleBlock | null = null;
  for (const b of blocks) {
    if (minutesOfDay >= b.startMin && minutesOfDay < b.endMin) {
      // Prefer the latest-starting block containing now (handles an
      // intentional overlap: explicit precedence = latest start).
      const containing = blocks.filter(
        (x) => minutesOfDay >= x.startMin && minutesOfDay < x.endMin,
      );
      const current = containing[containing.length - 1];
      const idx = blocks.indexOf(current);
      return {
        phase: "in_block",
        currentBlock: current,
        previousBlock: idx > 0 ? blocks[idx - 1] : null,
        nextBlock: idx < blocks.length - 1 ? blocks[idx + 1] : null,
      };
    }
    if (b.endMin <= minutesOfDay) previous = b;
    if (b.startMin > minutesOfDay && next === null) next = b;
  }
  if (previous === null) {
    return {
      phase: "before_school",
      currentBlock: null,
      previousBlock: null,
      nextBlock: next,
    };
  }
  if (next === null) {
    return {
      phase: "after_school",
      currentBlock: null,
      previousBlock: previous,
      nextBlock: null,
    };
  }
  return {
    phase: "passing",
    currentBlock: null,
    previousBlock: previous,
    nextBlock: next,
  };
}

// Full schedule context for one variant at a wall-clock instant.
export function contextForVariant(
  ctx: DayTypeContext,
  variant: ScheduleVariant | null,
  now: Date,
  minutesOverride?: number,
): ScheduleContext {
  const minutesOfDay =
    minutesOverride !== undefined
      ? minutesOverride
      : minutesOfDayInTz(now, ctx.timezone);
  if (ctx.status !== "ok" || !ctx.dayType) {
    return {
      status: "no_day_type",
      schoolId: ctx.schoolId,
      timezone: ctx.timezone,
      dayType: null,
      variant: null,
      phase: "before_school",
      currentBlock: null,
      previousBlock: null,
      nextBlock: null,
      periodNumber: null,
      isLunch: false,
      isPassing: false,
      minutesOfDay,
    };
  }
  if (!variant) {
    return {
      status: "no_variant",
      schoolId: ctx.schoolId,
      timezone: ctx.timezone,
      dayType: ctx.dayType,
      variant: null,
      phase: "before_school",
      currentBlock: null,
      previousBlock: null,
      nextBlock: null,
      periodNumber: null,
      isLunch: false,
      isPassing: false,
      minutesOfDay,
    };
  }
  const bc = blockContextAt(variant.blocks, minutesOfDay);
  const cur = bc.currentBlock;
  return {
    status: "ok",
    schoolId: ctx.schoolId,
    timezone: ctx.timezone,
    dayType: ctx.dayType,
    variant: { id: variant.id, name: variant.name, isDefault: variant.isDefault },
    phase: bc.phase,
    currentBlock: cur,
    previousBlock: bc.previousBlock,
    nextBlock: bc.nextBlock,
    periodNumber: cur?.blockType === "period" ? cur.periodNumber : null,
    isLunch: cur?.blockType === "lunch",
    isPassing: bc.phase === "passing" || cur?.blockType === "passing",
    minutesOfDay,
  };
}

// Convenience: schedule context for a single student by id.
export async function getScheduleContextForStudent(
  schoolId: number,
  studentId: string,
  now: Date = new Date(),
): Promise<ScheduleContext & { grade: number | null }> {
  const [student] = await db
    .select({ grade: studentsTable.grade })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.schoolId, schoolId),
        eq(studentsTable.studentId, studentId),
      ),
    )
    .limit(1);
  const ctx = await loadDayTypeContext(schoolId);
  const grade = student?.grade ?? null;
  const variant = variantForGrade(ctx, grade);
  return { ...contextForVariant(ctx, variant, now), grade };
}

// Per-variant period windows (period_number → start/length) for lost
// instruction math. Returned alongside the grade resolver so bulk callers
// (tardy reports) can compute per-student minutes without re-querying.
export interface VariantPeriodWindows {
  ctx: DayTypeContext;
  windowsForGrade(grade: number | string | null | undefined): Map<
    number,
    { startMin: number; lengthMin: number | null }
  >;
}

export async function loadVariantPeriodWindows(
  schoolId: number,
): Promise<VariantPeriodWindows> {
  const ctx = await loadDayTypeContext(schoolId);
  const cache = new Map<
    number,
    Map<number, { startMin: number; lengthMin: number | null }>
  >();
  const build = (v: ScheduleVariant | null) => {
    if (!v) return new Map<number, { startMin: number; lengthMin: number | null }>();
    const hit = cache.get(v.id);
    if (hit) return hit;
    const m = new Map<number, { startMin: number; lengthMin: number | null }>();
    for (const b of v.blocks) {
      if (b.blockType !== "period" || b.periodNumber == null) continue;
      m.set(b.periodNumber, {
        startMin: b.startMin,
        lengthMin: b.endMin > b.startMin ? b.endMin - b.startMin : null,
      });
    }
    cache.set(v.id, m);
    return m;
  };
  return {
    ctx,
    windowsForGrade: (grade) => build(variantForGrade(ctx, grade)),
  };
}
