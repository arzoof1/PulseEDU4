// =============================================================================
// DISTRICT DEMO EXTRAS — idempotent, demo-school-only seed
// =============================================================================
// Fills the gaps the existing 7-school seed leaves open for the district demo
// on D. S. Parrott Middle School (school_id = 1):
//
//   1. Comp Time (FLSA) end-to-end workflow for a non-exempt (EST) employee —
//      four earn requests across every state (pending_preapproval → preapproved
//      → pending_confirm → confirmed) plus the ledger credit on confirm.
//   2. HeartBEAT meaningful connections — trusted-adult relationships for a set
//      of "known" students, leaving the naturally-invisible (0-PBIS) students
//      untouched so the "Invisible Student" contrast lands.
//   3. Academic Tier 3 small-group history — ~2 months of weekly minutes logs
//      for a few academic-only plans so the "intervention over time" timeline
//      reads as real history.
//   4. Lobby TV signage — enables the HeartBEAT page so the lobby rotation is a
//      rich dynamic display.
//
// Every step is idempotent and gated to school_id = 1. Safe to run at every
// boot. Wired into runSeed() in index.ts AFTER the main seed so students/staff
// exist.
import {
  db,
  staffTable,
  studentMtssPlansTable,
  tier3WeeklyRecordsTable,
  studentTrustedAdultsTable,
  staffCompRequestsTable,
  staffCompLedgerTable,
} from "@workspace/db";
import { eq, and, or, sql } from "drizzle-orm";
import { logger } from "./lib/logger";
import { enumerateWeeks } from "./lib/academicMinutes.js";

const SCHOOL_ID = 1;
const EST_EMAIL = "ept.demo@pulsedemo.com";

