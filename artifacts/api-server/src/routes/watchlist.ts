// Watchlist Hub — core-team-only surface for tracking peripheral
// involvement, rumor patterns, and the social situations they roll up
// into. See lib/db/src/schema/interactions.ts and friends for the data
// model. Endpoints (all under /api/watchlist):
//
//   GET    /summary                     — hub stat strip
//   GET    /alerts                      — live-computed alerts (5 rules)
//   POST   /alerts/dismiss              — dismiss/snooze an alert
//   POST   /alerts/check-in             — schedule a Tier 2 check-in
//                                         (auto-adds to MTSS + notifies BS)
//   GET    /orbit                       — top-of-orbit table for the hub
//   GET    /network                     — graph data (nodes + edges + cases)
//
//   GET    /cases                       — list cases
//   POST   /cases                       — create case
//   GET    /cases/:id                   — detail (notes, players, incidents)
//   PATCH  /cases/:id                   — title / status / lead / summary
//   POST   /cases/:id/notes             — append a case note
//   POST   /cases/:id/players           — add a student as a "player" in
//                                         the case (creates a peripheral_note
//                                         interaction that links them in)
//
//   GET    /interactions                — list with filters
//   POST   /interactions                — log a new interaction (+participants)
//   GET    /interactions/:id            — detail with participants + statements
//   PATCH  /interactions/:id            — update header
//   POST   /interactions/:id/participants
//                                       — add a participant to an interaction
//   DELETE /interactions/:id/participants/:pid
//
//   GET    /statements                  — pending statements
//   POST   /statements/:id/remind       — bump remind_count
//   POST   /statements/:id/complete     — mark completed
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
  studentsTable,
  interactionsTable,
  interactionParticipantsTable,
  interactionCasesTable,
  interactionCasePlayerImpactTable,
  interactionCaseNotesTable,
  witnessStatementsTable,
  interactionAuditLogTable,
  interactionAlertDismissalsTable,
  interactionQuickEntriesTable,
  studentMtssPlansTable,
  tier2InterventionEntriesTable,
  adminNotificationsTable,
  INTERACTION_ROLES,
  INTERACTION_KINDS,
  INTERACTION_CASE_STATUSES,
  type InteractionRow,
  type InteractionParticipantRow,
  type InteractionCaseRow,
  type InteractionRole,
  type InteractionKind,
  type StaffRow,
} from "@workspace/db";
import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import { isCoreTeam } from "../lib/coreTeam.js";

const router: IRouter = Router();

type ReqWithStaff = Request & { staff: StaffRow };

async function loadStaff(req: Request): Promise<StaffRow | null> {
  const id = req.staffId;
  if (!id) return null;
  const [s] = await db.select().from(staffTable).where(eq(staffTable.id, id));
  return s && s.active ? s : null;
}

function requireCoreTeamMW() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const staff = await loadStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    if (!isCoreTeam(staff)) {
      res.status(403).json({ error: "Core Team role required" });
      return;
    }
    (req as ReqWithStaff).staff = staff;
    next();
  };
}

router.use("/watchlist", requireCoreTeamMW());

// --- helpers ---------------------------------------------------------

function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function clean(s: unknown, max = 4000): string {
  if (typeof s !== "string") return "";
  const t = s.trim();
  return t.length > max ? t.slice(0, max) : t;
}

function isRole(s: unknown): s is InteractionRole {
  return typeof s === "string" && (INTERACTION_ROLES as readonly string[]).includes(s);
}
function isKind(s: unknown): s is InteractionKind {
  return typeof s === "string" && (INTERACTION_KINDS as readonly string[]).includes(s);
}
function isCaseStatus(s: unknown): boolean {
  return typeof s === "string" && (INTERACTION_CASE_STATUSES as readonly string[]).includes(s);
}

function asInt(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^-?\d+$/.test(v)) return Number(v);
  return null;
}

async function audit(opts: {
  schoolId: number;
  entityType: string;
  entityId: number;
  action: string;
  staff: StaffRow;
  payload?: Record<string, unknown>;
}) {
  await db.insert(interactionAuditLogTable).values({
    schoolId: opts.schoolId,
    entityType: opts.entityType,
    entityId: opts.entityId,
    action: opts.action,
    actorStaffId: opts.staff.id,
    actorName: opts.staff.displayName,
    payload: opts.payload ?? null,
  });
}

// Resolve students by studentId for a school. Returns a map keyed by
// studentId (text) to the student row.
async function loadStudents(
  schoolId: number,
  studentIds: string[],
): Promise<Map<string, typeof studentsTable.$inferSelect>> {
  const out = new Map<string, typeof studentsTable.$inferSelect>();
  if (studentIds.length === 0) return out;
  const rows = await db
    .select()
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.schoolId, schoolId),
        inArray(studentsTable.studentId, studentIds),
      ),
    );
  for (const r of rows) out.set(r.studentId, r);
  return out;
}

// --- summary ---------------------------------------------------------

router.get("/watchlist/summary", async (req: Request, res: Response) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const today = new Date();
  const fourteenDaysAgo = new Date(today.getTime() - 14 * 24 * 3600 * 1000);
  const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 3600 * 1000);

  const [{ activeCases }] = (await db.execute(
    sql`SELECT COUNT(*)::int AS "activeCases" FROM interaction_cases
        WHERE school_id = ${schoolId} AND status <> 'closed'`,
  )).rows as { activeCases: number }[];

  const [{ pendingStatements }] = (await db.execute(
    sql`SELECT COUNT(*)::int AS "pendingStatements" FROM witness_statements
        WHERE school_id = ${schoolId} AND status NOT IN ('completed', 'waived')`,
  )).rows as { pendingStatements: number }[];

  const [{ staleStatements }] = (await db.execute(
    sql`SELECT COUNT(*)::int AS "staleStatements" FROM witness_statements
        WHERE school_id = ${schoolId} AND status NOT IN ('completed', 'waived')
        AND requested_at < ${sevenDaysAgo.toISOString()}`,
  )).rows as { staleStatements: number }[];

  const [{ recentInteractions }] = (await db.execute(
    sql`SELECT COUNT(*)::int AS "recentInteractions" FROM interactions
        WHERE school_id = ${schoolId} AND occurred_date >= ${ymdLocal(fourteenDaysAgo)}
        AND status = 'open'`,
  )).rows as { recentInteractions: number }[];

  const [{ looseInteractions }] = (await db.execute(
    sql`SELECT COUNT(*)::int AS "looseInteractions" FROM interactions
        WHERE school_id = ${schoolId} AND case_id IS NULL
        AND occurred_date >= ${ymdLocal(fourteenDaysAgo)} AND status = 'open'`,
  )).rows as { looseInteractions: number }[];

  res.json({
    activeCases,
    pendingStatements,
    staleStatements,
    recentInteractions,
    looseInteractions,
    windowDays: 14,
  });
});

// --- orbit (top-of-orbit chart data) ---------------------------------

router.get("/watchlist/orbit", async (req: Request, res: Response) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const windowDays = asInt(req.query["windowDays"]) ?? 14;
  const since = new Date(Date.now() - windowDays * 24 * 3600 * 1000);
  const sinceYmd = ymdLocal(since);

  // Per-student counts (total + by-role) over the window.
  const rows = (await db.execute(sql`
    SELECT p.student_id AS "studentId",
           COUNT(*)::int AS "total",
           SUM(CASE WHEN p.role IN ('peripheral','witness','rumor','deescalator') THEN 1 ELSE 0 END)::int AS "nonDirect",
           SUM(CASE WHEN p.role = 'peripheral' THEN 1 ELSE 0 END)::int AS "peripheral",
           SUM(CASE WHEN p.role IN ('direct','target','instigator') THEN 1 ELSE 0 END)::int AS "direct"
    FROM interaction_participants p
    JOIN interactions i
      ON i.id = p.interaction_id AND i.school_id = p.school_id
    WHERE p.school_id = ${schoolId}
      AND i.occurred_date >= ${sinceYmd}
      AND i.status = 'open'
    GROUP BY p.student_id
    HAVING COUNT(*) >= 2
    ORDER BY COUNT(*) DESC
    LIMIT 60
  `)).rows as Array<{
    studentId: string;
    total: number;
    nonDirect: number;
    peripheral: number;
    direct: number;
  }>;

  const students = await loadStudents(schoolId, rows.map((r) => r.studentId));
  const items = rows
    .map((r) => {
      const s = students.get(r.studentId);
      if (!s) return null;
      const nonDirectPct = r.total > 0 ? Math.round((r.nonDirect / r.total) * 100) : 0;
      return {
        studentId: r.studentId,
        firstName: s.firstName,
        lastName: s.lastName,
        grade: s.grade,
        total: r.total,
        nonDirect: r.nonDirect,
        peripheral: r.peripheral,
        direct: r.direct,
        nonDirectPct,
      };
    })
    .filter(Boolean);

  res.json({ items, windowDays });
});

// --- alerts ----------------------------------------------------------

type Alert = {
  id: string; // synthetic, deterministic — used for dismiss dedup
  ruleKind:
    | "frequency"
    | "always-peripheral"
    | "co-occurrence"
    | "stale-statement"
    | "loose-escalation";
  severity: "info" | "warn" | "alert";
  subjectStudentId: string;
  subjectKey: string;
  title: string;
  body: string;
  meta: Record<string, unknown>;
};

