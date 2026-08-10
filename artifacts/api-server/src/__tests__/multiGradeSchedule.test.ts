// Multi-grade bell schedule architecture — pure-function tests over the
// central schedule resolver and the on-time attendance window math.
//
// Scenario (from the spec): one "Regular Day" Day Type with three
// simultaneous variants. Grade 6 has early lunch, Grade 7 mid lunch,
// Grade 8 late lunch; period start/end times differ around lunch.
import { describe, it, expect } from "vitest";
import {
  blockContextAt,
  contextForVariant,
  variantForGrade,
  hmToMin,
  type DayTypeContext,
  type ScheduleBlock,
  type ScheduleVariant,
} from "../lib/scheduleResolver.js";
import {
  computeWindow,
  attendanceWindowForGrade,
  POST_BELL_GRACE_MIN,
} from "../lib/onTimeAttendance.js";

let nextBlockId = 1;
function blk(
  blockType: string,
  name: string,
  start: string,
  end: string,
  periodNumber: number | null = null,
): ScheduleBlock {
  return {
    id: nextBlockId++,
    blockType,
    periodNumber,
    name,
    startMin: hmToMin(start)!,
    endMin: hmToMin(end)!,
    includedInOnTimeStreak: blockType === "period",
  };
}

function variant(
  id: number,
  name: string,
  isDefault: boolean,
  grades: string[],
  blocks: ScheduleBlock[],
): ScheduleVariant {
  return {
    id,
    name,
    isDefault,
    gradeValues: grades,
    blocks: [...blocks].sort((a, b) => a.startMin - b.startMin),
  };
}

// Grade 6: early lunch (10:50–11:20), P4 runs 11:20–12:10.
const g6 = variant(61, "Grade 6", false, ["6"], [
  blk("period", "P1", "08:00", "08:50", 1),
  blk("period", "P2", "08:55", "09:45", 2),
  blk("period", "P3", "09:50", "10:40", 3),
  blk("lunch", "Lunch A", "10:50", "11:20"),
  blk("period", "P4", "11:20", "12:10", 4),
  blk("period", "P5", "12:15", "13:05", 5),
]);
// Grade 7: mid lunch (11:30–12:00); P4 BEFORE lunch (10:45–11:30).
const g7 = variant(71, "Grade 7", false, ["7"], [
  blk("period", "P1", "08:00", "08:50", 1),
  blk("period", "P2", "08:55", "09:45", 2),
  blk("period", "P3", "09:50", "10:40", 3),
  blk("period", "P4", "10:45", "11:30", 4),
  blk("lunch", "Lunch B", "11:30", "12:00"),
  blk("period", "P5", "12:05", "13:05", 5),
]);
// Grade 8 = default variant: late lunch (12:10–12:40).
const g8 = variant(81, "Grade 8", true, ["8"], [
  blk("period", "P1", "08:00", "08:50", 1),
  blk("period", "P2", "08:55", "09:45", 2),
  blk("period", "P3", "09:50", "10:40", 3),
  blk("period", "P4", "10:45", "11:35", 4),
  blk("period", "P5", "11:40", "12:10", 5),
  blk("lunch", "Lunch C", "12:10", "12:40"),
]);

const ctx: DayTypeContext = {
  status: "ok",
  schoolId: 1,
  timezone: "America/New_York",
  dayType: { id: 9, name: "Regular Day", kind: "regular" },
  variants: [g6, g7, g8],
  gradeAssignment: new Map([
    ["6", 61],
    ["7", 71],
    ["8", 81],
  ]),
  defaultVariant: g8,
};

const noSchedule: DayTypeContext = {
  status: "no_day_type",
  schoolId: 2,
  timezone: "America/New_York",
  dayType: null,
  variants: [],
  gradeAssignment: new Map(),
  defaultVariant: null,
};

describe("variantForGrade", () => {
  it("routes each grade to its own variant", () => {
    expect(variantForGrade(ctx, 6)?.id).toBe(61);
    expect(variantForGrade(ctx, "7")?.id).toBe(71);
    expect(variantForGrade(ctx, 8)?.id).toBe(81);
  });
  it("falls back to the default variant for unassigned grades", () => {
    expect(variantForGrade(ctx, 5)?.id).toBe(81);
    expect(variantForGrade(ctx, null)?.id).toBe(81);
  });
});