export async function seedDistrictDemoExtras(): Promise<void> {
  // Bail early if the demo school has not been seeded yet.
  const [{ c }] = (
    await db.execute(
      sql`SELECT COUNT(*)::int AS c FROM students WHERE school_id = ${SCHOOL_ID}`,
    )
  ).rows as { c: number }[];
  if (!c) return;

  for (const step of [
    seedCompTimeDemo,
    seedHeartbeatConnectionsDemo,
    seedAcademicTier3HistoryDemo,
    enrichLobbySignage,
  ]) {
    try {
      await step();
    } catch (err) {
      logger.error(
        { err, step: step.name },
        "seedDistrictDemoExtras step failed",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 1. Comp Time (EST / non-exempt) full workflow
// ---------------------------------------------------------------------------
async function seedCompTimeDemo(): Promise<void> {
  // Ensure a non-exempt "Educational Support Team" persona exists. We copy a
  // password hash from an existing admin so this account shares the standard
  // demo password (it never needs a bespoke credential).
  let [est] = await db
    .select()
    .from(staffTable)
    .where(
      and(eq(staffTable.schoolId, SCHOOL_ID), eq(staffTable.email, EST_EMAIL)),
    )
    .limit(1);

  if (!est) {
    const [tmpl] = await db
      .select({ ph: staffTable.passwordHash })
      .from(staffTable)
      .where(and(eq(staffTable.schoolId, SCHOOL_ID), eq(staffTable.isAdmin, true)))
      .limit(1);
    if (!tmpl) return;
    [est] = await db
      .insert(staffTable)
      .values({
        schoolId: SCHOOL_ID,
        email: EST_EMAIL,
        passwordHash: tmpl.ph,
        displayName: "Teresa Holloway - Paraprofessional",
        title: "Paraprofessional (ESE Support)",
        department: "Student Support",
        isAdmin: false,
        isNonExemptRole: true,
        exemptStatus: "non_exempt",
        canApproveCompTime: false,
        active: true,
      })
      .returning();
  } else if (est.exemptStatus !== "non_exempt") {
    await db
      .update(staffTable)
      .set({ isNonExemptRole: true, exemptStatus: "non_exempt" })
      .where(eq(staffTable.id, est.id));
  }

  // Skip if this persona already has comp requests (idempotent).
  const existing = await db
    .select({ id: staffCompRequestsTable.id })
    .from(staffCompRequestsTable)
    .where(
      and(
        eq(staffCompRequestsTable.schoolId, SCHOOL_ID),
        eq(staffCompRequestsTable.staffId, est.id),
      ),
    )
    .limit(1);
  if (existing.length) return;

  const [approver] = await db
    .select({ id: staffTable.id, displayName: staffTable.displayName })
    .from(staffTable)
    .where(
      and(
        eq(staffTable.schoolId, SCHOOL_ID),
        eq(staffTable.canApproveCompTime, true),
        eq(staffTable.isAdmin, true),
      ),
    )
    .limit(1);
  const approverId = approver?.id ?? null;
  const D = (s: string) => new Date(s);

  // (a) CONFIRMED — full lifecycle, credits the bank.
  const [confirmed] = await db
    .insert(staffCompRequestsTable)
    .values({
      schoolId: SCHOOL_ID,
      staffId: est.id,
      kind: "earn",
      state: "confirmed",
      weekStartDate: "2026-05-18",
      reason: "Open House — set-up, family check-in tables, and tear-down",
      hoursWorkedQh: 24,
      computedCreditQh: 36,
      quarterHoursRequested: 36,
      quarterHoursActual: 36,
      timesheetConfirmed: true,
      priorSupervisorApprovalConfirmed: true,
      createdAt: D("2026-05-19T13:00:00Z"),
      preapprovedAt: D("2026-05-19T18:00:00Z"),
      preapprovedByStaffId: approverId,
      preapprovalNote: "Approved — thank you for covering Open House.",
      completionSubmittedAt: D("2026-05-22T22:00:00Z"),
      completionNote: "Worked the full event; hours match my timesheet.",
      confirmedAt: D("2026-05-26T14:00:00Z"),
      confirmedByStaffId: approverId,
      confirmNote: "Verified against the sign-in sheet. Credited 9:00.",
    })
    .returning();
  await db.insert(staffCompLedgerTable).values({
    schoolId: SCHOOL_ID,
    staffId: est.id,
    deltaQuarterHours: 36,
    kind: "earn_confirm",
    requestId: confirmed.id,
    note: "Open House overtime",
    createdByStaffId: approverId,
  });

  // (b) PENDING_CONFIRM — staff finished, awaiting admin verification.
  await db.insert(staffCompRequestsTable).values({
    schoolId: SCHOOL_ID,
    staffId: est.id,
    kind: "earn",
    state: "pending_confirm",
    weekStartDate: "2026-05-25",
    reason: "Spring Festival — admission gate and clean-up crew",
    hoursWorkedQh: 16,
    computedCreditQh: 24,
    quarterHoursRequested: 24,
    quarterHoursActual: 24,
    timesheetConfirmed: true,
    priorSupervisorApprovalConfirmed: true,
    createdAt: D("2026-05-26T13:00:00Z"),
    preapprovedAt: D("2026-05-26T17:00:00Z"),
    preapprovedByStaffId: approverId,
    preapprovalNote: "Approved — see you Friday night.",
    completionSubmittedAt: D("2026-06-01T22:30:00Z"),
    completionNote: "Gate + clean-up done; submitting for confirmation.",
  });

  // (c) PREAPPROVED — approved ahead of the work, not yet completed.
  await db.insert(staffCompRequestsTable).values({
    schoolId: SCHOOL_ID,
    staffId: est.id,
    kind: "earn",
    state: "preapproved",
    weekStartDate: "2026-06-01",
    reason: "8th Grade Promotion — stage setup and parking detail",
    hoursWorkedQh: 20,
    computedCreditQh: 30,
    quarterHoursRequested: 30,
    timesheetConfirmed: true,
    priorSupervisorApprovalConfirmed: true,
    createdAt: D("2026-06-02T13:00:00Z"),
    preapprovedAt: D("2026-06-02T15:00:00Z"),
    preapprovedByStaffId: approverId,
    preapprovalNote: "Pre-approved. Log your actual hours after the event.",
  });

  // (d) PENDING_PREAPPROVAL — brand-new request at the top of the queue.
  await db.insert(staffCompRequestsTable).values({
    schoolId: SCHOOL_ID,
    staffId: est.id,
    kind: "earn",
    state: "pending_preapproval",
    weekStartDate: "2026-06-08",
    reason: "End-of-year records archiving after contract hours",
    hoursWorkedQh: 12,
    computedCreditQh: 18,
    quarterHoursRequested: 18,
    timesheetConfirmed: true,
    priorSupervisorApprovalConfirmed: true,
    createdAt: D("2026-06-09T13:00:00Z"),
  });

  logger.info({ estStaffId: est.id }, "Seeded Comp Time demo workflow");
}

// ---------------------------------------------------------------------------
// 2. HeartBEAT meaningful connections
// ---------------------------------------------------------------------------
async function seedHeartbeatConnectionsDemo(): Promise<void> {
  const [counselor] = await db
    .select({ id: staffTable.id, displayName: staffTable.displayName })
    .from(staffTable)
    .where(
      and(
        eq(staffTable.schoolId, SCHOOL_ID),
        or(
          eq(staffTable.isGuidanceCounselor, true),
          eq(staffTable.isCounselor, true),
          eq(staffTable.isMtssCoordinator, true),
        ),
      ),
    )
    .limit(1);

  const adults = await db
    .select({ id: staffTable.id })
    .from(staffTable)
    .where(and(eq(staffTable.schoolId, SCHOOL_ID), eq(staffTable.active, true)))
    .limit(14);
  if (adults.length < 3) return;

  // "Known" students = those who already have PBIS activity. Leaving the
  // 0-PBIS students alone keeps the Invisible Student contrast intact.
  const connected = (
    await db.execute(
      sql`SELECT st.student_id
          FROM students st
          WHERE st.school_id = ${SCHOOL_ID}
            AND EXISTS (
              SELECT 1 FROM pbis_entries pe
              WHERE pe.student_id = st.student_id AND pe.school_id = ${SCHOOL_ID})
          ORDER BY st.last_name, st.first_name
          LIMIT 9`,
    )
  ).rows as { student_id: string }[];
  if (!connected.length) return;

  const notes = [
    "Greets me every morning before first block; we always talk about her art.",
    "Eats lunch in my room on Tuesdays — trust is building slowly but steadily.",
    "Mentor through the running club; one of the most dependable kids I know.",
    "Checks in after 3rd period; we set a small reading goal together.",
    "Helps set up the science lab — proud of how responsible he's become.",
    "Quiet, but lights up talking about her little brother. Worth knowing.",
    "Stops by the front office just to say hi. We keep it light and consistent.",
    "Student government rep; I'm his go-to when something feels off.",
  ];

  let adultIdx = 0;
  let noteIdx = 0;
  for (let i = 0; i < connected.length; i++) {
    // First student is richly connected (3 adults); next three have 2; rest 1.
    const numAdults = i === 0 ? 3 : i < 4 ? 2 : 1;
    for (let a = 0; a < numAdults; a++) {
      const adult = adults[adultIdx++ % adults.length];
      const assignedAt = new Date(2026, 3 + (i % 2), 8 + a * 9, 14, 0, 0); // Apr/May
      await db
        .insert(studentTrustedAdultsTable)
        .values({
          schoolId: SCHOOL_ID,
          studentId: connected[i].student_id,
          staffId: adult.id,
          assignedByStaffId: counselor?.id ?? null,
          assignedByName: counselor?.displayName ?? "MTSS Coordinator",
          assignedAt,
          notes: notes[noteIdx++ % notes.length],
        })
        .onConflictDoNothing();
    }
  }

  logger.info(
    { students: connected.length },
    "Seeded HeartBEAT meaningful connections",
  );
}

// ---------------------------------------------------------------------------
// 3. Academic Tier 3 small-group history (~2 months of weekly minutes)
// ---------------------------------------------------------------------------
async function seedAcademicTier3HistoryDemo(): Promise<void> {
  const targets = [
    "FL000005062879", // Alina Maddox  — ELA
    "FL000007043912", // Amelia Abbott — Math
    "FL000007981935", // Sienna Osborne — Math
  ];
  const weeks = enumerateWeeks("2026-04-13", "2026-06-08");

  // A fallback interventionist in case a plan carries no assigned teacher.
  const [fallbackStaff] = await db
    .select({ id: staffTable.id })
    .from(staffTable)
    .where(and(eq(staffTable.schoolId, SCHOOL_ID), eq(staffTable.active, true)))
    .limit(1);

  for (const sid of targets) {
    const [plan] = await db
      .select()
      .from(studentMtssPlansTable)
      .where(
        and(
          eq(studentMtssPlansTable.schoolId, SCHOOL_ID),
          eq(studentMtssPlansTable.studentId, sid),
          eq(studentMtssPlansTable.tier, 3),
        ),
      )
      .limit(1);
    if (!plan) continue;

    // Backdate the plan so the timeline reads as ~2 months of support.
    await db.execute(
      sql`UPDATE student_mtss_plans
          SET opened_at = '2026-04-13 13:00:00+00'
          WHERE id = ${plan.id} AND opened_at > '2026-04-13 13:00:00+00'`,
    );

    const teacherId =
      parseInt(String(plan.assignedTeacherIds ?? "").split(",")[0] ?? "", 10) ||
      fallbackStaff?.id;
    if (!teacherId) continue;

    const days = plan.meetingDays
      ? String(plan.meetingDays)
          .split(",")
          .map((d) => d.trim())
          .filter(Boolean)
      : ["wed"];

    const existing = new Set(
      (
        await db.execute(
          sql`SELECT week_start_date FROM tier3_weekly_records
              WHERE school_id = ${SCHOOL_ID} AND student_id = ${sid}`,
        )
      ).rows.map((r) =>
        String((r as { week_start_date: string }).week_start_date),
      ),
    );

    for (let w = 0; w < weeks.length; w++) {
      const wk = weeks[w];
      if (existing.has(wk)) continue;

      let academicMinutes: Record<string, number> = {};
      let released = false;
      let releaseReason: string | null = null;
      let releasedByStaffId: number | null = null;
      let releasedAt: Date | null = null;

      if (w === 5) {
        // One excused week during the state testing window.
        released = true;
        releaseReason = "State testing window — small group paused this week.";
        releasedByStaffId = teacherId;
        releasedAt = new Date(`${wk}T15:00:00Z`);
      } else {
        const total = w === 2 ? 20 : 30; // one lighter week, rest on target
        academicMinutes = distribute(total, days);
      }

      await db.insert(tier3WeeklyRecordsTable).values({
        schoolId: SCHOOL_ID,
        studentId: sid,
        teacherStaffId: teacherId,
        weekStartDate: wk,
        academicMinutes,
        releasedNoIntervention: released,
        releaseReason,
        releasedByStaffId,
        releasedAt,
        submittedAt: new Date(`${wk}T16:00:00Z`),
      });
    }
  }

  logger.info("Seeded academic Tier 3 small-group history");
}

function distribute(total: number, days: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  if (!days.length) return { wed: total };
  const per = Math.max(5, Math.round(total / days.length / 5) * 5);
  let rem = total;
  for (let i = 0; i < days.length; i++) {
    const v = i === days.length - 1 ? Math.max(0, rem) : Math.min(per, rem);
    out[days[i]] = v;
    rem -= v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4. Lobby TV signage — add the HeartBEAT page to the rotation
// ---------------------------------------------------------------------------
async function enrichLobbySignage(): Promise<void> {
  await db.execute(
    sql`UPDATE display_playlists
        SET show_heartbeat = true
        WHERE school_id = ${SCHOOL_ID}
          AND name = 'Lobby TV'
          AND show_heartbeat = false`,
  );
}