router.get("/watchlist/alerts", async (req: Request, res: Response) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const windowDays = asInt(req.query["windowDays"]) ?? 14;
  const since = new Date(Date.now() - windowDays * 24 * 3600 * 1000);
  const sinceYmd = ymdLocal(since);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);

  const alerts: Alert[] = [];

  // Frequency rule: >= 5 participations in window
  const freq = (await db.execute(sql`
    SELECT p.student_id AS "studentId", COUNT(*)::int AS "total"
    FROM interaction_participants p
    JOIN interactions i ON i.id = p.interaction_id AND i.school_id = p.school_id
    WHERE p.school_id = ${schoolId}
      AND i.occurred_date >= ${sinceYmd}
      AND i.status = 'open'
    GROUP BY p.student_id
    HAVING COUNT(*) >= 5
  `)).rows as Array<{ studentId: string; total: number }>;

  // Always-peripheral: >= 3 participations AND 100% non-direct
  const peripheral = (await db.execute(sql`
    SELECT p.student_id AS "studentId",
           COUNT(*)::int AS "total",
           SUM(CASE WHEN p.role IN ('direct','target','instigator') THEN 1 ELSE 0 END)::int AS "direct"
    FROM interaction_participants p
    JOIN interactions i ON i.id = p.interaction_id AND i.school_id = p.school_id
    WHERE p.school_id = ${schoolId}
      AND i.occurred_date >= ${sinceYmd}
      AND i.status = 'open'
    GROUP BY p.student_id
    HAVING COUNT(*) >= 3 AND SUM(CASE WHEN p.role IN ('direct','target','instigator') THEN 1 ELSE 0 END) = 0
  `)).rows as Array<{ studentId: string; total: number; direct: number }>;

  // Loose escalation: >= 3 caseId IS NULL interactions in window
  const loose = (await db.execute(sql`
    SELECT p.student_id AS "studentId", COUNT(*)::int AS "total"
    FROM interaction_participants p
    JOIN interactions i ON i.id = p.interaction_id AND i.school_id = p.school_id
    WHERE p.school_id = ${schoolId}
      AND i.case_id IS NULL
      AND i.occurred_date >= ${sinceYmd}
      AND i.status = 'open'
    GROUP BY p.student_id
    HAVING COUNT(*) >= 3
  `)).rows as Array<{ studentId: string; total: number }>;

  // Co-occurrence: pairs of students appearing together in >= 3 interactions
  const cooc = (await db.execute(sql`
    SELECT p1.student_id AS "a", p2.student_id AS "b", COUNT(DISTINCT p1.interaction_id)::int AS "shared"
    FROM interaction_participants p1
    JOIN interaction_participants p2
      ON p1.interaction_id = p2.interaction_id
     AND p1.school_id = p2.school_id
     AND p1.student_id < p2.student_id
    JOIN interactions i ON i.id = p1.interaction_id AND i.school_id = p1.school_id
    WHERE p1.school_id = ${schoolId}
      AND i.occurred_date >= ${sinceYmd}
      AND i.status = 'open'
    GROUP BY p1.student_id, p2.student_id
    HAVING COUNT(DISTINCT p1.interaction_id) >= 3
    ORDER BY shared DESC
    LIMIT 25
  `)).rows as Array<{ a: string; b: string; shared: number }>;

  // Stale statements: status not completed/waived AND requested_at < 7d
  const stale = (await db.execute(sql`
    SELECT id, student_id AS "studentId", interaction_id AS "interactionId",
           requested_at AS "requestedAt", status, remind_count AS "remindCount"
    FROM witness_statements
    WHERE school_id = ${schoolId}
      AND status NOT IN ('completed','waived')
      AND requested_at < ${sevenDaysAgo.toISOString()}
    ORDER BY requested_at ASC
    LIMIT 25
  `)).rows as Array<{
    id: number;
    studentId: string;
    interactionId: number;
    requestedAt: string;
    status: string;
    remindCount: number;
  }>;

  // Resolve all relevant students in one batch
  const idSet = new Set<string>();
  for (const r of freq) idSet.add(r.studentId);
  for (const r of peripheral) idSet.add(r.studentId);
  for (const r of loose) idSet.add(r.studentId);
  for (const r of cooc) {
    idSet.add(r.a);
    idSet.add(r.b);
  }
  for (const r of stale) idSet.add(r.studentId);
  const students = await loadStudents(schoolId, [...idSet]);
  const stuName = (id: string) => {
    const s = students.get(id);
    return s ? `${s.firstName} ${s.lastName}` : id;
  };
  const stuGrade = (id: string) => students.get(id)?.grade ?? null;

  for (const r of freq) {
    alerts.push({
      id: `frequency:${r.studentId}:${windowDays}`,
      ruleKind: "frequency",
      severity: "alert",
      subjectStudentId: r.studentId,
      subjectKey: `${windowDays}:${r.total}`,
      title: `${stuName(r.studentId)} — ${r.total} involvements in ${windowDays}d`,
      body: `Showing up in a lot of interactions. Worth a quiet check-in before this becomes a case.`,
      meta: { total: r.total, grade: stuGrade(r.studentId) },
    });
  }
  for (const r of peripheral) {
    alerts.push({
      id: `always-peripheral:${r.studentId}:${windowDays}`,
      ruleKind: "always-peripheral",
      severity: "alert",
      subjectStudentId: r.studentId,
      subjectKey: `${windowDays}:${r.total}`,
      title: `${stuName(r.studentId)} — always peripheral, never direct`,
      body: `${r.total} involvements in ${windowDays} days, 100% non-direct. The classic "from-a-distance" pattern.`,
      meta: { total: r.total, grade: stuGrade(r.studentId) },
    });
  }
  for (const r of loose) {
    alerts.push({
      id: `loose-escalation:${r.studentId}:${windowDays}`,
      ruleKind: "loose-escalation",
      severity: "warn",
      subjectStudentId: r.studentId,
      subjectKey: `${windowDays}:${r.total}`,
      title: `${stuName(r.studentId)} — ${r.total} loose incidents, no case yet`,
      body: `Multiple interactions with no case linkage. Consider opening one to keep this thread together.`,
      meta: { total: r.total, grade: stuGrade(r.studentId) },
    });
  }
  for (const r of cooc) {
    alerts.push({
      id: `co-occurrence:${r.a}:${r.b}:${windowDays}`,
      ruleKind: "co-occurrence",
      severity: "warn",
      subjectStudentId: r.a,
      subjectKey: `${r.b}:${windowDays}:${r.shared}`,
      title: `${stuName(r.a)} + ${stuName(r.b)} — ${r.shared}× together`,
      body: `These two keep showing up in the same interactions. Worth a look at the network view.`,
      meta: { otherStudentId: r.b, shared: r.shared },
    });
  }
  for (const r of stale) {
    alerts.push({
      id: `stale-statement:${r.id}`,
      ruleKind: "stale-statement",
      severity: "warn",
      subjectStudentId: r.studentId,
      subjectKey: `statement:${r.id}`,
      title: `${stuName(r.studentId)} — witness statement ${ageDays(r.requestedAt)}d old`,
      body: `Statement requested ${ageDays(r.requestedAt)} days ago, still ${r.status}. Time to nudge.`,
      meta: {
        statementId: r.id,
        interactionId: r.interactionId,
        remindCount: r.remindCount,
        ageDays: ageDays(r.requestedAt),
      },
    });
  }

  // Filter dismissed
  const dismissed = await db
    .select()
    .from(interactionAlertDismissalsTable)
    .where(eq(interactionAlertDismissalsTable.schoolId, schoolId));
  const now = new Date();
  const dismissKey = (rule: string, sid: string, sub: string) => `${rule}|${sid}|${sub}`;
  const dismissedSet = new Set<string>();
  for (const d of dismissed) {
    if (d.expiresAt && d.expiresAt < now) continue;
    dismissedSet.add(dismissKey(d.ruleKind, d.subjectStudentId, d.subjectKey));
  }
  const visible = alerts.filter(
    (a) => !dismissedSet.has(dismissKey(a.ruleKind, a.subjectStudentId, a.subjectKey)),
  );

  res.json({ alerts: visible, total: visible.length, windowDays });
});

function ageDays(iso: string | Date): number {
  const t = typeof iso === "string" ? new Date(iso).getTime() : iso.getTime();
  return Math.max(0, Math.floor((Date.now() - t) / (24 * 3600 * 1000)));
}

router.post("/watchlist/alerts/dismiss", async (req: Request, res: Response) => {
  const staff = (req as ReqWithStaff).staff;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const b = req.body as Record<string, unknown>;
  const ruleKind = clean(b["ruleKind"], 60);
  const subjectStudentId = clean(b["subjectStudentId"], 60);
  const subjectKey = clean(b["subjectKey"], 200);
  const reason = clean(b["reason"], 500);
  const snoozeDays = asInt(b["snoozeDays"]);
  if (!ruleKind || !subjectStudentId) {
    res.status(400).json({ error: "ruleKind and subjectStudentId required" });
    return;
  }
  const expiresAt =
    snoozeDays && snoozeDays > 0 ? new Date(Date.now() + snoozeDays * 24 * 3600 * 1000) : null;
  await db
    .insert(interactionAlertDismissalsTable)
    .values({
      schoolId,
      ruleKind,
      subjectStudentId,
      subjectKey,
      dismissedByStaffId: staff.id,
      dismissedByName: staff.displayName,
      dismissReason: reason,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: [
        interactionAlertDismissalsTable.schoolId,
        interactionAlertDismissalsTable.ruleKind,
        interactionAlertDismissalsTable.subjectStudentId,
        interactionAlertDismissalsTable.subjectKey,
      ],
      set: {
        dismissedByStaffId: staff.id,
        dismissedByName: staff.displayName,
        dismissReason: reason,
        dismissedAt: new Date(),
        expiresAt,
      },
    });
  await audit({
    schoolId,
    entityType: "alert_dismissal",
    entityId: 0,
    action: "dismissed",
    staff,
    payload: { ruleKind, subjectStudentId, subjectKey, snoozeDays, reason },
  });
  res.json({ ok: true });
});

// --- check-in: links to MTSS + notifies BS --------------------------

