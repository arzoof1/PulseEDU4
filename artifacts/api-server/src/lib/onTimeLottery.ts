// Tardy Lottery (On-Time Attendance Phase 1.5).
//
// Once per school per day, at a configurable lead time before the end of the
// school day, we pick ONE random eligible class that ran On-Time Attendance
// and award every present student a bonus. The draw happens at reveal time
// FROM already-closed periods, so the winner is unknowable in advance — the
// on_time_lottery_draws row is the tamper-evident record.
//
// Eligible class = a (teacher, period) that had >=1 on-time check-in today,
// whose period window has already closed, and which is NOT the teacher's
// planning period.
//
// Winners = every student with an on-time check-in in that class today
// (including flat-1 post-bell scans). Each gets a kind='lottery' bonus row in
// attendance_checkins (counts toward house standings, never the
// Invisible-Student calc), keyed `lottery:<day>` so it's one bonus per
// student per day and a re-run can't double-award.
//
// SINGLE-RUNNER ASSUMPTION mirrors weeklyHeartbeatEmail.ts. The unique index
// on (school_id, day) is the real guard: the draw row is inserted with
// onConflictDoNothing BEFORE any bonus rows are written, so only the run that
// wins the insert performs the award. No advisory lock needed.

import {
  db,
  attendanceCheckinsTable,
  onTimeLotteryDrawsTable,
  schoolSettingsTable,
  classSectionsTable,
  staffTable,
  schoolsTable,
} from "@workspace/db";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { loadDefaultSchedulePeriods } from "./onTimeAttendance.js";
import { isCoreTeam } from "./coreTeam.js";
import { getUncachableResendClient } from "./resendClient.js";
import { logger } from "./logger.js";

export type LotteryDrawStatus = "revealed" | "skipped" | "not_due" | "already";

export interface LotteryRunResult {
  schoolId: number;
  status: LotteryDrawStatus;
  reason?: string;
  periodNumber?: number;
  teacherName?: string;
  winnerCount?: number;
  bonusPoints?: number;
  emailedTo?: number;
}

function localDayKey(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate(),
  ).padStart(2, "0")}`;
}

function hmToMinutes(hm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Notify admins / Core Team that the day's lottery has been drawn. Best
// effort — a send failure never blocks (or un-does) the award.
async function emailLotteryReveal(args: {
  schoolId: number;
  label: string;
  teacherName: string;
  periodNumber: number;
  courseName: string | null;
  winnerCount: number;
  bonusPoints: number;
}): Promise<number> {
  const recipientsRaw = await db
    .select({
      email: staffTable.email,
      isSuperUser: staffTable.isSuperUser,
      isDistrictAdmin: staffTable.isDistrictAdmin,
      isAdmin: staffTable.isAdmin,
      isBehaviorSpecialist: staffTable.isBehaviorSpecialist,
      isMtssCoordinator: staffTable.isMtssCoordinator,
      isSchoolPsychologist: staffTable.isSchoolPsychologist,
      isCoreTeam: staffTable.isCoreTeam,
    })
    .from(staffTable)
    .where(
      and(
        eq(staffTable.schoolId, args.schoolId),
        eq(staffTable.active, true),
        isNotNull(staffTable.email),
      ),
    );
  const recipients = recipientsRaw
    .filter((r) => isCoreTeam(r) && r.email)
    .map((r) => r.email as string);
  if (recipients.length === 0) return 0;

  let bundle: Awaited<ReturnType<typeof getUncachableResendClient>>;
  try {
    bundle = await getUncachableResendClient();
  } catch (err) {
    logger.warn({ err, schoolId: args.schoolId }, "[lottery] resend unavailable");
    return 0;
  }

  const [school] = await db
    .select({ name: schoolsTable.name })
    .from(schoolsTable)
    .where(eq(schoolsTable.id, args.schoolId));
  const schoolName = school?.name ?? "PulseEDU";
  const classLabel = args.courseName
    ? `${args.courseName} (Period ${args.periodNumber}, ${args.teacherName})`
    : `${args.teacherName} — Period ${args.periodNumber}`;

  const subject = `${args.label}: today's winning class is ${args.teacherName}'s Period ${args.periodNumber}`;
  const text =
    `Today's ${args.label} draw is in!\n\n` +
    `Winning class: ${classLabel}\n` +
    `Students rewarded: ${args.winnerCount}\n` +
    `Bonus each: ${args.bonusPoints} points (added to their house)\n\n` +
    `Announce it however you like — the points are already posted.\n— ${schoolName}`;
  const html =
    `<p>Today's <strong>${escapeHtml(args.label)}</strong> draw is in!</p>` +
    `<p><strong>Winning class:</strong> ${escapeHtml(classLabel)}<br/>` +
    `<strong>Students rewarded:</strong> ${args.winnerCount}<br/>` +
    `<strong>Bonus each:</strong> ${args.bonusPoints} points (added to their house)</p>` +
    `<p>Announce it however you like — the points are already posted.</p>` +
    `<p>— ${escapeHtml(schoolName)}</p>`;

  try {
    await bundle.client.emails.send({
      from: bundle.fromEmail,
      to: recipients,
      subject,
      text,
      html,
    });
    return recipients.length;
  } catch (err) {
    logger.warn({ err, schoolId: args.schoolId }, "[lottery] reveal email failed");
    return 0;
  }
}

