import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db, schoolSettingsTable, staffTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import { isCoreTeam } from "../lib/coreTeam.js";
import {
  effectiveNow,
  buildTestLoopWindow,
  TEST_LOOP_PASSING_SEC,
  TEST_LOOP_POST_BELL_SEC,
  TEST_LOOP_CYCLE_SEC,
} from "../lib/onTimeAttendance.js";
import { runLotteryNow } from "../lib/onTimeLottery.js";

// ---------------------------------------------------------------------------
// On-Time Attendance / Tardy Lottery TEST MODE admin endpoints.
//
// These power the "Testing" subsection of the On-Time Attendance & Lottery
// settings card. Every route is gated to Core Team (admins included) because
// the tools simulate the wall clock and force lottery draws — they must never
// be reachable by ordinary staff. See schoolSettings.ts for the columns and
// onTimeAttendance.ts for the time math.
// ---------------------------------------------------------------------------

const router: IRouter = Router();

// Core-Team gate. Loads the calling staff row and 403s anyone outside the
// Core Team power set.
async function requireCoreTeam(
  req: Request,
  res: Response,
  next: NextFunction,
) {
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
  if (!isCoreTeam(staff)) {
    res.status(403).json({ error: "Core Team access required" });
    return;
  }
  next();
}

function hhmm(d: Date): string {
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}

// "HH:MM" or "H:MM" -> minutes since midnight, or null if malformed/out of range.
function parseHHMM(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min)) return null;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

// GET /on-time/test/status — current test-mode state for the school. Drives
// the live readout in the settings panel.
router.get("/on-time/test/status", requireCoreTeam, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const [s] = await db
    .select({
      testLoop: schoolSettingsTable.onTimeTestLoopEnabled,
      simMinutes: schoolSettingsTable.onTimeSimClockMinutes,
      simSetAt: schoolSettingsTable.onTimeSimClockSetAt,
      lotteryEnabled: schoolSettingsTable.onTimeLotteryEnabled,
      attendanceEnabled: schoolSettingsTable.onTimeAttendanceEnabled,
    })
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, schoolId));

  const realNow = new Date();
  const simEnabled =
    (s?.simMinutes ?? null) !== null && (s?.simSetAt ?? null) !== null;
  const eff = effectiveNow(
    {
      onTimeSimClockMinutes: s?.simMinutes ?? null,
      onTimeSimClockSetAt: s?.simSetAt ?? null,
    },
    realNow,
  );

  const testLoop = Boolean(s?.testLoop);
  let loop: { phase: string; minutesRemaining: number; cycleSeconds: number } | null =
    null;
  if (testLoop) {
    const w = buildTestLoopWindow(realNow);
    loop = {
      phase: w.phase,
      minutesRemaining: w.minutesRemaining,
      cycleSeconds: TEST_LOOP_CYCLE_SEC,
    };
  }

  res.json({
    attendanceEnabled: Boolean(s?.attendanceEnabled),
    lotteryEnabled: Boolean(s?.lotteryEnabled),
    realNow: hhmm(realNow),
    simEnabled,
    simNow: simEnabled ? hhmm(eff) : null,
    testLoop,
    loop,
    loopConfig: {
      passingSeconds: TEST_LOOP_PASSING_SEC,
      postBellSeconds: TEST_LOOP_POST_BELL_SEC,
    },
  });
});

// POST /on-time/test/sim-clock { time: "HH:MM" } — set the demo clock. We
// anchor onTimeSimClockSetAt to the server's "now" so the simulated time
// advances naturally from the requested moment.
router.post("/on-time/test/sim-clock", requireCoreTeam, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const minutes = parseHHMM((req.body as { time?: unknown })?.time);
  if (minutes === null) {
    res.status(400).json({ error: "time must be HH:MM (00:00–23:59)" });
    return;
  }
  await db
    .update(schoolSettingsTable)
    .set({
      onTimeSimClockMinutes: minutes,
      onTimeSimClockSetAt: new Date(),
    })
    .where(eq(schoolSettingsTable.schoolId, schoolId));
  res.json({ ok: true });
});

// POST /on-time/test/sim-clock/clear — turn the demo clock off (back to real
// wall clock).
router.post(
  "/on-time/test/sim-clock/clear",
  requireCoreTeam,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    await db
      .update(schoolSettingsTable)
      .set({ onTimeSimClockMinutes: null, onTimeSimClockSetAt: null })
      .where(eq(schoolSettingsTable.schoolId, schoolId));
    res.json({ ok: true });
  },
);

// POST /on-time/test/loop { enabled: boolean } — toggle the synthetic
// passing→bell test loop.
router.post("/on-time/test/loop", requireCoreTeam, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const enabled = Boolean((req.body as { enabled?: unknown })?.enabled);
  await db
    .update(schoolSettingsTable)
    .set({ onTimeTestLoopEnabled: enabled })
    .where(eq(schoolSettingsTable.schoolId, schoolId));
  res.json({ ok: true, enabled });
});

// POST /on-time/lottery/run-now — force a lottery draw immediately, clearing
// any prior draw for today so a demo can re-run it.
router.post("/on-time/lottery/run-now", requireCoreTeam, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  try {
    const result = await runLotteryNow(schoolId);
    res.json(result);
  } catch {
    res.status(500).json({ error: "Lottery draw failed" });
  }
});

export default router;