router.post("/watchlist/alerts/check-in", async (req: Request, res: Response) => {
  const staff = (req as ReqWithStaff).staff;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const b = req.body as Record<string, unknown>;
  const studentId = clean(b["studentId"], 60);
  const ruleKind = clean(b["ruleKind"], 60);
  const ruleSummary = clean(b["ruleSummary"], 500);
  const notes = clean(b["notes"], 2000);
  if (!studentId) {
    res.status(400).json({ error: "studentId required" });
    return;
  }

  const [stu] = await db
    .select()
    .from(studentsTable)
    .where(
      and(eq(studentsTable.studentId, studentId), eq(studentsTable.schoolId, schoolId)),
    );
  if (!stu) {
    res.status(404).json({ error: "Student not found" });
    return;
  }

  // Find a Behavior Specialist (preferred) or MTSS Coordinator (fallback).
  const bsCandidates = await db
    .select()
    .from(staffTable)
    .where(
      and(eq(staffTable.schoolId, schoolId), eq(staffTable.active, true)),
    );
  const bs =
    bsCandidates.find((s) => s.isBehaviorSpecialist) ||
    bsCandidates.find((s) => s.isMtssCoordinator) ||
    bsCandidates.find((s) => s.isCounselor);
  if (!bs) {
    res.status(409).json({
      error:
        "No Behavior Specialist, MTSS Coordinator, or Counselor on staff to assign the check-in to.",
    });
    return;
  }

  // Find or create an active MTSS plan (Tier 2, sub_type cico).
  const existingPlans = await db
    .select()
    .from(studentMtssPlansTable)
    .where(
      and(
        eq(studentMtssPlansTable.schoolId, schoolId),
        eq(studentMtssPlansTable.studentId, studentId),
      ),
    );
  let plan = existingPlans.find((p) => !p.closedAt && p.tier >= 2);
  let createdPlan = false;
  if (!plan) {
    const [newPlan] = await db
      .insert(studentMtssPlansTable)
      .values({
        schoolId,
        studentId,
        title: `Watchlist check-in — ${stu.firstName} ${stu.lastName}`,
        goals: ruleSummary
          ? `Check-in scheduled from Watchlist Hub.\nReason: ${ruleSummary}`
          : "Check-in scheduled from Watchlist Hub.",
        tier: 2,
        interventionSubType: "cico",
        notes,
        openedByStaffId: staff.id,
        openedByName: staff.displayName,
        additionalInterventionistIds: String(bs.id),
      })
      .returning();
    plan = newPlan;
    createdPlan = true;
  }

  // Upsert today's Tier 2 entry assigned to the BS. Idempotent on
  // (school, student, teacher, date) so re-clicking "Schedule check-in"
  // doesn't create duplicate same-day assignments.
  const today = ymdLocal(new Date());
  const entryNotes =
    notes || ruleSummary || `Watchlist Hub: ${ruleKind || "check-in"}`;
  const existingEntries = await db
    .select()
    .from(tier2InterventionEntriesTable)
    .where(
      and(
        eq(tier2InterventionEntriesTable.schoolId, schoolId),
        eq(tier2InterventionEntriesTable.studentId, studentId),
        eq(tier2InterventionEntriesTable.teacherStaffId, bs.id),
        eq(tier2InterventionEntriesTable.entryDate, today),
      ),
    )
    .limit(1);
  let entry;
  let entryAlreadyExisted = false;
  if (existingEntries[0]) {
    entryAlreadyExisted = true;
    const [updated] = await db
      .update(tier2InterventionEntriesTable)
      .set({ notes: entryNotes, updatedAt: new Date() })
      .where(eq(tier2InterventionEntriesTable.id, existingEntries[0].id))
      .returning();
    entry = updated;
  } else {
    const [inserted] = await db
      .insert(tier2InterventionEntriesTable)
      .values({
        schoolId,
        studentId,
        teacherStaffId: bs.id,
        entryDate: today,
        subType: "cico",
        notes: entryNotes,
      })
      .returning();
    entry = inserted;
  }

  // Fanout notification: target every Behavior Specialist and every MTSS
  // Coordinator on this school's roster, plus a general core-team feed
  // entry. Each recipient gets their own row so the bell badge clears
  // per-user and we have an audit trail of who was notified.
  const basePayload = {
    studentId,
    studentName: `${stu.firstName} ${stu.lastName}`,
    grade: stu.grade,
    assignedToStaffId: bs.id,
    assignedToName: bs.displayName,
    assignedToRole: bs.isBehaviorSpecialist
      ? "behavior_specialist"
      : bs.isMtssCoordinator
        ? "mtss_coordinator"
        : "counselor",
    ruleKind: ruleKind || null,
    ruleSummary: ruleSummary || null,
    mtssPlanId: plan?.id ?? null,
    tier2EntryId: entry?.id ?? null,
    createdPlan,
    entryAlreadyExisted,
    scheduledByStaffId: staff.id,
    scheduledByName: staff.displayName,
    scheduledAt: new Date().toISOString(),
  };

  const recipients = bsCandidates.filter(
    (s) => s.isBehaviorSpecialist || s.isMtssCoordinator,
  );
  const notificationRows: (typeof adminNotificationsTable.$inferInsert)[] = [
    { schoolId, type: "watchlist_check_in_scheduled", payload: basePayload },
  ];
  for (const recipient of recipients) {
    notificationRows.push({
      schoolId,
      type: "watchlist_check_in_scheduled_for_role",
      payload: {
        ...basePayload,
        targetStaffId: recipient.id,
        targetStaffName: recipient.displayName,
        targetRole: recipient.isBehaviorSpecialist
          ? "behavior_specialist"
          : "mtss_coordinator",
      },
    });
  }
  await db.insert(adminNotificationsTable).values(notificationRows);

  await audit({
    schoolId,
    entityType: "check_in",
    entityId: entry?.id ?? 0,
    action: "check_in_scheduled",
    staff,
    payload: {
      studentId,
      ruleKind,
      mtssPlanId: plan?.id,
      tier2EntryId: entry?.id,
      assignedToStaffId: bs.id,
      createdPlan,
    },
  });

  res.json({
    ok: true,
    assignedTo: { id: bs.id, name: bs.displayName },
    mtssPlanId: plan?.id,
    tier2EntryId: entry?.id,
    createdPlan,
  });
});

// --- network ---------------------------------------------------------

router.get("/watchlist/network", async (req: Request, res: Response) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const windowDays = asInt(req.query["windowDays"]) ?? 30;
  const since = new Date(Date.now() - windowDays * 24 * 3600 * 1000);
  const sinceYmd = ymdLocal(since);

  // Pull every (interaction, participants) pair in the window.
  const parts = (await db.execute(sql`
    SELECT p.id AS "pid", p.interaction_id AS "interactionId", p.student_id AS "studentId",
           p.role AS "role",
           i.case_id AS "caseId", i.kind AS "kind", i.severity AS "severity",
           i.occurred_date AS "occurredDate"
    FROM interaction_participants p
    JOIN interactions i ON i.id = p.interaction_id AND i.school_id = p.school_id
    WHERE p.school_id = ${schoolId}
      AND i.occurred_date >= ${sinceYmd}
      AND i.status = 'open'
  `)).rows as Array<{
    pid: number;
    interactionId: number;
    studentId: string;
    role: string;
    caseId: number | null;
    kind: string;
    severity: number;
    occurredDate: string;
  }>;

  // Build node aggregation
  type NodeAgg = {
    studentId: string;
    total: number;
    primaryRole: string;
    counts: Record<string, number>;
    cases: Set<number>;
  };
  const nodes = new Map<string, NodeAgg>();
  // Group participants by interactionId for edge building
  const byInteraction = new Map<number, Array<{ studentId: string; role: string }>>();
  const interactionCase = new Map<number, number | null>();
  const interactionKind = new Map<number, string>();
  for (const p of parts) {
    let n = nodes.get(p.studentId);
    if (!n) {
      n = {
        studentId: p.studentId,
        total: 0,
        primaryRole: p.role,
        counts: {},
        cases: new Set(),
      };
      nodes.set(p.studentId, n);
    }
    n.total++;
    n.counts[p.role] = (n.counts[p.role] ?? 0) + 1;
    if (p.caseId != null) n.cases.add(p.caseId);
    let bi = byInteraction.get(p.interactionId);
    if (!bi) {
      bi = [];
      byInteraction.set(p.interactionId, bi);
    }
    bi.push({ studentId: p.studentId, role: p.role });
    interactionCase.set(p.interactionId, p.caseId);
    interactionKind.set(p.interactionId, p.kind);
  }
  // Determine each node's primary role = most common
  for (const n of nodes.values()) {
    let best: [string, number] = [n.primaryRole, 0];
    for (const [role, c] of Object.entries(n.counts)) {
      if (c > best[1]) best = [role, c];
    }
    n.primaryRole = best[0];
  }

  // Build edges: for each interaction, all unordered pairs.
  type EdgeKey = string;
  const edges = new Map<
    EdgeKey,
    {
      a: string;
      b: string;
      weight: number;
      caseIds: Set<number>;
      kinds: Set<string>;
    }
  >();
  for (const [iid, players] of byInteraction.entries()) {
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        const [a, b] =
          players[i].studentId < players[j].studentId
            ? [players[i].studentId, players[j].studentId]
            : [players[j].studentId, players[i].studentId];
        const key = `${a}|${b}`;
        let e = edges.get(key);
        if (!e) {
          e = { a, b, weight: 0, caseIds: new Set(), kinds: new Set() };
          edges.set(key, e);
        }
        e.weight++;
        const cid = interactionCase.get(iid);
        if (cid != null) e.caseIds.add(cid);
        const k = interactionKind.get(iid);
        if (k) e.kinds.add(k);
      }
    }
  }

  // Resolve students + cases
  const students = await loadStudents(schoolId, [...nodes.keys()]);
  const cases = await db
    .select()
    .from(interactionCasesTable)
    .where(eq(interactionCasesTable.schoolId, schoolId));
  const caseById = new Map<number, InteractionCaseRow>(cases.map((c) => [c.id, c] as const));

  // Compute flags for each node (always-peripheral, frequency, etc) so the UI can ring them.
  const nodeOut = [...nodes.values()]
    .map((n) => {
      const s = students.get(n.studentId);
      if (!s) return null;
      const direct = (n.counts["direct"] ?? 0) + (n.counts["target"] ?? 0) + (n.counts["instigator"] ?? 0);
      const nonDirectPct = n.total > 0 ? (n.total - direct) / n.total : 0;
      const flag =
        n.total >= 3 && direct === 0
          ? "always-peripheral"
          : n.total >= 5
          ? "frequency"
          : null;
      return {
        studentId: n.studentId,
        firstName: s.firstName,
        lastName: s.lastName,
        grade: s.grade,
        total: n.total,
        primaryRole: n.primaryRole,
        counts: n.counts,
        caseIds: [...n.cases],
        nonDirectPct: Math.round(nonDirectPct * 100),
        flag,
      };
    })
    .filter(Boolean);

  const edgeOut = [...edges.values()].map((e) => ({
    a: e.a,
    b: e.b,
    weight: e.weight,
    caseIds: [...e.caseIds],
    kinds: [...e.kinds],
  }));

  res.json({
    nodes: nodeOut,
    edges: edgeOut,
    cases: cases.map((c) => ({
      id: c.id,
      caseNumber: c.caseNumber,
      title: c.title,
      status: c.status,
      leadStaffName: c.leadStaffName,
    })),
    windowDays,
  });
});