async function drawForSchool(
  schoolId: number,
  label: string,
  bonusPoints: number,
  now: Date,
): Promise<LotteryRunResult> {
  const dayKey = localDayKey(now);

  // Already drawn (or skipped) today?
  const [existing] = await db
    .select({ id: onTimeLotteryDrawsTable.id })
    .from(onTimeLotteryDrawsTable)
    .where(
      and(
        eq(onTimeLotteryDrawsTable.schoolId, schoolId),
        eq(onTimeLotteryDrawsTable.day, dayKey),
      ),
    );
  if (existing) return { schoolId, status: "already" };

  const { scheduleId, periods } = await loadDefaultSchedulePeriods(schoolId);
  const nowMin = now.getHours() * 60 + now.getMinutes();

  // Period -> end-minute map for the "window already closed" check.
  const endByPeriod = new Map<number, number>();
  for (const p of periods) {
    const end = hmToMinutes(p.endTime);
    if (Number.isFinite(end)) endByPeriod.set(p.periodNumber, end);
  }

  // Distinct (teacher, period) that ran attendance today.
  const candidateRows = await db
    .select({
      staffId: attendanceCheckinsTable.staffId,
      periodNumber: attendanceCheckinsTable.periodNumber,
    })
    .from(attendanceCheckinsTable)
    .where(
      and(
        eq(attendanceCheckinsTable.schoolId, schoolId),
        eq(attendanceCheckinsTable.day, dayKey),
        eq(attendanceCheckinsTable.kind, "checkin"),
      ),
    )
    .groupBy(attendanceCheckinsTable.staffId, attendanceCheckinsTable.periodNumber);

  const eligible: Array<{ staffId: number; periodNumber: number }> = [];
  for (const c of candidateRows) {
    if (c.staffId === null) continue;
    // Window must have closed before reveal.
    const end = endByPeriod.get(c.periodNumber);
    if (end !== undefined && end > nowMin) continue;
    // Exclude the teacher's planning period.
    const [section] = await db
      .select({ isPlanning: classSectionsTable.isPlanning })
      .from(classSectionsTable)
      .where(
        and(
          eq(classSectionsTable.schoolId, schoolId),
          eq(classSectionsTable.teacherStaffId, c.staffId),
          eq(classSectionsTable.period, c.periodNumber),
        ),
      );
    if (section?.isPlanning) continue;
    eligible.push({ staffId: c.staffId, periodNumber: c.periodNumber });
  }

  if (eligible.length === 0) {
    await db
      .insert(onTimeLotteryDrawsTable)
      .values({
        schoolId,
        day: dayKey,
        scheduleId,
        status: "skipped",
        reason: "no_eligible_class",
        labelSnapshot: label,
        bonusPoints,
        winnerCount: 0,
      })
      .onConflictDoNothing();
    return { schoolId, status: "skipped", reason: "no_eligible_class" };
  }

  const pick = eligible[Math.floor(Math.random() * eligible.length)];

  // Winners = every present student in the picked class today.
  const winnerRows = await db
    .selectDistinct({ studentId: attendanceCheckinsTable.studentId })
    .from(attendanceCheckinsTable)
    .where(
      and(
        eq(attendanceCheckinsTable.schoolId, schoolId),
        eq(attendanceCheckinsTable.day, dayKey),
        eq(attendanceCheckinsTable.kind, "checkin"),
        eq(attendanceCheckinsTable.staffId, pick.staffId),
        eq(attendanceCheckinsTable.periodNumber, pick.periodNumber),
      ),
    );
  const winnerIds = winnerRows.map((r) => r.studentId);

  const [teacher] = await db
    .select({ displayName: staffTable.displayName })
    .from(staffTable)
    .where(eq(staffTable.id, pick.staffId));
  const teacherName = teacher?.displayName ?? "Unknown teacher";
  const [section] = await db
    .select({ id: classSectionsTable.id, courseName: classSectionsTable.courseName })
    .from(classSectionsTable)
    .where(
      and(
        eq(classSectionsTable.schoolId, schoolId),
        eq(classSectionsTable.teacherStaffId, pick.staffId),
        eq(classSectionsTable.period, pick.periodNumber),
      ),
    );

  // Insert the draw row FIRST (unique per school+day). If another runner beat
  // us to it, bail before awarding so we never double-post bonuses.
  const drawInserted = await db
    .insert(onTimeLotteryDrawsTable)
    .values({
      schoolId,
      day: dayKey,
      scheduleId,
      periodNumber: pick.periodNumber,
      sectionId: section?.id ?? null,
      teacherStaffId: pick.staffId,
      teacherName,
      courseName: section?.courseName ?? null,
      bonusPoints,
      winnerCount: winnerIds.length,
      labelSnapshot: label,
      status: "revealed",
    })
    .onConflictDoNothing()
    .returning({ id: onTimeLotteryDrawsTable.id });
  if (drawInserted.length === 0) return { schoolId, status: "already" };

  // Materialize the bonus rows (one lottery bonus per student per day).
  const lotteryKey = `lottery:${dayKey}`;
  if (winnerIds.length > 0) {
    await db
      .insert(attendanceCheckinsTable)
      .values(
        winnerIds.map((studentId) => ({
          schoolId,
          studentId,
          staffId: pick.staffId,
          scheduleId,
          periodNumber: pick.periodNumber,
          periodKey: lotteryKey,
          day: dayKey,
          kind: "lottery",
          points: bonusPoints,
          source: "lottery",
        })),
      )
      .onConflictDoNothing();
  }

  const emailedTo = await emailLotteryReveal({
    schoolId,
    label,
    teacherName,
    periodNumber: pick.periodNumber,
    courseName: section?.courseName ?? null,
    winnerCount: winnerIds.length,
    bonusPoints,
  });

  return {
    schoolId,
    status: "revealed",
    periodNumber: pick.periodNumber,
    teacherName,
    winnerCount: winnerIds.length,
    bonusPoints,
    emailedTo,
  };
}