describe("contextForVariant — simultaneous different answers", () => {
  // 11:00 AM: Grade 6 is AT LUNCH, Grade 7 is in P4, Grade 8 is in P4.
  const at = (hm: string) => hmToMin(hm)!;
  it("11:00 — G6 lunch, G7 P4, G8 P4", () => {
    const c6 = contextForVariant(ctx, g6, new Date(), at("11:00"));
    expect(c6.isLunch).toBe(true);
    expect(c6.periodNumber).toBeNull();
    const c7 = contextForVariant(ctx, g7, new Date(), at("11:00"));
    expect(c7.isLunch).toBe(false);
    expect(c7.periodNumber).toBe(4);
    const c8 = contextForVariant(ctx, g8, new Date(), at("11:00"));
    expect(c8.periodNumber).toBe(4);
  });
  it("11:45 — G6 P4, G7 lunch, G8 P5", () => {
    expect(contextForVariant(ctx, g6, new Date(), at("11:45")).periodNumber).toBe(4);
    expect(contextForVariant(ctx, g7, new Date(), at("11:45")).isLunch).toBe(true);
    expect(contextForVariant(ctx, g8, new Date(), at("11:45")).periodNumber).toBe(5);
  });
});

describe("blockContextAt — exact boundary times", () => {
  const at = (hm: string) => hmToMin(hm)!;
  it("block start is inclusive, block end is exclusive", () => {
    // 10:40 = exact end of P3 for G6 → passing (gap before lunch).
    const cEnd = blockContextAt(g6.blocks, at("10:40"));
    expect(cEnd.phase).toBe("passing");
    expect(cEnd.currentBlock).toBeNull();
    // 10:50 = exact start of G6 lunch → in lunch.
    const cStart = blockContextAt(g6.blocks, at("10:50"));
    expect(cStart.phase).toBe("in_block");
    expect(cStart.currentBlock?.blockType).toBe("lunch");
    // 11:20 = G6 lunch ends AND P4 starts simultaneously → P4 wins.
    const cFlip = blockContextAt(g6.blocks, at("11:20"));
    expect(cFlip.phase).toBe("in_block");
    expect(cFlip.currentBlock?.periodNumber).toBe(4);
  });
  it("before and after school phases", () => {
    expect(blockContextAt(g6.blocks, at("06:30")).phase).toBe("before_school");
    expect(blockContextAt(g6.blocks, at("14:00")).phase).toBe("after_school");
  });
});

describe("computeWindow — on-time credit per variant", () => {
  const dayKey = "2026-08-07";
  const winPeriods = (v: ScheduleVariant) =>
    v.blocks.map((b) => ({
      periodNumber: b.periodNumber ?? 0,
      name: b.name,
      start: b.startMin,
      end: b.endMin,
      included:
        b.blockType === "period" &&
        b.periodNumber != null &&
        b.includedInOnTimeStreak,
    }));
  it("post-bell grace inside a period", () => {
    const w = computeWindow(9, "s9:v61", winPeriods(g6), hmToMin("08:05")!, dayKey);
    expect(w.phase).toBe("post_bell");
    expect(w.incomingPeriodNumber).toBe(1);
    expect(w.periodKey).toBe(`s9:v61:p1:${dayKey}`);
  });
  it("grace boundary is exclusive at start+grace", () => {
    const w = computeWindow(
      9,
      "s9:v61",
      winPeriods(g6),
      hmToMin("08:00")! + POST_BELL_GRACE_MIN,
      dayKey,
    );
    expect(w.phase).not.toBe("post_bell");
  });
  it("lunch never earns credit, but its end opens the next passing window", () => {
    // G6 at 11:00 = in lunch → off (no credit during lunch).
    expect(computeWindow(9, "s9:v61", winPeriods(g6), hmToMin("11:00")!, dayKey).phase).toBe("off");
    // G6 at 10:42 (after P3 ends 10:40, before lunch 10:50): the next
    // upcoming block is LUNCH which is excluded → no credit window.
    expect(computeWindow(9, "s9:v61", winPeriods(g6), hmToMin("10:42")!, dayKey).phase).toBe("off");
    // G7 at 12:02 (lunch ended 12:00, P5 starts 12:05) → passing toward P5.
    const w7 = computeWindow(9, "s9:v71", winPeriods(g7), hmToMin("12:02")!, dayKey);
    expect(w7.phase).toBe("passing");
    expect(w7.incomingPeriodNumber).toBe(5);
  });
  it("same wall-clock minute gives different periods per grade", () => {
    const min = hmToMin("11:22")!;
    const w6 = computeWindow(9, "s9:v61", winPeriods(g6), min, dayKey);
    const w8 = computeWindow(9, "s9:v81", winPeriods(g8), min, dayKey);
    expect(w6.incomingPeriodNumber).toBe(4); // G6 P4 started 11:20 (grace)
    expect(w8.phase).toBe("off"); // G8 mid-P4 (started 10:45), no credit
    expect(w6.periodKey).toContain(":v61:");
  });
});