// Ego-graph for a single student: the student in the center, every case
// they're tied to as a ring around them, and every other player on each
// of those cases as a sub-ring around the case node. Drives the
// "search by name → spider web" view in the Hub.
router.get(
  "/watchlist/network/student/:studentId",
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const studentId = String(req.params.studentId ?? "").trim();
    if (!studentId) {
      res.status(400).json({ error: "studentId required" });
      return;
    }

    // 1. Center student.
    const [center] = await db
      .select({
        studentId: studentsTable.studentId,
        firstName: studentsTable.firstName,
        lastName: studentsTable.lastName,
        grade: studentsTable.grade,
      })
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.schoolId, schoolId),
          eq(studentsTable.studentId, studentId),
        ),
      );
    if (!center) {
      res.status(404).json({ error: "Student not found" });
      return;
    }

    // 2. Every case this student touches (via any interaction they're a
    // participant of). We deliberately ignore loose interactions
    // (caseId IS NULL) here — the spider view is about cases. Capped
    // (default 12, max 30) to keep the SVG readable and the payload
    // bounded for students who appear in many cases.
    const maxCases = Math.min(30, Math.max(1, asInt(req.query["max"]) ?? 12));
    const caseRows = (
      await db.execute(sql`
        SELECT DISTINCT c.id AS "id",
                        c.case_number AS "caseNumber",
                        c.title AS "title",
                        c.status AS "status",
                        c.lead_staff_name AS "leadStaffName",
                        c.summary AS "summary",
                        c.opened_at AS "openedAt"
        FROM interaction_cases c
        JOIN interactions i ON i.case_id = c.id AND i.school_id = c.school_id
        JOIN interaction_participants p ON p.interaction_id = i.id AND p.school_id = i.school_id
        WHERE c.school_id = ${schoolId}
          AND p.student_id = ${studentId}
        ORDER BY c.opened_at DESC
        LIMIT ${maxCases + 1}
      `)
    ).rows as Array<{
      id: number;
      caseNumber: number;
      title: string;
      status: string;
      leadStaffName: string;
      summary: string;
      openedAt: string;
    }>;

    // Detect truncation: we asked for maxCases+1 above so we can flag
    // "more available" without a separate count query.
    const truncated = caseRows.length > maxCases;
    const trimmedCases = truncated ? caseRows.slice(0, maxCases) : caseRows;

    if (trimmedCases.length === 0) {
      res.json({ center, cases: [], truncated: false, maxCases });
      return;
    }

    const caseIds = trimmedCases.map((c) => c.id);

    // 3. All interactions on those cases (incidents).
    const incidents = await db
      .select()
      .from(interactionsTable)
      .where(
        and(
          eq(interactionsTable.schoolId, schoolId),
          inArray(interactionsTable.caseId, caseIds),
        ),
      )
      .orderBy(desc(interactionsTable.occurredAt));

    // 4. All participants across those interactions (so we can list every
    // student on every case, with their role on the case = the role
    // they most often play across the case's incidents).
    const interactionIds = incidents.map((i) => i.id);
    const allParts = interactionIds.length
      ? await db
          .select()
          .from(interactionParticipantsTable)
          .where(
            and(
              eq(interactionParticipantsTable.schoolId, schoolId),
              inArray(
                interactionParticipantsTable.interactionId,
                interactionIds,
              ),
            ),
          )
      : [];

    // 5. All notes for those cases.
    const notes = await db
      .select()
      .from(interactionCaseNotesTable)
      .where(
        and(
          eq(interactionCaseNotesTable.schoolId, schoolId),
          inArray(interactionCaseNotesTable.caseId, caseIds),
        ),
      )
      .orderBy(desc(interactionCaseNotesTable.createdAt));

    // 6. Resolve every student that appears anywhere.
    const studentIds = Array.from(
      new Set(allParts.map((p) => p.studentId).concat([studentId])),
    );
    const students = await loadStudents(schoolId, studentIds);

    // Helper: incident -> caseId map for grouping.
    const incidentCase = new Map<number, number>();
    for (const i of incidents) {
      if (i.caseId != null) incidentCase.set(i.id, i.caseId);
    }

    // Roll up participants per case → per student → role counts.
    const perCasePlayers = new Map<
      number,
      Map<string, { studentId: string; roles: Record<string, number> }>
    >();
    for (const p of allParts) {
      const cid = incidentCase.get(p.interactionId);
      if (cid == null) continue;
      let m = perCasePlayers.get(cid);
      if (!m) {
        m = new Map();
        perCasePlayers.set(cid, m);
      }
      let entry = m.get(p.studentId);
      if (!entry) {
        entry = { studentId: p.studentId, roles: {} };
        m.set(p.studentId, entry);
      }
      entry.roles[p.role] = (entry.roles[p.role] ?? 0) + 1;
    }

    const incidentsByCase = new Map<number, InteractionRow[]>();
    for (const i of incidents) {
      if (i.caseId == null) continue;
      const arr = incidentsByCase.get(i.caseId) ?? [];
      arr.push(i);
      incidentsByCase.set(i.caseId, arr);
    }

    const notesByCase = new Map<number, typeof notes>();
    for (const n of notes) {
      const arr = notesByCase.get(n.caseId) ?? [];
      arr.push(n);
      notesByCase.set(n.caseId, arr);
    }

    // For each incident also compute the participant list (student → role
    // on this specific incident) so the drill-in panel can render it.
    const partsByIncident = new Map<number, InteractionParticipantRow[]>();
    for (const p of allParts) {
      const arr = partsByIncident.get(p.interactionId) ?? [];
      arr.push(p);
      partsByIncident.set(p.interactionId, arr);
    }

    const cases = trimmedCases.map((c) => {
      const playerMap = perCasePlayers.get(c.id) ?? new Map();
      const players = Array.from(playerMap.values())
        .map((entry) => {
          const stu = students.get(entry.studentId);
          if (!stu) return null;
          // primary role = max-count role
          let primaryRole = "witness";
          let max = 0;
          for (const [r, n] of Object.entries(entry.roles) as Array<[string, number]>) {
            if (n > max) {
              primaryRole = r;
              max = n;
            }
          }
          return {
            studentId: entry.studentId,
            firstName: stu.firstName,
            lastName: stu.lastName,
            grade: stu.grade,
            primaryRole,
            isCenter: entry.studentId === studentId,
          };
        })
        .filter(
          (p): p is NonNullable<typeof p> => p !== null,
        );

      const caseIncidents = (incidentsByCase.get(c.id) ?? []).map((i) => ({
        id: i.id,
        occurredAt: i.occurredAt,
        occurredDate: i.occurredDate,
        kind: i.kind,
        severity: i.severity,
        location: i.location,
        summary: i.summary,
        detail: i.detail,
        loggedByName: i.loggedByName,
        participants: (partsByIncident.get(i.id) ?? []).map((p) => {
          const stu = students.get(p.studentId);
          return {
            studentId: p.studentId,
            firstName: stu?.firstName ?? "",
            lastName: stu?.lastName ?? "",
            role: p.role,
            notes: p.notes,
          };
        }),
      }));

      const caseNotes = (notesByCase.get(c.id) ?? []).map((n) => ({
        id: n.id,
        body: n.body,
        authorName: n.authorName,
        createdAt: n.createdAt,
      }));

      return {
        id: c.id,
        caseNumber: c.caseNumber,
        title: c.title,
        status: c.status,
        leadStaffName: c.leadStaffName,
        summary: c.summary,
        openedAt: c.openedAt,
        players,
        incidents: caseIncidents,
        notes: caseNotes,
      };
    });

    res.json({ center, cases, truncated, maxCases });
  },
);

// --- cases -----------------------------------------------------------

router.get("/watchlist/cases", async (req: Request, res: Response) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const cases = await db
    .select()
    .from(interactionCasesTable)
    .where(eq(interactionCasesTable.schoolId, schoolId))
    .orderBy(desc(interactionCasesTable.openedAt));
  // Counts of incidents + students per case
  const ids = cases.map((c) => c.id);
  const counts = new Map<number, { incidents: number; students: number; lastActivity: Date | null }>();
  for (const id of ids) counts.set(id, { incidents: 0, students: 0, lastActivity: null });
  if (ids.length > 0) {
    const rows = (await db.execute(sql`
      SELECT i.case_id AS "caseId",
             COUNT(DISTINCT i.id)::int AS "incidents",
             COUNT(DISTINCT p.student_id)::int AS "students",
             MAX(i.occurred_at) AS "lastActivity"
      FROM interactions i
      LEFT JOIN interaction_participants p
        ON p.interaction_id = i.id AND p.school_id = i.school_id
      WHERE i.school_id = ${schoolId}
        AND i.case_id IN (${sql.join(ids.map((x) => sql`${x}`), sql`, `)})
      GROUP BY i.case_id
    `)).rows as Array<{ caseId: number; incidents: number; students: number; lastActivity: string | null }>;
    for (const r of rows) {
      counts.set(r.caseId, {
        incidents: r.incidents,
        students: r.students,
        lastActivity: r.lastActivity ? new Date(r.lastActivity) : null,
      });
    }
  }
  res.json({
    cases: cases.map((c) => ({
      ...c,
      counts: counts.get(c.id) ?? { incidents: 0, students: 0, lastActivity: null },
    })),
  });
});