// Cron entry point. Walks every school with the lottery enabled and, for any
// whose reveal time (last-period-end minus the school's lead) has arrived,
// performs the draw. Idempotent across the day via the unique draw row.
export async function runDueLotteryDraws(
  now: Date = new Date(),
): Promise<LotteryRunResult[]> {
  const schools = await db
    .select({
      schoolId: schoolSettingsTable.schoolId,
      enabled: schoolSettingsTable.onTimeLotteryEnabled,
      label: schoolSettingsTable.onTimeLotteryLabel,
      bonus: schoolSettingsTable.onTimeLotteryBonusPoints,
      lead: schoolSettingsTable.onTimeLotteryRevealLeadMinutes,
    })
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.onTimeLotteryEnabled, true));

  const results: LotteryRunResult[] = [];
  const nowMin = now.getHours() * 60 + now.getMinutes();

  for (const s of schools) {
    try {
      const { periods } = await loadDefaultSchedulePeriods(s.schoolId);
      if (periods.length === 0) {
        results.push({ schoolId: s.schoolId, status: "not_due", reason: "no_schedule" });
        continue;
      }
      let lastEnd = -1;
      for (const p of periods) {
        const end = hmToMinutes(p.endTime);
        if (Number.isFinite(end) && end > lastEnd) lastEnd = end;
      }
      if (lastEnd < 0) {
        results.push({ schoolId: s.schoolId, status: "not_due", reason: "no_schedule" });
        continue;
      }
      const revealMin = lastEnd - s.lead;
      if (nowMin < revealMin) {
        results.push({ schoolId: s.schoolId, status: "not_due" });
        continue;
      }
      results.push(await drawForSchool(s.schoolId, s.label, s.bonus, now));
    } catch (err) {
      logger.error({ err, schoolId: s.schoolId }, "[lottery] draw failed for school");
      results.push({ schoolId: s.schoolId, status: "not_due", reason: "error" });
    }
  }
  return results;
}