describe("computeWindow — explicit passing blocks bridge to the next period", () => {
  const dayKey = "2026-08-07";
  // P3 09:50–10:40 → explicit Passing 10:40–10:45 → P4 10:45–11:35.
  const periods = [
    { periodNumber: 3, name: "P3", start: hmToMin("09:50")!, end: hmToMin("10:40")!, included: true },
    { periodNumber: 0, name: "Passing", start: hmToMin("10:40")!, end: hmToMin("10:45")!, included: false, bridge: true },
    { periodNumber: 4, name: "P4", start: hmToMin("10:45")!, end: hmToMin("11:35")!, included: true },
  ];
  it("window stays open across the passing block toward P4", () => {
    const w = computeWindow(9, "s9:v1", periods, hmToMin("10:42")!, dayKey);
    expect(w.phase).toBe("passing");
    expect(w.incomingPeriodNumber).toBe(4);
  });
  it("lunch (non-bridge) still keeps the window closed while it runs", () => {
    const withLunch = [
      { periodNumber: 3, name: "P3", start: hmToMin("09:50")!, end: hmToMin("10:40")!, included: true },
      { periodNumber: 0, name: "Lunch", start: hmToMin("10:40")!, end: hmToMin("11:10")!, included: false },
      { periodNumber: 4, name: "P4", start: hmToMin("11:10")!, end: hmToMin("12:00")!, included: true },
    ];
    expect(computeWindow(9, "s9:v1", withLunch, hmToMin("10:50")!, dayKey).phase).toBe("off");
    // Lunch end opens the P4 window (zero-gap: exactly at 11:10 = post-bell).
    const w = computeWindow(9, "s9:v1", withLunch, hmToMin("11:10")!, dayKey);
    expect(w.phase).toBe("post_bell");
    expect(w.incomingPeriodNumber).toBe(4);
  });
});

describe("attendanceWindowForGrade — end-to-end per-grade windows", () => {
  const env = {
    ctx,
    effNow: new Date("2026-08-07T15:22:00Z"),
    nowMin: hmToMin("11:22")!,
    dayKey: "2026-08-07",
    testLoop: false,
    hasGradeVariants: true,
  };
  it("grade 6 gets post-bell credit at 11:22 while grade 8 is off", () => {
    const w6 = attendanceWindowForGrade(env as never, 6);
    const w8 = attendanceWindowForGrade(env as never, 8);
    expect(w6.phase).toBe("post_bell");
    expect(w6.incomingPeriodNumber).toBe(4);
    expect(w8.phase).toBe("off");
  });
  it("default-variant fallback for unassigned grade", () => {
    const w5 = attendanceWindowForGrade(env as never, 5);
    expect(w5.phase).toBe("off"); // follows G8 default timing
  });
});

describe("unconfigured school fails explicitly, never guesses", () => {
  it("variantForGrade returns null with no Day Type", () => {
    expect(variantForGrade(noSchedule, 6)).toBeNull();
  });
  it("contextForVariant reports no_variant/no_day_type", () => {
    const c = contextForVariant(noSchedule, null, new Date(), hmToMin("10:00")!);
    expect(c.status).not.toBe("ok");
    expect(c.periodNumber).toBeNull();
    expect(c.phase).toBe("before_school");
  });
  it("computeWindow with no schedule stays off", () => {
    expect(computeWindow(null, "", [], 600, "2026-08-07").phase).toBe("off");
  });
});

describe("no-default-variant config is explicitly not-configured", () => {
  it("variantForGrade returns null for unassigned grades (never guesses)", () => {
    const broken: DayTypeContext = {
      ...ctx,
      status: "no_default",
      defaultVariant: null,
    };
    // Assigned grade still resolves; unassigned grade gets NULL, not a guess.
    expect(variantForGrade(broken, 5)).toBeNull();
  });
});