router.post("/watchlist/cases", async (req: Request, res: Response) => {
  const staff = (req as ReqWithStaff).staff;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const b = req.body as Record<string, unknown>;
  const title = clean(b["title"], 200);
  const summary = clean(b["summary"], 2000);
  const status = isCaseStatus(b["status"]) ? (b["status"] as string) : "open";
  const leadStaffId = asInt(b["leadStaffId"]);
  if (!title) {
    res.status(400).json({ error: "title required" });
    return;
  }
  let leadName = "";
  if (leadStaffId) {
    const [s] = await db
      .select()
      .from(staffTable)
      .where(and(eq(staffTable.id, leadStaffId), eq(staffTable.schoolId, schoolId)));
    if (s) leadName = s.displayName;
  }
  // Sequential per-school case_number
  const [{ next }] = (await db.execute(sql`
    SELECT COALESCE(MAX(case_number), 0) + 1 AS "next" FROM interaction_cases WHERE school_id = ${schoolId}
  `)).rows as { next: number }[];

  const [row] = await db
    .insert(interactionCasesTable)
    .values({
      schoolId,
      caseNumber: next,
      title,
      summary,
      status,
      leadStaffId: leadStaffId ?? null,
      leadStaffName: leadName,
      createdByStaffId: staff.id,
      createdByName: staff.displayName,
    })
    .returning();
  await audit({ schoolId, entityType: "case", entityId: row.id, action: "created", staff, payload: { title } });

  // Optional: roster + initial incident in the same create call. Lets the
  // NewCaseModal spin up a case, attach the known students with roles, and
  // (optionally) log the first incident — all in one round trip.
  const playersIn = Array.isArray(b["players"])
    ? (b["players"] as Array<Record<string, unknown>>)
    : [];
  const initInc = b["initialIncident"] as Record<string, unknown> | undefined;

  type PlayerStaged = { studentId: string; role: InteractionRole; notes: string };
  const validPlayers: PlayerStaged[] = [];
  const sids = [
    ...new Set(
      playersIn.map((p) => clean(p["studentId"], 60)).filter(Boolean),
    ),
  ];
  if (sids.length > 0) {
    const studs = await loadStudents(schoolId, sids);
    for (const p of playersIn) {
      const sid = clean(p["studentId"], 60);
      if (!sid || !studs.has(sid)) continue;
      validPlayers.push({
        studentId: sid,
        role: isRole(p["role"]) ? (p["role"] as InteractionRole) : "peripheral",
        notes: clean(p["notes"], 1000),
      });
    }
  }

  let initialIncidentId: number | null = null;
  if (initInc && typeof initInc === "object") {
    const kind = isKind(initInc["kind"])
      ? (initInc["kind"] as InteractionKind)
      : "verbal";
    const severity = Math.max(
      1,
      Math.min(4, asInt(initInc["severity"]) ?? 2),
    );
    const location = clean(initInc["location"], 200);
    const incSummary =
      clean(initInc["summary"], 280) || `Initial incident — ${title}`;
    const detail = clean(initInc["detail"], 4000);
    const occurredDateRaw = clean(initInc["occurredDate"], 10);
    const occurredDate = /^\d{4}-\d{2}-\d{2}$/.test(occurredDateRaw)
      ? occurredDateRaw
      : ymdLocal(new Date());
    const [inc] = await db
      .insert(interactionsTable)
      .values({
        schoolId,
        occurredDate,
        kind,
        severity,
        location,
        summary: incSummary,
        detail,
        caseId: row.id,
        loggedByStaffId: staff.id,
        loggedByName: staff.displayName,
      })
      .returning();
    initialIncidentId = inc.id;
    if (validPlayers.length > 0) {
      await db
        .insert(interactionParticipantsTable)
        .values(
          validPlayers.map((p) => ({
            schoolId,
            interactionId: inc.id,
            studentId: p.studentId,
            role: p.role,
            notes: p.notes,
          })),
        )
        .onConflictDoNothing();
    }
    await audit({
      schoolId,
      entityType: "interaction",
      entityId: inc.id,
      action: "created",
      staff,
      payload: {
        kind,
        severity,
        caseId: row.id,
        participantCount: validPlayers.length,
        viaCaseCreate: true,
      },
    });
  } else if (validPlayers.length > 0) {
    // No initial incident — register each known player on the case via a
    // lightweight peripheral_note (mirrors the add-player endpoint so the
    // network/spider/case-detail surfaces them immediately).
    const today = ymdLocal(new Date());
    for (const p of validPlayers) {
      const [inc] = await db
        .insert(interactionsTable)
        .values({
          schoolId,
          occurredDate: today,
          kind: "peripheral_note",
          severity: 1,
          location: "",
          summary: `Added to case as ${p.role}`,
          detail: p.notes,
          caseId: row.id,
          loggedByStaffId: staff.id,
          loggedByName: staff.displayName,
        })
        .returning();
      await db.insert(interactionParticipantsTable).values({
        schoolId,
        interactionId: inc.id,
        studentId: p.studentId,
        role: p.role,
        notes: p.notes,
      });
      await audit({
        schoolId,
        entityType: "case",
        entityId: row.id,
        action: "player_added",
        staff,
        payload: {
          studentId: p.studentId,
          role: p.role,
          interactionId: inc.id,
          viaCaseCreate: true,
        },
      });
    }
  }

  res.json({
    case: row,
    initialIncidentId,
    playerCount: validPlayers.length,
  });
});

router.get("/watchlist/cases/:id", async (req: Request, res: Response) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const id = asInt(req.params["id"]);
  if (!id) {
    res.status(400).json({ error: "Invalid case id" });
    return;
  }
  const [c] = await db
    .select()
    .from(interactionCasesTable)
    .where(and(eq(interactionCasesTable.id, id), eq(interactionCasesTable.schoolId, schoolId)));
  if (!c) {
    res.status(404).json({ error: "Case not found" });
    return;
  }

  const incidents = await db
    .select()
    .from(interactionsTable)
    .where(and(eq(interactionsTable.schoolId, schoolId), eq(interactionsTable.caseId, id)))
    .orderBy(desc(interactionsTable.occurredAt));

  const incidentIds = incidents.map((i) => i.id);
  let participants: InteractionParticipantRow[] = [];
  if (incidentIds.length > 0) {
    participants = await db
      .select()
      .from(interactionParticipantsTable)
      .where(
        and(
          eq(interactionParticipantsTable.schoolId, schoolId),
          inArray(interactionParticipantsTable.interactionId, incidentIds),
        ),
      );
  }

  const studentIds = [...new Set(participants.map((p) => p.studentId))];
  const students = await loadStudents(schoolId, studentIds);

  // Per-(case,student) impact ratings — Core-Team editorial axis,
  // separate from per-incident severity. Default 2 = "Contributing"
  // when no explicit row exists yet.
  const impactRows = await db
    .select()
    .from(interactionCasePlayerImpactTable)
    .where(
      and(
        eq(interactionCasePlayerImpactTable.schoolId, schoolId),
        eq(interactionCasePlayerImpactTable.caseId, id),
      ),
    );
  const impactByStudent = new Map(
    impactRows.map((r) => [
      r.studentId,
      { impact: r.impact, updatedByName: r.updatedByName, updatedAt: r.updatedAt },
    ]),
  );

  const notes = await db
    .select()
    .from(interactionCaseNotesTable)
    .where(
      and(
        eq(interactionCaseNotesTable.schoolId, schoolId),
        eq(interactionCaseNotesTable.caseId, id),
      ),
    )
    .orderBy(desc(interactionCaseNotesTable.createdAt));

  // Witness statements for any incident in this case (powers the
  // expandable per-player drawer in the case detail UI).
  const statements =
    incidentIds.length > 0
      ? await db
          .select()
          .from(witnessStatementsTable)
          .where(
            and(
              eq(witnessStatementsTable.schoolId, schoolId),
              inArray(witnessStatementsTable.interactionId, incidentIds),
            ),
          )
          .orderBy(desc(witnessStatementsTable.requestedAt))
      : [];

  // Aggregate players across incidents with role tally
  const playerAgg = new Map<
    string,
    { studentId: string; total: number; counts: Record<string, number> }
  >();
  for (const p of participants) {
    let agg = playerAgg.get(p.studentId);
    if (!agg) {
      agg = { studentId: p.studentId, total: 0, counts: {} };
      playerAgg.set(p.studentId, agg);
    }
    agg.total++;
    agg.counts[p.role] = (agg.counts[p.role] ?? 0) + 1;
  }
  const players = [...playerAgg.values()]
    .map((a) => {
      const s = students.get(a.studentId);
      if (!s) return null;
      const imp = impactByStudent.get(a.studentId);
      return {
        studentId: a.studentId,
        firstName: s.firstName,
        lastName: s.lastName,
        grade: s.grade,
        total: a.total,
        counts: a.counts,
        caseImpact: imp?.impact ?? 2,
        caseImpactSet: !!imp,
        caseImpactUpdatedBy: imp?.updatedByName ?? "",
        caseImpactUpdatedAt: imp?.updatedAt ?? null,
      };
    })
    .filter(Boolean)
    .sort((x, y) => (y as { total: number }).total - (x as { total: number }).total);

  res.json({
    case: c,
    incidents: incidents.map((i) => ({
      ...i,
      participants: participants
        .filter((p) => p.interactionId === i.id)
        .map((p) => {
          const s = students.get(p.studentId);
          return {
            id: p.id,
            studentId: p.studentId,
            firstName: s?.firstName ?? "",
            lastName: s?.lastName ?? "",
            grade: s?.grade ?? null,
            role: p.role,
            notes: p.notes,
          };
        }),
    })),
    players,
    notes,
    statements,
  });
});

router.patch("/watchlist/cases/:id", async (req: Request, res: Response) => {
  const staff = (req as ReqWithStaff).staff;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const id = asInt(req.params["id"]);
  if (!id) {
    res.status(400).json({ error: "Invalid case id" });
    return;
  }
  const b = req.body as Record<string, unknown>;
  const patch: Partial<typeof interactionCasesTable.$inferInsert> = { updatedAt: new Date() };
  if (typeof b["title"] === "string") patch.title = clean(b["title"], 200);
  if (typeof b["summary"] === "string") patch.summary = clean(b["summary"], 2000);
  if (isCaseStatus(b["status"])) {
    patch.status = b["status"] as string;
    if (b["status"] === "closed") patch.closedAt = new Date();
    else patch.closedAt = null;
  }
  if (b["leadStaffId"] !== undefined) {
    const lid = asInt(b["leadStaffId"]);
    patch.leadStaffId = lid ?? null;
    if (lid) {
      const [s] = await db
        .select()
        .from(staffTable)
        .where(and(eq(staffTable.id, lid), eq(staffTable.schoolId, schoolId)));
      patch.leadStaffName = s ? s.displayName : "";
    } else {
      patch.leadStaffName = "";
    }
  }
  const [row] = await db
    .update(interactionCasesTable)
    .set(patch)
    .where(and(eq(interactionCasesTable.id, id), eq(interactionCasesTable.schoolId, schoolId)))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Case not found" });
    return;
  }
  await audit({ schoolId, entityType: "case", entityId: id, action: "updated", staff, payload: { ...patch } });
  res.json({ case: row });
});

router.post("/watchlist/cases/:id/notes", async (req: Request, res: Response) => {
  const staff = (req as ReqWithStaff).staff;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const id = asInt(req.params["id"]);
  if (!id) {
    res.status(400).json({ error: "Invalid case id" });
    return;
  }
  const body = clean(req.body?.body, 4000);
  if (!body) {
    res.status(400).json({ error: "body required" });
    return;
  }
  const [c] = await db
    .select()
    .from(interactionCasesTable)
    .where(and(eq(interactionCasesTable.id, id), eq(interactionCasesTable.schoolId, schoolId)));
  if (!c) {
    res.status(404).json({ error: "Case not found" });
    return;
  }
  const [note] = await db
    .insert(interactionCaseNotesTable)
    .values({
      schoolId,
      caseId: id,
      body,
      authorStaffId: staff.id,
      authorName: staff.displayName,
    })
    .returning();
  await audit({ schoolId, entityType: "case", entityId: id, action: "note_added", staff, payload: { noteId: note.id } });
  res.json({ note });
});

router.post("/watchlist/cases/:id/players", async (req: Request, res: Response) => {
  const staff = (req as ReqWithStaff).staff;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const id = asInt(req.params["id"]);
  if (!id) {
    res.status(400).json({ error: "Invalid case id" });
    return;
  }
  const b = req.body as Record<string, unknown>;
  const studentId = clean(b["studentId"], 60);
  const role = isRole(b["role"]) ? (b["role"] as InteractionRole) : "peripheral";
  const summary =
    clean(b["summary"], 280) ||
    `Added to case as ${role}`;
  const noteText = clean(b["notes"], 1000);
  if (!studentId) {
    res.status(400).json({ error: "studentId required" });
    return;
  }
  const [c] = await db
    .select()
    .from(interactionCasesTable)
    .where(and(eq(interactionCasesTable.id, id), eq(interactionCasesTable.schoolId, schoolId)));
  if (!c) {
    res.status(404).json({ error: "Case not found" });
    return;
  }
  const [stu] = await db
    .select()
    .from(studentsTable)
    .where(and(eq(studentsTable.studentId, studentId), eq(studentsTable.schoolId, schoolId)));
  if (!stu) {
    res.status(404).json({ error: "Student not found" });
    return;
  }
  // "Adding a player" creates a lightweight peripheral_note interaction
  // bound to the case so the network/case-detail surfaces the new edge
  // immediately without inventing a parallel "case_players" table.
  const today = ymdLocal(new Date());
  const [interaction] = await db
    .insert(interactionsTable)
    .values({
      schoolId,
      occurredDate: today,
      kind: "peripheral_note",
      severity: 1,
      location: "",
      summary,
      detail: noteText,
      caseId: id,
      loggedByStaffId: staff.id,
      loggedByName: staff.displayName,
    })
    .returning();
  await db.insert(interactionParticipantsTable).values({
    schoolId,
    interactionId: interaction.id,
    studentId,
    role,
    notes: noteText,
  });
  await audit({
    schoolId,
    entityType: "case",
    entityId: id,
    action: "player_added",
    staff,
    payload: { studentId, role, interactionId: interaction.id },
  });
  res.json({ ok: true, interaction, player: { studentId, role } });
});

// PUT /watchlist/cases/:id/players/:studentId/impact
// Set the per-(case,student) impact rating. 1=Minor, 2=Contributing,
// 3=Significant, 4=Driver. Audit-logged so changes to the editorial
// judgement are traceable just like incident severity.
router.put(
  "/watchlist/cases/:id/players/:studentId/impact",
  async (req: Request, res: Response) => {
    const staff = (req as ReqWithStaff).staff;
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const id = asInt(req.params["id"]);
    const studentId = String(req.params["studentId"] ?? "").trim();
    if (!id || !studentId) {
      res.status(400).json({ error: "Invalid case or student" });
      return;
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const rawImpact = asInt(b["impact"]);
    if (rawImpact == null) {
      res.status(400).json({ error: "impact required" });
      return;
    }
    const impact = Math.max(1, Math.min(4, rawImpact));

    const [c] = await db
      .select()
      .from(interactionCasesTable)
      .where(
        and(
          eq(interactionCasesTable.id, id),
          eq(interactionCasesTable.schoolId, schoolId),
        ),
      );
    if (!c) {
      res.status(404).json({ error: "Case not found" });
      return;
    }

    const [existing] = await db
      .select()
      .from(interactionCasePlayerImpactTable)
      .where(
        and(
          eq(interactionCasePlayerImpactTable.schoolId, schoolId),
          eq(interactionCasePlayerImpactTable.caseId, id),
          eq(interactionCasePlayerImpactTable.studentId, studentId),
        ),
      );
    const before = existing?.impact ?? null;

    if (existing) {
      await db
        .update(interactionCasePlayerImpactTable)
        .set({
          impact,
          updatedByStaffId: staff.id,
          updatedByName: staff.displayName,
          updatedAt: new Date(),
        })
        .where(eq(interactionCasePlayerImpactTable.id, existing.id));
    } else {
      await db.insert(interactionCasePlayerImpactTable).values({
        schoolId,
        caseId: id,
        studentId,
        impact,
        updatedByStaffId: staff.id,
        updatedByName: staff.displayName,
      });
    }

    await audit({
      schoolId,
      entityType: "case",
      entityId: id,
      action: "player_impact_set",
      staff,
      payload: { studentId, before, after: impact },
    });
    res.json({ ok: true, studentId, impact });
  },
);

// --- interactions ----------------------------------------------------

router.get("/watchlist/interactions", async (req: Request, res: Response) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const limit = Math.min(asInt(req.query["limit"]) ?? 25, 100);
  const windowDays = asInt(req.query["windowDays"]) ?? 30;
  const sinceYmd = ymdLocal(new Date(Date.now() - windowDays * 24 * 3600 * 1000));
  const onlyLoose = req.query["loose"] === "1";
  const conds = [
    eq(interactionsTable.schoolId, schoolId),
    gte(interactionsTable.occurredDate, sinceYmd),
  ];
  if (onlyLoose) conds.push(sql`${interactionsTable.caseId} IS NULL`);
  // Default: hide dismissed statements from the recent feed; opt in
  // explicitly with ?includeDismissed=1 (used by the Dismissed tab).
  if (req.query["includeDismissed"] !== "1") {
    conds.push(sql`${interactionsTable.status} <> 'dismissed'`);
  }
  if (req.query["onlyDismissed"] === "1") {
    conds.push(sql`${interactionsTable.status} = 'dismissed'`);
  }
  const rows = await db
    .select()
    .from(interactionsTable)
    .where(and(...conds))
    .orderBy(desc(interactionsTable.occurredAt))
    .limit(limit);

  const ids = rows.map((r) => r.id);
  let parts: InteractionParticipantRow[] = [];
  if (ids.length > 0) {
    parts = await db
      .select()
      .from(interactionParticipantsTable)
      .where(
        and(
          eq(interactionParticipantsTable.schoolId, schoolId),
          inArray(interactionParticipantsTable.interactionId, ids),
        ),
      );
  }
  const studentIds = [...new Set(parts.map((p) => p.studentId))];
  const students = await loadStudents(schoolId, studentIds);
  res.json({
    interactions: rows.map((r) => ({
      ...r,
      participants: parts
        .filter((p) => p.interactionId === r.id)
        .map((p) => {
          const s = students.get(p.studentId);
          return {
            id: p.id,
            studentId: p.studentId,
            firstName: s?.firstName ?? "",
            lastName: s?.lastName ?? "",
            grade: s?.grade ?? null,
            role: p.role,
            notes: p.notes,
          };
        }),
    })),
  });
});

router.post("/watchlist/interactions", async (req: Request, res: Response) => {
  const staff = (req as ReqWithStaff).staff;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const b = req.body as Record<string, unknown>;
  const kind = isKind(b["kind"]) ? (b["kind"] as InteractionKind) : null;
  const summary = clean(b["summary"], 280);
  const detail = clean(b["detail"], 4000);
  const location = clean(b["location"], 200);
  const occurredDateRaw = clean(b["occurredDate"], 10);
  const occurredDate = /^\d{4}-\d{2}-\d{2}$/.test(occurredDateRaw)
    ? occurredDateRaw
    : ymdLocal(new Date());
  const severity = Math.max(1, Math.min(4, asInt(b["severity"]) ?? 1));
  const caseId = asInt(b["caseId"]);
  const participants = Array.isArray(b["participants"]) ? (b["participants"] as Array<Record<string, unknown>>) : [];
  if (!kind) {
    res.status(400).json({ error: "Invalid kind" });
    return;
  }
  if (!summary) {
    res.status(400).json({ error: "summary required" });
    return;
  }
  // Validate caseId belongs to school if provided.
  if (caseId) {
    const [c] = await db
      .select()
      .from(interactionCasesTable)
      .where(and(eq(interactionCasesTable.id, caseId), eq(interactionCasesTable.schoolId, schoolId)));
    if (!c) {
      res.status(400).json({ error: "Invalid caseId" });
      return;
    }
  }
  // Validate participants: pre-resolve students.
  const sids = [...new Set(participants.map((p) => clean(p["studentId"], 60)).filter(Boolean))];
  const students = await loadStudents(schoolId, sids);
  for (const sid of sids) {
    if (!students.has(sid)) {
      res.status(400).json({ error: `Unknown studentId: ${sid}` });
      return;
    }
  }
  const [row] = await db
    .insert(interactionsTable)
    .values({
      schoolId,
      occurredDate,
      kind,
      severity,
      location,
      summary,
      detail,
      caseId: caseId ?? null,
      loggedByStaffId: staff.id,
      loggedByName: staff.displayName,
    })
    .returning();

  if (participants.length > 0) {
    const partRows = participants
      .map((p) => {
        const sid = clean(p["studentId"], 60);
        if (!sid || !students.has(sid)) return null;
        const role = isRole(p["role"]) ? (p["role"] as InteractionRole) : "peripheral";
        return {
          schoolId,
          interactionId: row.id,
          studentId: sid,
          role,
          notes: clean(p["notes"], 1000),
        };
      })
      .filter(Boolean) as Array<{
      schoolId: number;
      interactionId: number;
      studentId: string;
      role: string;
      notes: string;
    }>;
    if (partRows.length > 0) {
      await db
        .insert(interactionParticipantsTable)
        .values(partRows)
        .onConflictDoNothing();
    }
  }

  await audit({
    schoolId,
    entityType: "interaction",
    entityId: row.id,
    action: "created",
    staff,
    payload: { kind, severity, caseId, participantCount: participants.length },
  });
  res.json({ interaction: row });
});

router.get("/watchlist/interactions/:id", async (req: Request, res: Response) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const id = asInt(req.params["id"]);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [row] = await db
    .select()
    .from(interactionsTable)
    .where(and(eq(interactionsTable.id, id), eq(interactionsTable.schoolId, schoolId)));
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const parts = await db
    .select()
    .from(interactionParticipantsTable)
    .where(
      and(
        eq(interactionParticipantsTable.schoolId, schoolId),
        eq(interactionParticipantsTable.interactionId, id),
      ),
    );
  const students = await loadStudents(schoolId, parts.map((p) => p.studentId));
  const statements = await db
    .select()
    .from(witnessStatementsTable)
    .where(
      and(
        eq(witnessStatementsTable.schoolId, schoolId),
        eq(witnessStatementsTable.interactionId, id),
      ),
    );
  res.json({
    interaction: row,
    participants: parts.map((p) => {
      const s = students.get(p.studentId);
      return {
        id: p.id,
        studentId: p.studentId,
        firstName: s?.firstName ?? "",
        lastName: s?.lastName ?? "",
        grade: s?.grade ?? null,
        role: p.role,
        notes: p.notes,
      };
    }),
    statements,
  });
});

router.patch("/watchlist/interactions/:id", async (req: Request, res: Response) => {
  const staff = (req as ReqWithStaff).staff;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const id = asInt(req.params["id"]);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const b = req.body as Record<string, unknown>;
  const patch: Partial<typeof interactionsTable.$inferInsert> = { updatedAt: new Date() };
  if (typeof b["summary"] === "string") patch.summary = clean(b["summary"], 280);
  if (typeof b["detail"] === "string") patch.detail = clean(b["detail"], 4000);
  if (typeof b["location"] === "string") patch.location = clean(b["location"], 200);
  if (isKind(b["kind"])) patch.kind = b["kind"] as string;
  if (b["severity"] !== undefined) {
    const sv = asInt(b["severity"]);
    if (sv != null) patch.severity = Math.max(1, Math.min(4, sv));
  }
  if (b["caseId"] !== undefined) {
    const cid = asInt(b["caseId"]);
    if (cid) {
      const [c] = await db
        .select()
        .from(interactionCasesTable)
        .where(and(eq(interactionCasesTable.id, cid), eq(interactionCasesTable.schoolId, schoolId)));
      if (!c) {
        res.status(400).json({ error: "Invalid caseId" });
        return;
      }
      patch.caseId = cid;
    } else {
      patch.caseId = null;
    }
  }
  if (typeof b["status"] === "string" && ["open", "resolved", "dismissed"].includes(b["status"])) {
    patch.status = b["status"];
  }
  const [row] = await db
    .update(interactionsTable)
    .set(patch)
    .where(and(eq(interactionsTable.id, id), eq(interactionsTable.schoolId, schoolId)))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await audit({
    schoolId,
    entityType: "interaction",
    entityId: id,
    action: "updated",
    staff,
    payload: { ...patch, updatedAt: undefined },
  });
  res.json({ interaction: row });
});

router.post("/watchlist/interactions/:id/participants", async (req: Request, res: Response) => {
  const staff = (req as ReqWithStaff).staff;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const id = asInt(req.params["id"]);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const b = req.body as Record<string, unknown>;
  const studentId = clean(b["studentId"], 60);
  const role = isRole(b["role"]) ? (b["role"] as InteractionRole) : "peripheral";
  const notes = clean(b["notes"], 1000);
  if (!studentId) {
    res.status(400).json({ error: "studentId required" });
    return;
  }
  const [interaction] = await db
    .select()
    .from(interactionsTable)
    .where(and(eq(interactionsTable.id, id), eq(interactionsTable.schoolId, schoolId)));
  if (!interaction) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const [stu] = await db
    .select()
    .from(studentsTable)
    .where(and(eq(studentsTable.studentId, studentId), eq(studentsTable.schoolId, schoolId)));
  if (!stu) {
    res.status(404).json({ error: "Student not found" });
    return;
  }
  const [p] = await db
    .insert(interactionParticipantsTable)
    .values({ schoolId, interactionId: id, studentId, role, notes })
    .onConflictDoUpdate({
      target: [
        interactionParticipantsTable.interactionId,
        interactionParticipantsTable.studentId,
      ],
      set: { role, notes },
    })
    .returning();
  await audit({
    schoolId,
    entityType: "participant",
    entityId: p.id,
    action: "created",
    staff,
    payload: { interactionId: id, studentId, role },
  });
  res.json({ participant: p });
});

router.delete(
  "/watchlist/interactions/:id/participants/:pid",
  async (req: Request, res: Response) => {
    const staff = (req as ReqWithStaff).staff;
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const id = asInt(req.params["id"]);
    const pid = asInt(req.params["pid"]);
    if (!id || !pid) {
      res.status(400).json({ error: "Invalid ids" });
      return;
    }
    const deleted = await db
      .delete(interactionParticipantsTable)
      .where(
        and(
          eq(interactionParticipantsTable.id, pid),
          eq(interactionParticipantsTable.schoolId, schoolId),
          eq(interactionParticipantsTable.interactionId, id),
        ),
      )
      .returning();
    if (deleted.length === 0) {
      res.status(404).json({ error: "Participant not found" });
      return;
    }
    await audit({
      schoolId,
      entityType: "participant",
      entityId: pid,
      action: "deleted",
      staff,
      payload: { interactionId: id },
    });
    res.json({ ok: true });
  },
);

// --- statement-first triage actions ---------------------------------

// Promote a witness statement to a brand-new case. The statement
// becomes the case's lead_statement_id; its tagged participants
// remain on the statement and surface on the case automatically via
// the GET /cases/:id rollup (case players are derived from
// interaction_participants, not stored separately).
//
// Concurrency: wrapped in a transaction with `SELECT … FOR UPDATE`
// on the source statement so two clicks (or two browser tabs) can't
// both create a case from the same statement.
router.post(
  "/watchlist/interactions/:id/promote-to-case",
  async (req: Request, res: Response) => {
    const staff = (req as ReqWithStaff).staff;
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const id = asInt(req.params["id"]);
    if (!id) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const b = req.body as Record<string, unknown>;
    const title = clean(b["title"], 200);
    const summary = clean(b["summary"], 2000);
    const leadStaffId = asInt(b["leadStaffId"]);
    const status = isCaseStatus(b["status"]) ? (b["status"] as string) : "open";
    if (!title) {
      res.status(400).json({ error: "title required" });
      return;
    }

    let leadName = "";
    if (leadStaffId) {
      const [s] = await db
        .select()
        .from(staffTable)
        .where(and(eq(staffTable.id, leadStaffId), eq(staffTable.schoolId, schoolId)));
      if (s) leadName = s.displayName;
    }

    type PromoteResult =
      | { ok: true; caseRow: typeof interactionCasesTable.$inferSelect }
      | { ok: false; status: number; error: string };

    const result: PromoteResult = await db.transaction(async (tx) => {
      // Lock the source statement row so a concurrent promote/attach
      // can't slip in between our check and our write.
      const locked = (
        await tx.execute(sql`
          SELECT id, school_id, case_id, status
            FROM interactions
           WHERE id = ${id}
             AND school_id = ${schoolId}
           FOR UPDATE
        `)
      ).rows as Array<{ id: number; case_id: number | null; status: string }>;
      const stmt = locked[0];
      if (!stmt) {
        return { ok: false, status: 404, error: "Statement not found" };
      }
      if (stmt.case_id) {
        return {
          ok: false,
          status: 409,
          error: "Statement is already attached to a case. Detach it first.",
        };
      }
      if (stmt.status === "dismissed") {
        return {
          ok: false,
          status: 409,
          error: "Cannot promote a dismissed statement. Restore it first.",
        };
      }

      const [{ next }] = (
        await tx.execute(sql`
          SELECT COALESCE(MAX(case_number), 0) + 1 AS "next"
            FROM interaction_cases WHERE school_id = ${schoolId}
        `)
      ).rows as { next: number }[];

      const [caseRow] = await tx
        .insert(interactionCasesTable)
        .values({
          schoolId,
          caseNumber: next,
          title,
          summary,
          status,
          leadStaffId: leadStaffId ?? null,
          leadStaffName: leadName,
          leadStatementId: id,
          createdByStaffId: staff.id,
          createdByName: staff.displayName,
        })
        .returning();

      await tx
        .update(interactionsTable)
        .set({ caseId: caseRow.id, updatedAt: new Date() })
        .where(and(eq(interactionsTable.id, id), eq(interactionsTable.schoolId, schoolId)));

      return { ok: true, caseRow };
    });

    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    await audit({
      schoolId,
      entityType: "case",
      entityId: result.caseRow.id,
      action: "promoted_from_statement",
      staff,
      payload: { statementId: id, title, leadStaffId },
    });
    res.json({ case: result.caseRow });
  },
);

// Dismiss a statement (triage no-action). Required: short reason.
// Idempotent — re-dismissing updates reason/timestamp.
router.post(
  "/watchlist/interactions/:id/dismiss",
  async (req: Request, res: Response) => {
    const staff = (req as ReqWithStaff).staff;
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const id = asInt(req.params["id"]);
    if (!id) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const reason = clean((req.body as Record<string, unknown>)["reason"], 1000);
    if (reason.length < 5) {
      res
        .status(400)
        .json({ error: "Reason required (min 5 chars) for the audit trail." });
      return;
    }
    const [stmt] = await db
      .select()
      .from(interactionsTable)
      .where(and(eq(interactionsTable.id, id), eq(interactionsTable.schoolId, schoolId)));
    if (!stmt) {
      res.status(404).json({ error: "Statement not found" });
      return;
    }
    if (stmt.caseId) {
      res
        .status(409)
        .json({ error: "Detach this statement from its case before dismissing." });
      return;
    }
    const [row] = await db
      .update(interactionsTable)
      .set({
        status: "dismissed",
        dismissedAt: new Date(),
        dismissedReason: reason,
        dismissedByStaffId: staff.id,
        dismissedByName: staff.displayName,
        updatedAt: new Date(),
      })
      .where(and(eq(interactionsTable.id, id), eq(interactionsTable.schoolId, schoolId)))
      .returning();
    await audit({
      schoolId,
      entityType: "interaction",
      entityId: id,
      action: "dismissed",
      staff,
      payload: { reason },
    });
    res.json({ interaction: row });
  },
);

// Restore a dismissed statement back to the intake queue.
router.post(
  "/watchlist/interactions/:id/restore",
  async (req: Request, res: Response) => {
    const staff = (req as ReqWithStaff).staff;
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const id = asInt(req.params["id"]);
    if (!id) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [row] = await db
      .update(interactionsTable)
      .set({
        status: "open",
        dismissedAt: null,
        dismissedReason: "",
        dismissedByStaffId: null,
        dismissedByName: "",
        updatedAt: new Date(),
      })
      .where(and(eq(interactionsTable.id, id), eq(interactionsTable.schoolId, schoolId)))
      .returning();
    if (!row) {
      res.status(404).json({ error: "Statement not found" });
      return;
    }
    await audit({
      schoolId,
      entityType: "interaction",
      entityId: id,
      action: "restored",
      staff,
      payload: {},
    });
    res.json({ interaction: row });
  },
);

// --- statements ------------------------------------------------------

router.get("/watchlist/statements", async (req: Request, res: Response) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const includeCompleted = req.query["all"] === "1";
  const conds = [eq(witnessStatementsTable.schoolId, schoolId)];
  const rows = await db
    .select()
    .from(witnessStatementsTable)
    .where(and(...conds))
    .orderBy(asc(witnessStatementsTable.requestedAt));
  const filtered = includeCompleted
    ? rows
    : rows.filter((r) => r.status !== "completed" && r.status !== "waived");
  const sids = [...new Set(filtered.map((r) => r.studentId))];
  const students = await loadStudents(schoolId, sids);
  res.json({
    statements: filtered.map((r) => {
      const s = students.get(r.studentId);
      return {
        ...r,
        firstName: s?.firstName ?? "",
        lastName: s?.lastName ?? "",
        grade: s?.grade ?? null,
        ageDays: ageDays(r.requestedAt as unknown as Date),
      };
    }),
  });
});

router.post("/watchlist/statements/:id/remind", async (req: Request, res: Response) => {
  const staff = (req as ReqWithStaff).staff;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const id = asInt(req.params["id"]);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [row] = await db
    .update(witnessStatementsTable)
    .set({
      status: "reminded",
      remindedAt: new Date(),
      remindCount: sql`${witnessStatementsTable.remindCount} + 1`,
    })
    .where(
      and(
        eq(witnessStatementsTable.id, id),
        eq(witnessStatementsTable.schoolId, schoolId),
      ),
    )
    .returning();
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await audit({
    schoolId,
    entityType: "statement",
    entityId: id,
    action: "reminded",
    staff,
    payload: { remindCount: row.remindCount },
  });
  res.json({ statement: row });
});

// Create (or upsert) a witness statement for a student against an incident.
// Used by the per-player drawer in the case detail when a Core Team member
// opens up a player and wants to capture or request their statement.
router.post(
  "/watchlist/interactions/:id/statements",
  async (req: Request, res: Response) => {
    const staff = (req as ReqWithStaff).staff;
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const id = asInt(req.params["id"]);
    if (!id) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const b = req.body as Record<string, unknown>;
    const studentId = clean(b["studentId"], 60);
    const body = clean(b["body"], 4000);
    if (!studentId) {
      res.status(400).json({ error: "studentId required" });
      return;
    }
    const [interaction] = await db
      .select()
      .from(interactionsTable)
      .where(and(eq(interactionsTable.id, id), eq(interactionsTable.schoolId, schoolId)));
    if (!interaction) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const [stu] = await db
      .select()
      .from(studentsTable)
      .where(and(eq(studentsTable.studentId, studentId), eq(studentsTable.schoolId, schoolId)));
    if (!stu) {
      res.status(404).json({ error: "Student not found" });
      return;
    }
    // Reject statements for students who aren't participants on this
    // incident — keeps the per-player drawer / case detail model honest.
    const [link] = await db
      .select({ id: interactionParticipantsTable.id })
      .from(interactionParticipantsTable)
      .where(
        and(
          eq(interactionParticipantsTable.schoolId, schoolId),
          eq(interactionParticipantsTable.interactionId, id),
          eq(interactionParticipantsTable.studentId, studentId),
        ),
      );
    if (!link) {
      res.status(400).json({
        error: "Student is not a participant on this interaction",
      });
      return;
    }
    const [row] = await db
      .insert(witnessStatementsTable)
      .values({
        schoolId,
        interactionId: id,
        studentId,
        status: body ? "completed" : "requested",
        requestedByStaffId: staff.id,
        requestedByName: staff.displayName,
        body,
        completedAt: body ? new Date() : null,
      })
      .onConflictDoUpdate({
        target: [
          witnessStatementsTable.interactionId,
          witnessStatementsTable.studentId,
        ],
        set: {
          // Only flip to completed when a body was supplied; preserve
          // existing status (e.g. "reminded") otherwise.
          ...(body
            ? { body, status: "completed", completedAt: new Date() }
            : {}),
        },
      })
      .returning();
    await audit({
      schoolId,
      entityType: "statement",
      entityId: row.id,
      action: body ? "completed" : "requested",
      staff,
      payload: { interactionId: id, studentId },
    });
    res.json({ statement: row });
  },
);

// Update a statement's body without forcing a status change. Used by the
// in-app dictation flow so a Core Team member can save a working draft
// before marking the statement complete.
router.patch("/watchlist/statements/:id", async (req: Request, res: Response) => {
  const staff = (req as ReqWithStaff).staff;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const id = asInt(req.params["id"]);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const b = req.body as Record<string, unknown>;
  const body = typeof b["body"] === "string" ? clean(b["body"], 4000) : null;
  if (body === null) {
    res.status(400).json({ error: "body required" });
    return;
  }
  const [row] = await db
    .update(witnessStatementsTable)
    .set({ body })
    .where(
      and(
        eq(witnessStatementsTable.id, id),
        eq(witnessStatementsTable.schoolId, schoolId),
      ),
    )
    .returning();
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await audit({
    schoolId,
    entityType: "statement",
    entityId: id,
    action: "edited",
    staff,
    payload: { length: body.length },
  });
  res.json({ statement: row });
});

router.post("/watchlist/statements/:id/complete", async (req: Request, res: Response) => {
  const staff = (req as ReqWithStaff).staff;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const id = asInt(req.params["id"]);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const body = clean(req.body?.body, 4000);
  const [row] = await db
    .update(witnessStatementsTable)
    .set({ status: "completed", completedAt: new Date(), body })
    .where(
      and(
        eq(witnessStatementsTable.id, id),
        eq(witnessStatementsTable.schoolId, schoolId),
      ),
    )
    .returning();
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await audit({ schoolId, entityType: "statement", entityId: id, action: "completed", staff });
  res.json({ statement: row });
});

// --- quick entries ---------------------------------------------------
//
// Core-Team-managed catalog of "quick entry" templates. Selecting one in
// the Log Interaction modal pre-fills kind/severity/location/summary so
// common scenarios (hallway shove, cafeteria verbal, bus rumor, etc.)
// can be captured in two clicks. All routes are core-team-gated by the
// router-level middleware above.

router.get("/watchlist/quick-entries", async (req: Request, res: Response) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const rows = await db
    .select()
    .from(interactionQuickEntriesTable)
    .where(eq(interactionQuickEntriesTable.schoolId, schoolId))
    .orderBy(
      asc(interactionQuickEntriesTable.sortOrder),
      asc(interactionQuickEntriesTable.label),
    );
  res.json({ entries: rows });
});

router.post("/watchlist/quick-entries", async (req: Request, res: Response) => {
  const staff = (req as ReqWithStaff).staff;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const b = req.body as Record<string, unknown>;
  const label = clean(b["label"], 80);
  const kind = isKind(b["kind"]) ? (b["kind"] as InteractionKind) : null;
  const severity = Math.max(1, Math.min(4, asInt(b["severity"]) ?? 2));
  const location = clean(b["location"], 200);
  const summaryTemplate = clean(b["summaryTemplate"], 280);
  const sortOrder = asInt(b["sortOrder"]) ?? 0;
  if (!label || !kind) {
    res.status(400).json({ error: "label and valid kind required" });
    return;
  }
  try {
    const [row] = await db
      .insert(interactionQuickEntriesTable)
      .values({
        schoolId,
        label,
        kind,
        severity,
        location,
        summaryTemplate,
        sortOrder,
        createdByStaffId: staff.id,
        createdByName: staff.displayName,
      })
      .returning();
    await audit({
      schoolId,
      entityType: "quick_entry",
      entityId: row.id,
      action: "created",
      staff,
      payload: { label, kind },
    });
    res.json({ entry: row });
  } catch (e) {
    req.log.warn({ err: e }, "quick entry create failed");
    res.status(400).json({ error: "Label must be unique within school" });
  }
});

router.patch(
  "/watchlist/quick-entries/:id",
  async (req: Request, res: Response) => {
    const staff = (req as ReqWithStaff).staff;
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const id = asInt(req.params["id"]);
    if (!id) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const b = req.body as Record<string, unknown>;
    const patch: Partial<typeof interactionQuickEntriesTable.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (typeof b["label"] === "string") patch.label = clean(b["label"], 80);
    if (isKind(b["kind"])) patch.kind = b["kind"] as InteractionKind;
    if (b["severity"] !== undefined) {
      const sv = asInt(b["severity"]);
      if (sv != null) patch.severity = Math.max(1, Math.min(4, sv));
    }
    if (typeof b["location"] === "string")
      patch.location = clean(b["location"], 200);
    if (typeof b["summaryTemplate"] === "string")
      patch.summaryTemplate = clean(b["summaryTemplate"], 280);
    if (typeof b["sortOrder"] === "number") patch.sortOrder = b["sortOrder"];
    if (typeof b["active"] === "boolean") patch.active = b["active"];
    try {
      const [row] = await db
        .update(interactionQuickEntriesTable)
        .set(patch)
        .where(
          and(
            eq(interactionQuickEntriesTable.id, id),
            eq(interactionQuickEntriesTable.schoolId, schoolId),
          ),
        )
        .returning();
      if (!row) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      await audit({
        schoolId,
        entityType: "quick_entry",
        entityId: id,
        action: "updated",
        staff,
        payload: patch,
      });
      res.json({ entry: row });
    } catch (e) {
      req.log.warn({ err: e }, "quick entry update failed");
      res.status(400).json({ error: "Label must be unique within school" });
    }
  },
);

router.delete(
  "/watchlist/quick-entries/:id",
  async (req: Request, res: Response) => {
    const staff = (req as ReqWithStaff).staff;
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const id = asInt(req.params["id"]);
    if (!id) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const deleted = await db
      .delete(interactionQuickEntriesTable)
      .where(
        and(
          eq(interactionQuickEntriesTable.id, id),
          eq(interactionQuickEntriesTable.schoolId, schoolId),
        ),
      )
      .returning();
    if (deleted.length === 0) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    await audit({
      schoolId,
      entityType: "quick_entry",
      entityId: id,
      action: "deleted",
      staff,
      payload: {},
    });
    res.json({ ok: true });
  },
);

export default router;
