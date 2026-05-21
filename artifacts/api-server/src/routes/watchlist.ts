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
  caseMentionsTable,
  caseVideoEvidenceTable,
  caseVideoEvidencePlayersTable,
  cameraRegistryTable,
  VIDEO_CONFIDENCE_TIERS,
  type VideoConfidenceTier,
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
  caseConsistencyRunsTable,
  caseConsistencyFindingsTable,
  caseConsistencyStateTable,
  caseFootageRequestsTable,
  caseOutcomeTypesTable,
} from "@workspace/db";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import {
  syncWitnessStatementMentions,
  updateMentionCaseIdForInteraction,
} from "../lib/mentions.js";
import {
  isCoreTeam,
  isAdminOrSuperUser,
  isCaseInvestigator,
} from "../lib/coreTeam.js";
import { schoolYearLabelFor, getSchoolTimezone } from "../lib/schoolYear.js";
import {
  assignWitnessSeqForInteraction,
  formattedIdForStatement,
  formattedIdsForStatements,
} from "../lib/witnessStatementId.js";
import {
  scheduleConsistencyRun,
  runConsistencyCheck,
} from "../lib/caseConsistencyAi.js";
import { assembleCaseBundle } from "../lib/caseConsistencyBundle.js";

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
    // Watchlist surface (cases, witness statements, notes, video
    // evidence) is open to Core Team *or* Case Investigator roles.
    // Core Team includes School Psychologist (intervention-side); Case
    // Investigator adds Dean. The union here lets every role that
    // historically had watchlist access keep it AND lets a Dean reach
    // witness-statement creation without granting the rest of the
    // intervention surface.
    if (!isCoreTeam(staff) && !isCaseInvestigator(staff)) {
      res
        .status(403)
        .json({ error: "Core Team or Case Investigator role required" });
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

// Resolve the time window for a watchlist query. Custom date ranges
// (?from=YYYY-MM-DD&to=YYYY-MM-DD) take priority; otherwise we fall back
// to the legacy ?windowDays preset (default supplied by caller). `untilYmd`
// is null for the rolling-window case so callers can skip the upper bound.
function parseWindow(
  req: Request,
  defaultWindowDays = 14,
): { sinceYmd: string; untilYmd: string | null; windowDays: number } {
  const ymdRe = /^\d{4}-\d{2}-\d{2}$/;
  const fromRaw = req.query["from"];
  const toRaw = req.query["to"];
  const from = typeof fromRaw === "string" && ymdRe.test(fromRaw) ? fromRaw : null;
  const to = typeof toRaw === "string" && ymdRe.test(toRaw) ? toRaw : null;
  if (from) {
    // Effective span (inclusive) — used so client-facing copy that says
    // "in Nd" still reads sensibly when the user picked a custom range.
    const days = to
      ? Math.max(
          1,
          Math.round(
            (new Date(`${to}T00:00:00`).getTime() -
              new Date(`${from}T00:00:00`).getTime()) /
              (24 * 3600 * 1000),
          ) + 1,
        )
      : Math.max(
          1,
          Math.round(
            (Date.now() - new Date(`${from}T00:00:00`).getTime()) /
              (24 * 3600 * 1000),
          ) + 1,
        );
    return { sinceYmd: from, untilYmd: to, windowDays: days };
  }
  const windowDays = asInt(req.query["windowDays"]) ?? defaultWindowDays;
  return {
    sinceYmd: ymdLocal(new Date(Date.now() - windowDays * 24 * 3600 * 1000)),
    untilYmd: null,
    windowDays,
  };
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

// Resolve the case_id for a witness statement's parent interaction and,
// if the interaction is attached to a case, schedule a debounced AI
// consistency re-run. Used by the statement-edit and statement-complete
// hooks where we have the statement row but need the owning case to
// trigger a re-evaluation.
async function maybeScheduleForStatement(
  schoolId: number,
  interactionId: number,
  trigger: "new_statement" | "new_interaction" | "new_video" | "initial",
  staff: StaffRow,
): Promise<void> {
  const [row] = await db
    .select({ caseId: interactionsTable.caseId })
    .from(interactionsTable)
    .where(
      and(
        eq(interactionsTable.id, interactionId),
        eq(interactionsTable.schoolId, schoolId),
      ),
    )
    .limit(1);
  if (!row?.caseId) return;
  scheduleConsistencyRun({
    schoolId,
    caseId: row.caseId,
    triggerReason: trigger,
    actorStaffId: staff.id,
    actorName: staff.displayName,
  });
}

async function audit(opts: {
  schoolId: number;
  entityType: string;
  entityId: number;
  action: string;
  staff: StaffRow;
  payload?: Record<string, unknown>;
  // Optional transactional client. When supplied, the audit insert
  // joins the caller's tx so a partial failure rolls back both the
  // mutation AND the audit row together. When omitted, audit writes
  // through the shared db handle (legacy behavior).
  tx?: Parameters<Parameters<typeof db.transaction>[0]>[0];
}) {
  const exec = opts.tx ?? db;
  await exec.insert(interactionAuditLogTable).values({
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

// --- student search (Investigations-only) ----------------------------
//
// Typeahead used by the Student Spider. Unlike the generic
// /api/student-finder/search (which returns any student in the school),
// this is scoped to students with at least one investigation footprint
// — i.e. they appear as a participant in any interaction in this school,
// regardless of whether a witness statement was ever filed. This is what
// keeps a Spider search from landing on a student with zero connections
// and an empty web.

router.get(
  "/watchlist/student-search",
  async (req: Request, res: Response) => {
    if (!req.staffId) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;

    const qRaw = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (qRaw.length < 1) {
      res.json({ students: [] });
      return;
    }
    const q = qRaw.slice(0, 64);

    // Subquery: distinct student_ids that appear as a participant in an
    // interaction belonging to this school. Using EXISTS keeps the join
    // costs sane and naturally dedupes.
    const rows = await db
      .select({
        studentId: studentsTable.studentId,
        localSisId: studentsTable.localSisId,
        firstName: studentsTable.firstName,
        lastName: studentsTable.lastName,
        grade: studentsTable.grade,
      })
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.schoolId, schoolId),
          or(
            // Prefix match on first/last/local-SIS-ID. FLEID is
            // server-only and never used as a search key.
            ilike(studentsTable.firstName, `${q}%`),
            ilike(studentsTable.lastName, `${q}%`),
            ilike(studentsTable.localSisId, `${q}%`),
          ),
          sql`EXISTS (
            SELECT 1
              FROM ${interactionParticipantsTable} p
              JOIN ${interactionsTable} i
                ON i.id = p.interaction_id
             WHERE p.student_id = ${studentsTable.studentId}
               AND i.school_id = ${schoolId}
          )`,
        ),
      )
      .orderBy(asc(studentsTable.lastName), asc(studentsTable.firstName))
      .limit(20);

    res.json({ students: rows });
  },
);

// --- orbit (top-of-orbit chart data) ---------------------------------

router.get("/watchlist/orbit", async (req: Request, res: Response) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const { sinceYmd, untilYmd, windowDays } = parseWindow(req, 14);

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
      ${untilYmd ? sql`AND i.occurred_date <= ${untilYmd}` : sql``}
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
        localSisId: s.localSisId ?? null,
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
  const { sinceYmd, untilYmd, windowDays } = parseWindow(req, 14);
  const untilClause = untilYmd ? sql`AND i.occurred_date <= ${untilYmd}` : sql``;
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);

  const alerts: Alert[] = [];

  // Frequency rule: >= 5 participations in window
  const freq = (await db.execute(sql`
    SELECT p.student_id AS "studentId", COUNT(*)::int AS "total"
    FROM interaction_participants p
    JOIN interactions i ON i.id = p.interaction_id AND i.school_id = p.school_id
    WHERE p.school_id = ${schoolId}
      AND i.occurred_date >= ${sinceYmd}
      ${untilClause}
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
      ${untilClause}
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
      ${untilClause}
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
      ${untilClause}
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
                        c.school_year_label AS "schoolYearLabel",
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
      schoolYearLabel: string;
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
            photoObjectKey: stu.photoObjectKey,
            photoConsent: stu.photoConsent,
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
  // Per-(school, schoolYear) case_number. The label is derived from
  // the open date so cases group cleanly into school years for filing
  // and reporting; see lib/schoolYear.ts for the label format. The
  // school's own IANA timezone decides the year boundary so a 9 pm PT
  // open on June 30 stays in the current year rather than spilling
  // into next year's bucket via UTC.
  const tz = await getSchoolTimezone(schoolId);
  const yearLabel = schoolYearLabelFor(new Date(), tz);
  const [{ next }] = (await db.execute(sql`
    SELECT COALESCE(MAX(case_number), 0) + 1 AS "next"
      FROM interaction_cases
     WHERE school_id = ${schoolId}
       AND school_year_label = ${yearLabel}
  `)).rows as { next: number }[];

  const [row] = await db
    .insert(interactionCasesTable)
    .values({
      schoolId,
      caseNumber: next,
      schoolYearLabel: yearLabel,
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
    // Closing requires an outcome — refuse the shortcut and direct the
    // caller to /close where outcomeCode is enforced. Reopening from the
    // PATCH path is also blocked so the audit trail (with required reason)
    // stays in /reopen — without this guard, PATCH {status:'open'} on a
    // closed case would silently un-close it without writing the
    // 'reopened' audit row or demanding a justification.
    if (b["status"] === "closed") {
      res.status(400).json({
        error:
          "Use POST /watchlist/cases/:id/close to close a case (outcome required).",
      });
      return;
    }
    const [existing] = await db
      .select({ status: interactionCasesTable.status })
      .from(interactionCasesTable)
      .where(
        and(
          eq(interactionCasesTable.id, id),
          eq(interactionCasesTable.schoolId, schoolId),
        ),
      );
    if (!existing) {
      res.status(404).json({ error: "Case not found" });
      return;
    }
    if (existing.status === "closed") {
      res.status(400).json({
        error:
          "Use POST /watchlist/cases/:id/reopen to reopen a closed case (admin + reason required).",
      });
      return;
    }
    patch.status = b["status"] as string;
    patch.closedAt = null;
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
  const { sinceYmd, untilYmd } = parseWindow(req, 30);
  const onlyLoose = req.query["loose"] === "1";
  const conds = [
    eq(interactionsTable.schoolId, schoolId),
    gte(interactionsTable.occurredDate, sinceYmd),
  ];
  if (untilYmd) conds.push(lte(interactionsTable.occurredDate, untilYmd));
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
  const witnessStudentId = clean(b["witnessStudentId"], 60);
  if (!kind) {
    res.status(400).json({ error: "Invalid kind" });
    return;
  }
  if (!summary) {
    res.status(400).json({ error: "summary required" });
    return;
  }
  if (!detail) {
    res.status(400).json({ error: "Student statement is required." });
    return;
  }
  if (!witnessStudentId) {
    res.status(400).json({ error: "Pick the student giving this statement." });
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
  // Validate participants AND the witness author in one pass.
  const sids = [
    ...new Set(
      [
        witnessStudentId,
        ...participants.map((p) => clean(p["studentId"], 60)),
      ].filter(Boolean),
    ),
  ];
  const students = await loadStudents(schoolId, sids);
  for (const sid of sids) {
    if (!students.has(sid)) {
      res.status(400).json({ error: `Unknown studentId: ${sid}` });
      return;
    }
  }
  const witnessRow = students.get(witnessStudentId)!;
  const witnessStudentName = `${witnessRow.firstName} ${witnessRow.lastName}`.trim();
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
      witnessStudentId,
      witnessStudentName,
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
  if (caseId) {
    scheduleConsistencyRun({
      schoolId,
      caseId,
      triggerReason: "new_interaction",
      actorStaffId: staff.id,
      actorName: staff.displayName,
    });
  }
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
  // Resolve the owning case's number + school-year label so we can
  // hand back a `formattedCaseId` (e.g. "26-27-0042") and per-row
  // `formattedId` (e.g. "CASE-26-27-0042-WS-03"). Both null when the
  // interaction hasn't been promoted to a case yet.
  let formattedCaseId: string | null = null;
  if (row.caseId != null) {
    const [c] = await db
      .select({
        caseNumber: interactionCasesTable.caseNumber,
        schoolYearLabel: interactionCasesTable.schoolYearLabel,
      })
      .from(interactionCasesTable)
      .where(
        and(
          eq(interactionCasesTable.id, row.caseId),
          eq(interactionCasesTable.schoolId, schoolId),
        ),
      );
    if (c?.caseNumber != null && c.schoolYearLabel) {
      formattedCaseId = `${c.schoolYearLabel}-${String(c.caseNumber).padStart(4, "0")}`;
    }
  }
  const formattedIds = await formattedIdsForStatements({
    schoolId,
    statements: statements.map((s) => ({
      id: s.id,
      interactionId: s.interactionId,
      wsSeq: s.wsSeq ?? null,
    })),
  });
  res.json({
    interaction: { ...row, formattedCaseId },
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
    statements: statements.map((s) => ({
      ...s,
      formattedId: formattedIds.get(s.id) ?? null,
    })),
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
  // When this PATCH changes case attachment, the update + ws_seq
  // assignment must happen in a single tx that locks the new case
  // row first. Otherwise a concurrent attach/move can race between
  // our UPDATE and assignWitnessSeqForInteraction and we'd number
  // statements against a stale case.
  const willChangeCase = b["caseId"] !== undefined;
  const row = await db.transaction(async (tx) => {
    if (willChangeCase && patch.caseId != null) {
      // Lock the target case row before mutating the interaction so
      // any concurrent assign on the same case serializes behind us.
      await tx.execute(sql`
        SELECT id FROM interaction_cases
         WHERE id = ${patch.caseId} AND school_id = ${schoolId}
         FOR UPDATE
      `);
    }
    const [updated] = await tx
      .update(interactionsTable)
      .set(patch)
      .where(and(eq(interactionsTable.id, id), eq(interactionsTable.schoolId, schoolId)))
      .returning();
    if (!updated) return null;
    if (willChangeCase) {
      await updateMentionCaseIdForInteraction({
        schoolId,
        interactionId: id,
        newCaseId: updated.caseId ?? null,
        executor: tx,
      });
      if (updated.caseId != null) {
        // Re-validate inside tx: confirm interaction still belongs to
        // the case we just locked before assigning seq numbers.
        const stillAttached = updated.caseId === patch.caseId;
        if (stillAttached) {
          await assignWitnessSeqForInteraction(tx, {
            schoolId,
            caseId: updated.caseId,
            interactionId: id,
          });
        }
      }
    }
    return updated;
  });
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

      const tz = await getSchoolTimezone(schoolId);
      const yearLabel = schoolYearLabelFor(new Date(), tz);
      const [{ next }] = (
        await tx.execute(sql`
          SELECT COALESCE(MAX(case_number), 0) + 1 AS "next"
            FROM interaction_cases
           WHERE school_id = ${schoolId}
             AND school_year_label = ${yearLabel}
        `)
      ).rows as { next: number }[];

      const [caseRow] = await tx
        .insert(interactionCasesTable)
        .values({
          schoolId,
          caseNumber: next,
          schoolYearLabel: yearLabel,
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

      // Stamp human-readable WS sequence numbers on any witness
      // statements for this interaction now that it's attached to a
      // case. See lib/witnessStatementId.ts.
      await assignWitnessSeqForInteraction(tx, {
        schoolId,
        caseId: caseRow.id,
        interactionId: id,
      });

      // Re-point any existing witness-statement mentions at the new
      // case_id. Must run inside this tx so the mention pointer
      // update participates in the same atomic unit as the case
      // creation, interaction attach, and ws_seq stamping — otherwise
      // a rollback would leave the mentions index pointing at a case
      // that never committed.
      await updateMentionCaseIdForInteraction({
        schoolId,
        interactionId: id,
        newCaseId: caseRow.id,
        executor: tx,
      });

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
    scheduleConsistencyRun({
      schoolId,
      caseId: result.caseRow.id,
      triggerReason: "initial",
      actorStaffId: staff.id,
      actorName: staff.displayName,
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
  const formattedIds = await formattedIdsForStatements({
    schoolId,
    statements: filtered.map((r) => ({
      id: r.id,
      interactionId: r.interactionId,
      wsSeq: r.wsSeq ?? null,
    })),
  });
  res.json({
    statements: filtered.map((r) => {
      const s = students.get(r.studentId);
      return {
        ...r,
        firstName: s?.firstName ?? "",
        lastName: s?.lastName ?? "",
        grade: s?.grade ?? null,
        ageDays: ageDays(r.requestedAt as unknown as Date),
        formattedId: formattedIds.get(r.id) ?? null,
      };
    }),
  });
});

// All witness statements ever requested from a single student, with the
// originating interaction summary + (when the interaction has been
// promoted to a case) the case number/title. Powers the inline
// "Witness statements" block in the WatchlistNetwork side panel so an
// investigator can read the student's own words without leaving the
// network view.
router.get(
  "/watchlist/students/:studentId/statements",
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const studentId = String(req.params["studentId"] ?? "").trim();
    if (!studentId) {
      res.status(400).json({ error: "studentId required" });
      return;
    }
    const rows = await db
      .select({
        id: witnessStatementsTable.id,
        interactionId: witnessStatementsTable.interactionId,
        status: witnessStatementsTable.status,
        body: witnessStatementsTable.body,
        requestedByName: witnessStatementsTable.requestedByName,
        requestedAt: witnessStatementsTable.requestedAt,
        completedAt: witnessStatementsTable.completedAt,
        remindCount: witnessStatementsTable.remindCount,
        interactionSummary: interactionsTable.summary,
        interactionOccurredAt: interactionsTable.occurredAt,
        interactionKind: interactionsTable.kind,
        caseId: interactionsTable.caseId,
        caseNumber: interactionCasesTable.caseNumber,
        caseTitle: interactionCasesTable.title,
        caseStatus: interactionCasesTable.status,
      })
      .from(witnessStatementsTable)
      .innerJoin(
        interactionsTable,
        and(
          eq(interactionsTable.id, witnessStatementsTable.interactionId),
          eq(interactionsTable.schoolId, schoolId),
        ),
      )
      .leftJoin(
        interactionCasesTable,
        and(
          eq(interactionCasesTable.id, interactionsTable.caseId),
          eq(interactionCasesTable.schoolId, schoolId),
        ),
      )
      .where(
        and(
          eq(witnessStatementsTable.schoolId, schoolId),
          eq(witnessStatementsTable.studentId, studentId),
        ),
      )
      .orderBy(desc(witnessStatementsTable.requestedAt))
      .limit(50);
    res.json({ statements: rows });
  },
);

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
  const remindedFormattedId = await formattedIdForStatement({
    schoolId,
    interactionId: row.interactionId,
    wsSeq: row.wsSeq ?? null,
  });
  await audit({
    schoolId,
    entityType: "statement",
    entityId: id,
    action: "reminded",
    staff,
    payload: {
      remindCount: row.remindCount,
      ...(remindedFormattedId ? { formattedId: remindedFormattedId } : {}),
    },
  });
  res.json({ statement: { ...row, formattedId: remindedFormattedId } });
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
    // Use the *persisted* row body — onConflictDoUpdate preserves the
    // existing body when the incoming body is empty, so syncing on the
    // request body would wipe the index even though canonical text still
    // contains tokens.
    await syncWitnessStatementMentions({
      schoolId,
      statementId: row.id,
      body: row.body ?? "",
    });
    const createdFormattedId = await formattedIdForStatement({
      schoolId,
      interactionId: id,
      wsSeq: row.wsSeq ?? null,
    });
    await audit({
      schoolId,
      entityType: "statement",
      entityId: row.id,
      action: body ? "completed" : "requested",
      staff,
      payload: {
        interactionId: id,
        studentId,
        ...(createdFormattedId ? { formattedId: createdFormattedId } : {}),
      },
    });
    if (interaction.caseId) {
      scheduleConsistencyRun({
        schoolId,
        caseId: interaction.caseId,
        triggerReason: "new_statement",
        actorStaffId: staff.id,
        actorName: staff.displayName,
      });
    }
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
  await syncWitnessStatementMentions({ schoolId, statementId: id, body });
  const editedFormattedId = await formattedIdForStatement({
    schoolId,
    interactionId: row.interactionId,
    wsSeq: row.wsSeq ?? null,
  });
  await audit({
    schoolId,
    entityType: "statement",
    entityId: id,
    action: "edited",
    staff,
    payload: {
      length: body.length,
      ...(editedFormattedId ? { formattedId: editedFormattedId } : {}),
    },
  });
  await maybeScheduleForStatement(schoolId, row.interactionId, "new_statement", staff);
  res.json({ statement: { ...row, formattedId: editedFormattedId } });
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
  await syncWitnessStatementMentions({ schoolId, statementId: id, body });
  const completedFormattedId = await formattedIdForStatement({
    schoolId,
    interactionId: row.interactionId,
    wsSeq: row.wsSeq ?? null,
  });
  await audit({
    schoolId,
    entityType: "statement",
    entityId: id,
    action: "completed",
    staff,
    payload: completedFormattedId ? { formattedId: completedFormattedId } : undefined,
  });
  await maybeScheduleForStatement(schoolId, row.interactionId, "new_statement", staff);
  res.json({ statement: { ...row, formattedId: completedFormattedId } });
});

// All structured @-mentions on every witness statement linked to this
// case. Admin-only (router-level core-team gate). Used by the case detail
// to render a "Students named in this case" chip row above the player
// pills, and later by Phase 3's consistency check to give the AI a clean
// list of named entities instead of having to re-parse prose.
router.get("/watchlist/cases/:id/mentions", async (req: Request, res: Response) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const id = asInt(req.params["id"]);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const rows = await db
    .select()
    .from(caseMentionsTable)
    .where(
      and(
        eq(caseMentionsTable.schoolId, schoolId),
        eq(caseMentionsTable.caseId, id),
      ),
    )
    .orderBy(asc(caseMentionsTable.createdAt));
  res.json({ mentions: rows });
});

// --- video evidence (Phase 2, admin-only) ----------------------------
//
// A per-case catalogue of camera footage relevant to an investigation.
// Access is restricted to the "Case Investigator" group: admin tier
// plus Behavior Specialist, MTSS Coordinator, and Dean — the people
// who actually run discipline investigations. The router-level gate
// also lets in School Psychologist and (via Core Team) other roles
// who run interventions; those should NOT see footage tooling, so we
// re-gate every handler here.

function adminGate(req: Request, res: Response): boolean {
  const staff = (req as ReqWithStaff).staff;
  if (!isCaseInvestigator(staff)) {
    res
      .status(403)
      .json({ error: "Admin, Behavior Specialist, MTSS, or Dean role required" });
    return false;
  }
  return true;
}

// Reject `javascript:` / `data:` and other unsafe URL schemes so that
// when the chip is rendered in the panel as `<a href={r.sourceUrl}>`
// a stored payload can't fire script on click. We allow http/https
// only — anything else (mailto, custom schemes) is rejected as well,
// because the field is purely "link to the camera system clip".
function normaliseSourceUrl(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null; // unparseable → drop silently
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  return parsed.toString();
}

router.get(
  "/watchlist/cases/:id/video-evidence",
  async (req: Request, res: Response) => {
    if (!adminGate(req, res)) return;
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const caseId = asInt(req.params["id"]);
    if (!caseId) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const rows = await db
      .select()
      .from(caseVideoEvidenceTable)
      .where(
        and(
          eq(caseVideoEvidenceTable.schoolId, schoolId),
          eq(caseVideoEvidenceTable.caseId, caseId),
        ),
      )
      .orderBy(asc(caseVideoEvidenceTable.timestampStart));
    // Embed player links per clip — single grouped read so the panel
    // can render the chip strip without an N+1 follow-up.
    const links = rows.length
      ? await db
          .select()
          .from(caseVideoEvidencePlayersTable)
          .where(
            and(
              eq(caseVideoEvidencePlayersTable.schoolId, schoolId),
              eq(caseVideoEvidencePlayersTable.caseId, caseId),
            ),
          )
      : [];
    const byClip = new Map<number, typeof links>();
    for (const l of links) {
      const arr = byClip.get(l.evidenceId) ?? [];
      arr.push(l);
      byClip.set(l.evidenceId, arr);
    }
    const evidence = rows.map((r) => ({
      ...r,
      players: byClip.get(r.id) ?? [],
    }));
    res.json({ evidence });
  },
);

// Per-case rollup feeding the camera badge on the WatchlistNetwork
// player spheres. Aggregates link rows into one entry per student so
// the client can paint badges in a single tiny call. `topTier` orders
// confirmed > inferred > possible — that's the "strongest evidence we
// have on this kid" signal, separate from the orthogonal `hasCleared`
// flag (which still wants to be visible even if there's no
// implication).
router.get(
  "/watchlist/cases/:id/player-clip-summary",
  async (req: Request, res: Response) => {
    if (!adminGate(req, res)) return;
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const caseId = asInt(req.params["id"]);
    if (!caseId) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const rows = (
      await db.execute(sql`
        SELECT student_id AS "studentId",
               COUNT(*)::int AS "count",
               CASE
                 WHEN BOOL_OR(confidence = 'confirmed') THEN 'confirmed'
                 WHEN BOOL_OR(confidence = 'inferred')  THEN 'inferred'
                 ELSE 'possible'
               END AS "topTier",
               BOOL_OR(cleared_by_footage) AS "hasCleared"
          FROM case_video_evidence_players
         WHERE school_id = ${schoolId}
           AND case_id   = ${caseId}
         GROUP BY student_id
      `)
    ).rows as Array<{
      studentId: string;
      count: number;
      topTier: VideoConfidenceTier;
      hasCleared: boolean;
    }>;
    // Total clip count on the case — separate from per-player links so
    // the case ring can show "footage exists" even before any players
    // are tagged. Otherwise a freshly-logged clip leaves no visible
    // trail on the network view until someone opens the case file.
    const totalClipsRow = (
      await db.execute(sql`
        SELECT COUNT(*)::int AS "count"
          FROM case_video_evidence
         WHERE school_id = ${schoolId}
           AND case_id   = ${caseId}
      `)
    ).rows as Array<{ count: number }>;
    const totalClips = totalClipsRow[0]?.count ?? 0;
    res.json({ summary: rows, totalClips });
  },
);

// Helper: load a clip row and verify it lives in this school.
// Returns null + sends a 404 when missing.
async function loadEvidenceForSchool(
  evidenceId: number,
  schoolId: number,
  res: Response,
) {
  const [row] = await db
    .select()
    .from(caseVideoEvidenceTable)
    .where(
      and(
        eq(caseVideoEvidenceTable.id, evidenceId),
        eq(caseVideoEvidenceTable.schoolId, schoolId),
      ),
    );
  if (!row) {
    res.status(404).json({ error: "Evidence not found" });
    return null;
  }
  return row;
}

function isConfidenceTier(v: unknown): v is VideoConfidenceTier {
  return typeof v === "string" &&
    (VIDEO_CONFIDENCE_TIERS as readonly string[]).includes(v);
}

// Link a player to a clip with a confidence tier. Default to "inferred"
// — the least committal middle. "Confirmed" requires a non-empty
// reason; the client pre-fills that with `Viewed by {staff name}` so
// the friction is "type more if it warrants it" rather than a hard
// stop. The (school_id, evidence_id, student_id) unique index means
// re-tagging the same student is a no-op upsert; we PATCH instead of
// throwing.
router.post(
  "/watchlist/video-evidence/:id/players",
  async (req: Request, res: Response) => {
    if (!adminGate(req, res)) return;
    const staff = (req as ReqWithStaff).staff;
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const evidenceId = asInt(req.params["id"]);
    if (!evidenceId) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const evidence = await loadEvidenceForSchool(evidenceId, schoolId, res);
    if (!evidence) return;
    const b = req.body as Record<string, unknown>;
    const studentId = clean(b["studentId"], 64);
    const confidence = isConfidenceTier(b["confidence"])
      ? b["confidence"]
      : "inferred";
    const clearedByFootage = Boolean(b["clearedByFootage"]);
    const reason = clean(b["reason"], 4000) || null;
    if (!studentId) {
      res.status(400).json({ error: "studentId required" });
      return;
    }
    if (confidence === "confirmed" && !reason) {
      res.status(400).json({
        error:
          "A reason is required when marking a clip as Confirmed.",
      });
      return;
    }
    // Confirm the student is actually a player on this case — guards
    // against tagging an unrelated student via a forged studentId.
    const [participant] = await db
      .select({ studentId: interactionParticipantsTable.studentId })
      .from(interactionParticipantsTable)
      .innerJoin(
        interactionsTable,
        eq(interactionParticipantsTable.interactionId, interactionsTable.id),
      )
      .where(
        and(
          eq(interactionParticipantsTable.schoolId, schoolId),
          eq(interactionParticipantsTable.studentId, studentId),
          eq(interactionsTable.caseId, evidence.caseId),
        ),
      )
      .limit(1);
    if (!participant) {
      res.status(400).json({
        error: "studentId is not a player on this case",
      });
      return;
    }
    // Upsert on the (school, evidence, student) triple.
    const [row] = await db
      .insert(caseVideoEvidencePlayersTable)
      .values({
        schoolId,
        evidenceId,
        caseId: evidence.caseId,
        studentId,
        confidence,
        clearedByFootage,
        reason,
        setByStaffId: staff.id,
        setByName: staff.displayName,
      })
      .onConflictDoUpdate({
        target: [
          caseVideoEvidencePlayersTable.schoolId,
          caseVideoEvidencePlayersTable.evidenceId,
          caseVideoEvidencePlayersTable.studentId,
        ],
        set: {
          confidence,
          clearedByFootage,
          reason,
          setByStaffId: staff.id,
          setByName: staff.displayName,
          updatedAt: new Date(),
        },
      })
      .returning();
    await audit({
      schoolId,
      entityType: "video_evidence_player",
      entityId: row.id,
      action: "linked",
      staff,
      payload: {
        caseId: evidence.caseId,
        evidenceId,
        studentId,
        confidence,
        clearedByFootage,
      },
    });
    // Confirmed-tier links are the ground-truth anchor — they can flip
    // existing statements from "uncontradicted" to "contradicts video".
    // Inferred/possible links don't change the truth ranking, so we
    // skip the AI re-run for them to keep token spend down.
    if (confidence === "confirmed") {
      scheduleConsistencyRun({
        schoolId,
        caseId: evidence.caseId,
        triggerReason: "new_video",
        actorStaffId: staff.id,
        actorName: staff.displayName,
      });
    }
    res.json({ link: row });
  },
);

router.patch(
  "/watchlist/video-evidence/players/:linkId",
  async (req: Request, res: Response) => {
    if (!adminGate(req, res)) return;
    const staff = (req as ReqWithStaff).staff;
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const linkId = asInt(req.params["linkId"]);
    if (!linkId) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const b = req.body as Record<string, unknown>;
    // Race-safe load-merge-validate-update: hold a row lock on the
    // link from SELECT through UPDATE so a concurrent PATCH cannot
    // change one half of the (confidence, reason) invariant after we
    // read it. Without the lock, two interleaved patches can persist
    // a `confirmed` row with `reason = null`.
    const txResult = await db.transaction(async (tx) => {
      const locked = await tx.execute(sql`
        SELECT id, school_id, case_id, evidence_id, student_id,
               confidence, cleared_by_footage, reason
          FROM case_video_evidence_players
         WHERE id = ${linkId} AND school_id = ${schoolId}
         FOR UPDATE
      `);
      const lockedRow = (locked.rows ?? [])[0] as
        | {
            confidence: string;
            cleared_by_footage: boolean;
            reason: string | null;
          }
        | undefined;
      if (!lockedRow) return { kind: "notfound" as const };

      const patch: Partial<typeof caseVideoEvidencePlayersTable.$inferInsert> = {
        updatedAt: new Date(),
        setByStaffId: staff.id,
        setByName: staff.displayName,
      };
      let mergedConfidence: VideoConfidenceTier =
        lockedRow.confidence as VideoConfidenceTier;
      let mergedReason: string | null = lockedRow.reason;
      if (b["confidence"] !== undefined) {
        if (!isConfidenceTier(b["confidence"])) {
          return { kind: "badreq" as const, error: "invalid confidence tier" };
        }
        patch.confidence = b["confidence"];
        mergedConfidence = b["confidence"];
      }
      if (b["clearedByFootage"] !== undefined) {
        patch.clearedByFootage = Boolean(b["clearedByFootage"]);
      }
      if (b["reason"] !== undefined) {
        const v =
          typeof b["reason"] === "string"
            ? clean(b["reason"], 4000) || null
            : null;
        patch.reason = v;
        mergedReason = v;
      }
      if (mergedConfidence === "confirmed" && !mergedReason) {
        return {
          kind: "badreq" as const,
          error: "A reason is required when marking a clip as Confirmed.",
        };
      }
      const [updated] = await tx
        .update(caseVideoEvidencePlayersTable)
        .set(patch)
        .where(
          and(
            eq(caseVideoEvidencePlayersTable.id, linkId),
            eq(caseVideoEvidencePlayersTable.schoolId, schoolId),
          ),
        )
        .returning();
      return {
        kind: "ok" as const,
        before: {
          confidence: lockedRow.confidence,
          clearedByFootage: lockedRow.cleared_by_footage,
          reason: lockedRow.reason,
        },
        row: updated,
      };
    });
    if (txResult.kind === "notfound") {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (txResult.kind === "badreq") {
      res.status(400).json({ error: txResult.error });
      return;
    }
    const row = txResult.row;
    await audit({
      schoolId,
      entityType: "video_evidence_player",
      entityId: linkId,
      action: "updated",
      staff,
      payload: {
        caseId: row.caseId,
        evidenceId: row.evidenceId,
        before: txResult.before,
        after: {
          confidence: row.confidence,
          clearedByFootage: row.clearedByFootage,
          reason: row.reason,
        },
      },
    });
    res.json({ link: row });
  },
);

router.delete(
  "/watchlist/video-evidence/players/:linkId",
  async (req: Request, res: Response) => {
    if (!adminGate(req, res)) return;
    const staff = (req as ReqWithStaff).staff;
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const linkId = asInt(req.params["linkId"]);
    if (!linkId) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [row] = await db
      .delete(caseVideoEvidencePlayersTable)
      .where(
        and(
          eq(caseVideoEvidencePlayersTable.id, linkId),
          eq(caseVideoEvidencePlayersTable.schoolId, schoolId),
        ),
      )
      .returning();
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    await audit({
      schoolId,
      entityType: "video_evidence_player",
      entityId: linkId,
      action: "unlinked",
      staff,
      payload: {
        caseId: row.caseId,
        evidenceId: row.evidenceId,
        studentId: row.studentId,
      },
    });
    res.json({ ok: true });
  },
);

router.post(
  "/watchlist/cases/:id/video-evidence",
  async (req: Request, res: Response) => {
    if (!adminGate(req, res)) return;
    const staff = (req as ReqWithStaff).staff;
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const caseId = asInt(req.params["id"]);
    if (!caseId) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    // Confirm the case actually exists in this school — defends against
    // a forged caseId from a multi-tenant escalation attempt.
    const [c] = await db
      .select({ id: interactionCasesTable.id })
      .from(interactionCasesTable)
      .where(
        and(
          eq(interactionCasesTable.id, caseId),
          eq(interactionCasesTable.schoolId, schoolId),
        ),
      );
    if (!c) {
      res.status(404).json({ error: "Case not found" });
      return;
    }
    const b = req.body as Record<string, unknown>;
    const cameraLabel = clean(b["cameraLabel"], 200);
    const startRaw =
      typeof b["timestampStart"] === "string"
        ? (b["timestampStart"] as string)
        : "";
    const endRaw =
      typeof b["timestampEnd"] === "string"
        ? (b["timestampEnd"] as string)
        : "";
    const sourceUrlRaw = clean(b["sourceUrl"], 1000) || null;
    if (sourceUrlRaw && !normaliseSourceUrl(sourceUrlRaw)) {
      res.status(400).json({
        error: "sourceUrl must be a valid http(s) URL",
      });
      return;
    }
    const sourceUrl = normaliseSourceUrl(sourceUrlRaw);
    const notes = clean(b["notes"], 4000) || null;
    if (!cameraLabel) {
      res.status(400).json({ error: "cameraLabel required" });
      return;
    }
    const start = startRaw ? new Date(startRaw) : null;
    const end = endRaw ? new Date(endRaw) : null;
    if (!start || Number.isNaN(start.getTime())) {
      res.status(400).json({ error: "timestampStart required (ISO8601)" });
      return;
    }
    if (end && Number.isNaN(end.getTime())) {
      res.status(400).json({ error: "timestampEnd is invalid" });
      return;
    }
    if (end && end.getTime() < start.getTime()) {
      res.status(400).json({ error: "timestampEnd must be after start" });
      return;
    }
    const [row] = await db
      .insert(caseVideoEvidenceTable)
      .values({
        schoolId,
        caseId,
        cameraLabel,
        timestampStart: start,
        timestampEnd: end,
        sourceUrl,
        notes,
        loggedByStaffId: staff.id,
        loggedByName: staff.displayName,
      })
      .returning();
    await audit({
      schoolId,
      entityType: "video_evidence",
      entityId: row.id,
      action: "created",
      staff,
      payload: { caseId, cameraLabel },
    });
    scheduleConsistencyRun({
      schoolId,
      caseId,
      triggerReason: "new_video",
      actorStaffId: staff.id,
      actorName: staff.displayName,
    });
    res.json({ evidence: row });
  },
);

router.patch(
  "/watchlist/video-evidence/:id",
  async (req: Request, res: Response) => {
    if (!adminGate(req, res)) return;
    const staff = (req as ReqWithStaff).staff;
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const id = asInt(req.params["id"]);
    if (!id) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const b = req.body as Record<string, unknown>;
    // Load the existing row first so cross-field validation (end >=
    // start) runs on the *merged* shape BEFORE we persist anything.
    // Validating post-update was a data-integrity bug — an invalid
    // edit would 400 to the client but still be saved.
    const [existing] = await db
      .select()
      .from(caseVideoEvidenceTable)
      .where(
        and(
          eq(caseVideoEvidenceTable.id, id),
          eq(caseVideoEvidenceTable.schoolId, schoolId),
        ),
      );
    if (!existing) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const patch: Partial<typeof caseVideoEvidenceTable.$inferInsert> = {
      updatedAt: new Date(),
    };
    let mergedStart = existing.timestampStart;
    let mergedEnd: Date | null = existing.timestampEnd;
    if (typeof b["cameraLabel"] === "string") {
      const v = clean(b["cameraLabel"], 200);
      if (!v) {
        res.status(400).json({ error: "cameraLabel cannot be empty" });
        return;
      }
      patch.cameraLabel = v;
    }
    if (typeof b["sourceUrl"] === "string") {
      const raw = clean(b["sourceUrl"], 1000) || null;
      if (raw && !normaliseSourceUrl(raw)) {
        res.status(400).json({
          error: "sourceUrl must be a valid http(s) URL",
        });
        return;
      }
      patch.sourceUrl = normaliseSourceUrl(raw);
    }
    if (typeof b["notes"] === "string") {
      patch.notes = clean(b["notes"], 4000) || null;
    }
    if (typeof b["timestampStart"] === "string" && b["timestampStart"]) {
      const d = new Date(b["timestampStart"] as string);
      if (Number.isNaN(d.getTime())) {
        res.status(400).json({ error: "timestampStart is invalid" });
        return;
      }
      patch.timestampStart = d;
      mergedStart = d;
    }
    if (b["timestampEnd"] !== undefined) {
      const v = b["timestampEnd"];
      if (v === null || v === "") {
        patch.timestampEnd = null;
        mergedEnd = null;
      } else if (typeof v === "string") {
        const d = new Date(v);
        if (Number.isNaN(d.getTime())) {
          res.status(400).json({ error: "timestampEnd is invalid" });
          return;
        }
        patch.timestampEnd = d;
        mergedEnd = d;
      }
    }
    if (mergedEnd && mergedEnd.getTime() < mergedStart.getTime()) {
      res.status(400).json({ error: "timestampEnd must be after start" });
      return;
    }
    const [row] = await db
      .update(caseVideoEvidenceTable)
      .set(patch)
      .where(
        and(
          eq(caseVideoEvidenceTable.id, id),
          eq(caseVideoEvidenceTable.schoolId, schoolId),
        ),
      )
      .returning();
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    await audit({
      schoolId,
      entityType: "video_evidence",
      entityId: id,
      action: "updated",
      staff,
      payload: { caseId: row.caseId, ...patch, updatedAt: undefined },
    });
    res.json({ evidence: row });
  },
);

router.delete(
  "/watchlist/video-evidence/:id",
  async (req: Request, res: Response) => {
    if (!adminGate(req, res)) return;
    const staff = (req as ReqWithStaff).staff;
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const id = asInt(req.params["id"]);
    if (!id) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    // Cascade delete: remove player links first so the clip going
    // away never leaves orphan rows that would surface as phantom
    // camera badges in /player-clip-summary. Wrapped in a tx so the
    // two deletes commit together.
    const result = await db.transaction(async (tx) => {
      const removedLinks = await tx
        .delete(caseVideoEvidencePlayersTable)
        .where(
          and(
            eq(caseVideoEvidencePlayersTable.schoolId, schoolId),
            eq(caseVideoEvidencePlayersTable.evidenceId, id),
          ),
        )
        .returning();
      const [row] = await tx
        .delete(caseVideoEvidenceTable)
        .where(
          and(
            eq(caseVideoEvidenceTable.id, id),
            eq(caseVideoEvidenceTable.schoolId, schoolId),
          ),
        )
        .returning();
      return { row, removedLinkCount: removedLinks.length };
    });
    if (!result.row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    await audit({
      schoolId,
      entityType: "video_evidence",
      entityId: id,
      action: "deleted",
      staff,
      payload: {
        caseId: result.row.caseId,
        cameraLabel: result.row.cameraLabel,
        removedPlayerLinks: result.removedLinkCount,
      },
    });
    res.json({ ok: true });
  },
);

// Distinct camera labels previously used in this school, used by the
// client typeahead so admins reuse consistent names ("Cafeteria North"
// vs. "cafeteria-N" vs. "Caf North"). Capped to keep the payload light.
router.get(
  "/watchlist/camera-labels",
  async (req: Request, res: Response) => {
    if (!adminGate(req, res)) return;
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const rows = (
      await db.execute(sql`
        SELECT DISTINCT camera_label AS "cameraLabel"
          FROM case_video_evidence
         WHERE school_id = ${schoolId}
         ORDER BY camera_label ASC
         LIMIT 200
      `)
    ).rows as Array<{ cameraLabel: string }>;
    res.json({ labels: rows.map((r) => r.cameraLabel) });
  },
);

// ─────────────────────────────────────────────────────────────
// Footage Requests — internal record of "we know we need this
// video, we asked for it." No outbound integration; investigators
// request video out-of-band (Microsoft Teams DM to the admin who
// owns the camera system, walkie to the bus garage). The row
// exists so a stale case immediately surfaces what's still
// outstanding.
//
// Same audience as the rest of VideoEvidencePanel — gated through
// adminGate (admin tier + Behavior Specialist + MTSS + Dean).
// ─────────────────────────────────────────────────────────────

const FOOTAGE_REQUEST_SOURCES = [
  "bus",
  "hallway_camera",
  "classroom_camera",
  "cafeteria_camera",
  "exterior_camera",
  "external",
  "other",
] as const;
type FootageRequestSource = (typeof FOOTAGE_REQUEST_SOURCES)[number];

const FOOTAGE_REQUEST_STATUSES = [
  "requested",
  "received",
  "unavailable",
  "cancelled",
] as const;
type FootageRequestStatus = (typeof FOOTAGE_REQUEST_STATUSES)[number];

// Verify the caller's school owns this case. Returns true on success,
// otherwise sends 404 and returns false. Mirrors the same defensive
// check used by the video evidence routes — defends against a forged
// caseId from another tenant.
async function assertCaseInSchool(
  caseId: number,
  schoolId: number,
  res: Response,
): Promise<boolean> {
  const [c] = await db
    .select({ id: interactionCasesTable.id })
    .from(interactionCasesTable)
    .where(
      and(
        eq(interactionCasesTable.id, caseId),
        eq(interactionCasesTable.schoolId, schoolId),
      ),
    );
  if (!c) {
    res.status(404).json({ error: "Case not found" });
    return false;
  }
  return true;
}

router.get(
  "/watchlist/cases/:id/footage-requests",
  async (req: Request, res: Response) => {
    if (!adminGate(req, res)) return;
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const caseId = asInt(req.params["id"]);
    if (!caseId) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    if (!(await assertCaseInSchool(caseId, schoolId, res))) return;
    // Open requests first (requested), then resolved by most recent
    // requestedAt — investigators want "what's still outstanding"
    // at a glance.
    const rows = await db
      .select()
      .from(caseFootageRequestsTable)
      .where(
        and(
          eq(caseFootageRequestsTable.schoolId, schoolId),
          eq(caseFootageRequestsTable.caseId, caseId),
        ),
      )
      .orderBy(
        sql`CASE WHEN status = 'requested' THEN 0 ELSE 1 END`,
        desc(caseFootageRequestsTable.requestedAt),
      );
    res.json({ requests: rows });
  },
);

router.post(
  "/watchlist/cases/:id/footage-requests",
  async (req: Request, res: Response) => {
    if (!adminGate(req, res)) return;
    const staff = (req as ReqWithStaff).staff;
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const caseId = asInt(req.params["id"]);
    if (!caseId) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    if (!(await assertCaseInSchool(caseId, schoolId, res))) return;
    const b = req.body as Record<string, unknown>;
    const source = clean(b["source"], 40) as FootageRequestSource;
    if (!FOOTAGE_REQUEST_SOURCES.includes(source)) {
      res.status(400).json({ error: "Invalid source" });
      return;
    }
    const reason = clean(b["reason"], 2000);
    if (reason.length < 3) {
      res.status(400).json({ error: "Reason is required" });
      return;
    }
    const locationText = clean(b["locationText"], 200) || null;
    const startRaw =
      typeof b["windowStart"] === "string" ? (b["windowStart"] as string) : "";
    const endRaw =
      typeof b["windowEnd"] === "string" ? (b["windowEnd"] as string) : "";
    const start = startRaw ? new Date(startRaw) : null;
    if (!start || Number.isNaN(start.getTime())) {
      res.status(400).json({ error: "windowStart is required" });
      return;
    }
    const end = endRaw ? new Date(endRaw) : null;
    if (end && Number.isNaN(end.getTime())) {
      res.status(400).json({ error: "Invalid windowEnd" });
      return;
    }
    if (end && end.getTime() < start.getTime()) {
      res.status(400).json({ error: "windowEnd must be after windowStart" });
      return;
    }
    const [row] = await db
      .insert(caseFootageRequestsTable)
      .values({
        schoolId,
        caseId,
        source,
        locationText,
        windowStart: start,
        windowEnd: end,
        reason,
        status: "requested",
        requestedByStaffId: staff?.id ?? null,
        requestedByName: staff?.displayName ?? null,
      })
      .returning();
    await audit({
      schoolId,
      entityType: "footage_request",
      entityId: row.id,
      action: "created",
      staff,
      payload: {
        caseId,
        source,
        locationText: row.locationText,
        windowStart: row.windowStart,
        windowEnd: row.windowEnd,
      },
    });
    res.json({ request: row });
  },
);

router.patch(
  "/watchlist/footage-requests/:reqId",
  async (req: Request, res: Response) => {
    if (!adminGate(req, res)) return;
    const staff = (req as ReqWithStaff).staff;
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const reqId = asInt(req.params["reqId"]);
    if (!reqId) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const b = req.body as Record<string, unknown>;
    const [existing] = await db
      .select()
      .from(caseFootageRequestsTable)
      .where(
        and(
          eq(caseFootageRequestsTable.id, reqId),
          eq(caseFootageRequestsTable.schoolId, schoolId),
        ),
      );
    if (!existing) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const patch: Partial<typeof caseFootageRequestsTable.$inferInsert> = {
      updatedAt: new Date(),
    };
    let statusChanged = false;
    let nextStatus: FootageRequestStatus = existing.status as FootageRequestStatus;
    if (b["status"] !== undefined) {
      const next = clean(b["status"], 40) as FootageRequestStatus;
      if (!FOOTAGE_REQUEST_STATUSES.includes(next)) {
        res.status(400).json({ error: "Invalid status" });
        return;
      }
      nextStatus = next;
      if (next !== existing.status) {
        patch.status = next;
        statusChanged = true;
        if (next === "requested") {
          // Re-opening: clear all fulfillment metadata so the row
          // reflects "outstanding again" cleanly. Includes the linked
          // clip — if there's still a clip it should be re-linked
          // explicitly when the request is re-resolved.
          patch.fulfilledAt = null;
          patch.fulfilledByStaffId = null;
          patch.fulfilledByName = null;
          patch.fulfillmentNote = null;
          patch.linkedClipId = null;
        } else {
          patch.fulfilledAt = new Date();
          patch.fulfilledByStaffId = staff?.id ?? null;
          patch.fulfilledByName = staff?.displayName ?? null;
          // Cancelled / unavailable means there's no clip to link;
          // strip any stale clip reference. `received` keeps whatever
          // the body provides (or whatever was already linked).
          if (next === "cancelled" || next === "unavailable") {
            patch.linkedClipId = null;
          }
        }
      }
    }
    if (b["fulfillmentNote"] !== undefined) {
      patch.fulfillmentNote = clean(b["fulfillmentNote"], 2000) || null;
    }
    if (b["linkedClipId"] !== undefined) {
      const raw = b["linkedClipId"];
      // Only allow setting a linked clip when the resolved status is
      // `received` — a clip on a cancelled or unavailable request is
      // a logical contradiction.
      if (raw == null) {
        patch.linkedClipId = null;
      } else {
        if (typeof raw !== "number" || !Number.isInteger(raw)) {
          res.status(400).json({ error: "linkedClipId must be an integer" });
          return;
        }
        if (nextStatus !== "received") {
          res.status(400).json({
            error: "linkedClipId is only valid when status is 'received'",
          });
          return;
        }
        const [clip] = await db
          .select({ id: caseVideoEvidenceTable.id })
          .from(caseVideoEvidenceTable)
          .where(
            and(
              eq(caseVideoEvidenceTable.id, raw),
              eq(caseVideoEvidenceTable.schoolId, schoolId),
              eq(caseVideoEvidenceTable.caseId, existing.caseId),
            ),
          );
        if (!clip) {
          res
            .status(400)
            .json({ error: "linkedClipId does not match a clip on this case" });
          return;
        }
        patch.linkedClipId = clip.id;
      }
    }
    if (b["reason"] !== undefined) {
      const trimmed = clean(b["reason"], 2000);
      if (trimmed.length < 3) {
        res.status(400).json({ error: "Reason is required" });
        return;
      }
      patch.reason = trimmed;
    }
    if (b["locationText"] !== undefined) {
      patch.locationText = clean(b["locationText"], 200) || null;
    }
    if (b["source"] !== undefined) {
      const src = clean(b["source"], 40) as FootageRequestSource;
      if (!FOOTAGE_REQUEST_SOURCES.includes(src)) {
        res.status(400).json({ error: "Invalid source" });
        return;
      }
      patch.source = src;
    }
    const [row] = await db
      .update(caseFootageRequestsTable)
      .set(patch)
      .where(
        and(
          eq(caseFootageRequestsTable.id, reqId),
          eq(caseFootageRequestsTable.schoolId, schoolId),
        ),
      )
      .returning();
    await audit({
      schoolId,
      entityType: "footage_request",
      entityId: reqId,
      action: statusChanged ? `status:${row.status}` : "updated",
      staff,
      payload: {
        caseId: row.caseId,
        before: {
          status: existing.status,
          source: existing.source,
          locationText: existing.locationText,
          reason: existing.reason,
          linkedClipId: existing.linkedClipId,
          fulfillmentNote: existing.fulfillmentNote,
        },
        after: {
          status: row.status,
          source: row.source,
          locationText: row.locationText,
          reason: row.reason,
          linkedClipId: row.linkedClipId,
          fulfillmentNote: row.fulfillmentNote,
        },
      },
    });
    res.json({ request: row });
  },
);

router.delete(
  "/watchlist/footage-requests/:reqId",
  async (req: Request, res: Response) => {
    if (!adminGate(req, res)) return;
    const staff = (req as ReqWithStaff).staff;
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const reqId = asInt(req.params["reqId"]);
    if (!reqId) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [row] = await db
      .delete(caseFootageRequestsTable)
      .where(
        and(
          eq(caseFootageRequestsTable.id, reqId),
          eq(caseFootageRequestsTable.schoolId, schoolId),
        ),
      )
      .returning();
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    await audit({
      schoolId,
      entityType: "footage_request",
      entityId: reqId,
      action: "deleted",
      staff,
      payload: { caseId: row.caseId, status: row.status, reason: row.reason },
    });
    res.json({ ok: true });
  },
);

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

// =====================================================================
// Camera Registry — per-school named cameras for the footage dropdown.
// Replaces the old free-text camera_label workflow where admins typed
// "Cafeteria North camera" 200 times a year. Soft-deletes preserve
// historical evidence rows (which still reference the camera by name
// as text) while removing the camera from the dropdown going forward.
// All routes are admin-gated (Case Investigator group); other roles
// don't see the dropdown surface at all.
// =====================================================================

router.get(
  "/watchlist/cameras",
  async (req: Request, res: Response) => {
    if (!adminGate(req, res)) return;
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const includeInactive = req.query["includeInactive"] === "1";
    const where = includeInactive
      ? eq(cameraRegistryTable.schoolId, schoolId)
      : and(
          eq(cameraRegistryTable.schoolId, schoolId),
          eq(cameraRegistryTable.active, true),
        );
    const rows = await db
      .select()
      .from(cameraRegistryTable)
      .where(where)
      .orderBy(
        // Active first (so the dropdown UX stays clean even when the
        // settings page asks for inactives), then alphabetical name.
        desc(cameraRegistryTable.active),
        asc(cameraRegistryTable.name),
      );
    res.json({ cameras: rows });
  },
);

// Camera registry mutations are tighter than the rest of the case
// surface — only true admins (Admin / SuperUser / DistrictAdmin) can
// add/rename/remove cameras, matching the Settings tile gate
// (canManageSettings). Other case investigators can READ the registry
// for the picker dropdown but can't edit it. This prevents drift in
// the camera list (a Dean accidentally renaming "Cafeteria North" to
// "cafeteria n" would invalidate the standardization goal).
function cameraWriteGate(req: Request, res: Response): boolean {
  const staff = (req as ReqWithStaff).staff;
  if (!isAdminOrSuperUser(staff)) {
    res.status(403).json({ error: "Admin role required" });
    return false;
  }
  return true;
}

router.post(
  "/watchlist/cameras",
  async (req: Request, res: Response) => {
    if (!cameraWriteGate(req, res)) return;
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const staff = (req as ReqWithStaff).staff;
    const b = req.body as Record<string, unknown>;
    const name = clean(b["name"], 200);
    const location = clean(b["location"], 200) || null;
    if (!name) {
      res.status(400).json({ error: "name required" });
      return;
    }
    // Case-insensitive duplicate check. Schema-level uniqueness on
    // (school_id, name) is exact-match only; we explicitly want
    // "Cafeteria North" and "cafeteria north" to collide, so we
    // check by lower(name) before insert.
    const [dupe] = await db
      .select({ id: cameraRegistryTable.id })
      .from(cameraRegistryTable)
      .where(
        and(
          eq(cameraRegistryTable.schoolId, schoolId),
          sql`lower(${cameraRegistryTable.name}) = lower(${name})`,
        ),
      )
      .limit(1);
    if (dupe) {
      res.status(409).json({ error: "A camera with that name already exists" });
      return;
    }
    try {
      const [row] = await db
        .insert(cameraRegistryTable)
        .values({ schoolId, name, location })
        .returning();
      await audit({
        schoolId,
        entityType: "camera_registry",
        entityId: row.id,
        action: "created",
        staff,
        payload: { name, location },
      });
      res.json({ camera: row });
    } catch (e) {
      // 23505 = unique_violation on (school_id, lower(name)). Surface a
      // friendly message instead of leaking pg internals.
      if ((e as { code?: string }).code === "23505") {
        res.status(409).json({ error: "A camera with that name already exists" });
        return;
      }
      throw e;
    }
  },
);

router.patch(
  "/watchlist/cameras/:id",
  async (req: Request, res: Response) => {
    if (!cameraWriteGate(req, res)) return;
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const staff = (req as ReqWithStaff).staff;
    const id = asInt(req.params["id"]);
    if (!id) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    // Snapshot the row BEFORE mutating so the audit log captures
    // a true before/after pair (the architect review flagged this).
    // School-scoped lookup so a cross-tenant id can't even leak the
    // existence of another school's row.
    const [before] = await db
      .select()
      .from(cameraRegistryTable)
      .where(
        and(
          eq(cameraRegistryTable.id, id),
          eq(cameraRegistryTable.schoolId, schoolId),
        ),
      );
    if (!before) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const b = req.body as Record<string, unknown>;
    const patch: Partial<typeof cameraRegistryTable.$inferInsert> = {};
    if (typeof b["name"] === "string") {
      const v = clean(b["name"], 200);
      if (!v) {
        res.status(400).json({ error: "name cannot be empty" });
        return;
      }
      // Case-insensitive collision guard against OTHER cameras in
      // the school. Renaming a camera to its own current name (or
      // a different case of it) is allowed.
      if (v.toLowerCase() !== before.name.toLowerCase()) {
        const [dupe] = await db
          .select({ id: cameraRegistryTable.id })
          .from(cameraRegistryTable)
          .where(
            and(
              eq(cameraRegistryTable.schoolId, schoolId),
              sql`lower(${cameraRegistryTable.name}) = lower(${v})`,
            ),
          )
          .limit(1);
        if (dupe) {
          res
            .status(409)
            .json({ error: "A camera with that name already exists" });
          return;
        }
      }
      patch.name = v;
    }
    if (typeof b["location"] === "string") {
      patch.location = clean(b["location"], 200) || null;
    }
    if (typeof b["active"] === "boolean") {
      patch.active = b["active"] as boolean;
    }
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: "no changes" });
      return;
    }
    patch.updatedAt = new Date();
    try {
      const [row] = await db
        .update(cameraRegistryTable)
        .set(patch)
        .where(
          and(
            eq(cameraRegistryTable.id, id),
            eq(cameraRegistryTable.schoolId, schoolId),
          ),
        )
        .returning();
      if (!row) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      await audit({
        schoolId,
        entityType: "camera_registry",
        entityId: id,
        action: "updated",
        staff,
        payload: {
          before: {
            name: before.name,
            location: before.location,
            active: before.active,
          },
          after: {
            name: row.name,
            location: row.location,
            active: row.active,
          },
          changedFields: Object.keys(patch).filter((k) => k !== "updatedAt"),
        },
      });
      res.json({ camera: row });
    } catch (e) {
      if ((e as { code?: string }).code === "23505") {
        res.status(409).json({ error: "A camera with that name already exists" });
        return;
      }
      throw e;
    }
  },
);

// Soft delete. We never hard-delete because past video_evidence rows
// store the name as text and an admin reading an old case file should
// still see what was logged. A future "purge unused" job can hard-
// delete inactive rows that have zero evidence references.
router.delete(
  "/watchlist/cameras/:id",
  async (req: Request, res: Response) => {
    if (!cameraWriteGate(req, res)) return;
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const staff = (req as ReqWithStaff).staff;
    const id = asInt(req.params["id"]);
    if (!id) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [row] = await db
      .update(cameraRegistryTable)
      .set({ active: false, updatedAt: new Date() })
      .where(
        and(
          eq(cameraRegistryTable.id, id),
          eq(cameraRegistryTable.schoolId, schoolId),
        ),
      )
      .returning();
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    // Capture the camera identity at delete time so the audit log is
    // self-contained — if the row is later restored and renamed, the
    // forensic trail still shows what was removed and when.
    await audit({
      schoolId,
      entityType: "camera_registry",
      entityId: id,
      action: "soft_deleted",
      staff,
      payload: {
        name: row.name,
        location: row.location,
      },
    });
    res.json({ ok: true });
  },
);

// =====================================================================
// AI Consistency Check (Phase 3) — admin / Core-Team-only.
//
// All five endpoints are gated by `adminGate` (Case Investigator tier:
// admin / Behavior Specialist / MTSS / Dean). Findings are NEVER
// surfaced to teachers, parents, students, signage, or PDF exports —
// the routes here are the only read surface, and the `requireCoreTeamMW`
// + `adminGate` combo enforces that at the perimeter.
//
// The runner does its own DB-level debounce, but the manual /run
// endpoint also enforces a per-case daily cap (20 runs/24h) so an
// over-eager admin can't spend down the AI budget. Cap is read off
// the runs table — counting createdAt within now-24h.
// =====================================================================

const MANUAL_RUN_DAILY_CAP = 20;

// Confirm the case actually lives in this school. Returns false +
// sends 4xx if not. We re-check on every consistency endpoint because
// a forged caseId in the URL would otherwise leak existence (and
// later, score) of cases in another tenant.
async function loadCaseForConsistency(
  caseId: number,
  schoolId: number,
  res: Response,
): Promise<boolean> {
  const [c] = await db
    .select({ id: interactionCasesTable.id })
    .from(interactionCasesTable)
    .where(
      and(
        eq(interactionCasesTable.id, caseId),
        eq(interactionCasesTable.schoolId, schoolId),
      ),
    )
    .limit(1);
  if (!c) {
    res.status(404).json({ error: "Case not found" });
    return false;
  }
  return true;
}

// Read the per-case state row + open findings. Pill is a single read
// against case_consistency_state; findings are limited to status='open'
// + most-recent-run for the panel default tab.
router.get(
  "/watchlist/cases/:id/consistency",
  async (req: Request, res: Response) => {
    if (!adminGate(req, res)) return;
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const caseId = asInt(req.params["id"]);
    if (!caseId) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    if (!(await loadCaseForConsistency(caseId, schoolId, res))) return;

    const [state] = await db
      .select()
      .from(caseConsistencyStateTable)
      .where(
        and(
          eq(caseConsistencyStateTable.schoolId, schoolId),
          eq(caseConsistencyStateTable.caseId, caseId),
        ),
      )
      .limit(1);

    const findings = await db
      .select()
      .from(caseConsistencyFindingsTable)
      .where(
        and(
          eq(caseConsistencyFindingsTable.schoolId, schoolId),
          eq(caseConsistencyFindingsTable.caseId, caseId),
          eq(caseConsistencyFindingsTable.status, "open"),
        ),
      )
      .orderBy(desc(caseConsistencyFindingsTable.createdAt));

    // Cheap headline of the latest run so the panel can render
    // "Ran 12m ago by Jane Doe" without a follow-up roundtrip.
    const [latestRun] = state?.latestRunId
      ? await db
          .select({
            id: caseConsistencyRunsTable.id,
            createdAt: caseConsistencyRunsTable.createdAt,
            triggeredByName: caseConsistencyRunsTable.triggeredByName,
            triggerReason: caseConsistencyRunsTable.triggerReason,
            model: caseConsistencyRunsTable.model,
            errorText: caseConsistencyRunsTable.errorText,
            inputTokens: caseConsistencyRunsTable.inputTokens,
            outputTokens: caseConsistencyRunsTable.outputTokens,
          })
          .from(caseConsistencyRunsTable)
          .where(
            and(
              eq(caseConsistencyRunsTable.schoolId, schoolId),
              eq(caseConsistencyRunsTable.id, state.latestRunId),
            ),
          )
          .limit(1)
      : [];

    res.json({
      state: state ?? null,
      latestRun: latestRun ?? null,
      findings,
    });
  },
);

// Full run detail incl. redacted bundle + raw model output. Powers the
// "What the AI saw" drawer. The bundle is already redacted at write
// time, but we never join in unredacted student rows on the way out.
router.get(
  "/watchlist/cases/:id/consistency/runs/:runId",
  async (req: Request, res: Response) => {
    if (!adminGate(req, res)) return;
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const caseId = asInt(req.params["id"]);
    const runId = asInt(req.params["runId"]);
    if (!caseId || !runId) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    if (!(await loadCaseForConsistency(caseId, schoolId, res))) return;
    const [run] = await db
      .select()
      .from(caseConsistencyRunsTable)
      .where(
        and(
          eq(caseConsistencyRunsTable.schoolId, schoolId),
          eq(caseConsistencyRunsTable.caseId, caseId),
          eq(caseConsistencyRunsTable.id, runId),
        ),
      )
      .limit(1);
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
    const findings = await db
      .select()
      .from(caseConsistencyFindingsTable)
      .where(
        and(
          eq(caseConsistencyFindingsTable.schoolId, schoolId),
          eq(caseConsistencyFindingsTable.runId, runId),
        ),
      );
    res.json({ run, findings });
  },
);

// Manual re-run. Per-case daily cap (20/24h) checked off the runs
// table. Manual triggers bypass the 60s debounce — that's the whole
// point of the button. Returns 429 with retryAfter seconds when
// capped.
router.post(
  "/watchlist/cases/:id/consistency/run",
  async (req: Request, res: Response) => {
    if (!adminGate(req, res)) return;
    const staff = (req as ReqWithStaff).staff;
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const caseId = asInt(req.params["id"]);
    if (!caseId) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    if (!(await loadCaseForConsistency(caseId, schoolId, res))) return;

    const since = new Date(Date.now() - 24 * 3600 * 1000);
    // Cap counts MANUAL re-runs only — auto-triggered runs (the
    // debounced fire-after-new-evidence ones) shouldn't burn the
    // admin's budget. A busy case with lots of statements would
    // otherwise lock the "Re-run" button without the admin doing
    // anything wrong.
    const recent = (
      await db.execute(sql`
        SELECT COUNT(*)::int AS "count",
               MIN(created_at) AS "oldest"
          FROM case_consistency_runs
         WHERE school_id = ${schoolId}
           AND case_id   = ${caseId}
           AND trigger_reason = 'manual'
           AND created_at >= ${since}
      `)
    ).rows as Array<{ count: number; oldest: string | null }>;
    const used = recent[0]?.count ?? 0;
    if (used >= MANUAL_RUN_DAILY_CAP) {
      const oldestMs = recent[0]?.oldest
        ? new Date(recent[0].oldest).getTime()
        : Date.now();
      const retryAfterSec = Math.max(
        1,
        Math.round((oldestMs + 24 * 3600 * 1000 - Date.now()) / 1000),
      );
      res.status(429).json({
        error: "Daily AI re-run cap reached for this case (20/day).",
        retryAfter: retryAfterSec,
      });
      return;
    }

    const result = await runConsistencyCheck({
      schoolId,
      caseId,
      triggerReason: "manual",
      actorStaffId: staff.id,
      actorName: staff.displayName,
    });
    if (result.kind === "error") {
      res.status(502).json({ error: result.message });
      return;
    }
    if (result.kind === "debounced") {
      // Manual ignores debounce in the runner, but if we ever flip
      // it back on, surface it as 200 + a hint instead of an error.
      res.json({ ok: true, debounced: true });
      return;
    }
    await audit({
      schoolId,
      entityType: "consistency_run",
      entityId: result.runId,
      action: "manual_run",
      staff,
      payload: { caseId, score: result.score, findingCount: result.findingCount },
    });
    res.json({
      ok: true,
      runId: result.runId,
      score: result.score,
      findingCount: result.findingCount,
    });
  },
);

// Add a human-authored finding the AI missed. source='human', no
// signature_hash (suppression-by-signature is for AI lookalikes; a
// human finding stays exactly as written until manually resolved).
router.post(
  "/watchlist/cases/:id/consistency/findings",
  async (req: Request, res: Response) => {
    if (!adminGate(req, res)) return;
    const staff = (req as ReqWithStaff).staff;
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const caseId = asInt(req.params["id"]);
    if (!caseId) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    if (!(await loadCaseForConsistency(caseId, schoolId, res))) return;
    const b = req.body as Record<string, unknown>;
    const kind = clean(b["kind"], 20);
    const severity = clean(b["severity"], 10);
    const summary = clean(b["summary"], 400);
    const detail = clean(b["detail"], 1200) || null;
    const refs = Array.isArray(b["citedSourceRefs"]) ? b["citedSourceRefs"] : [];
    if (!["contradiction", "gap", "corroboration"].includes(kind)) {
      res.status(400).json({ error: "kind must be contradiction|gap|corroboration" });
      return;
    }
    if (!["high", "med", "low"].includes(severity)) {
      res.status(400).json({ error: "severity must be high|med|low" });
      return;
    }
    if (!summary) {
      res.status(400).json({ error: "summary required" });
      return;
    }
    // Deterministic signature for human findings too — blocks the
    // AI from re-emitting an identical lookalike on the next run.
    const refsClean = refs
      .map((r) => r as Record<string, unknown>)
      .filter(
        (r) =>
          typeof r["kind"] === "string" &&
          ["witness_statement", "interaction", "video_clip", "case_note"].includes(
            r["kind"] as string,
          ) &&
          typeof r["id"] === "number",
      )
      .map((r) => ({ kind: r["kind"] as string, id: r["id"] as number }));
    const sig = createHash("sha256")
      .update(
        `${kind}|${refsClean
          .map((r) => `${r.kind}:${r.id}`)
          .sort()
          .join("|")}|human:${Date.now()}`,
      )
      .digest("hex");
    const [row] = await db
      .insert(caseConsistencyFindingsTable)
      .values({
        schoolId,
        caseId,
        runId: null,
        source: "human",
        kind,
        severity,
        summary,
        detail,
        citedSourceRefs: refsClean,
        signatureHash: sig,
        status: "open",
        createdById: staff.id,
        createdByName: staff.displayName,
      })
      .returning();
    // Refresh state row's open count + high count so the pill picks
    // up the new finding without waiting for the next AI run.
    await refreshConsistencyStateCounts(schoolId, caseId);
    await audit({
      schoolId,
      entityType: "consistency_finding",
      entityId: row.id,
      action: "human_added",
      staff,
      payload: { caseId, kind, severity },
    });
    res.json({ finding: row });
  },
);

// Dismiss (or restore) a finding with required justification. A
// dismissed finding's signature IS the suppression list — the runner
// queries `status='dismissed'` rows to skip lookalikes on the next
// run. Justification is stored in `dismissNote` (≥5 chars enforced).
router.patch(
  "/watchlist/cases/:id/consistency/findings/:findingId",
  async (req: Request, res: Response) => {
    if (!adminGate(req, res)) return;
    const staff = (req as ReqWithStaff).staff;
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const caseId = asInt(req.params["id"]);
    const findingId = asInt(req.params["findingId"]);
    if (!caseId || !findingId) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    if (!(await loadCaseForConsistency(caseId, schoolId, res))) return;
    const b = req.body as Record<string, unknown>;
    const action = clean(b["action"], 20);
    if (!["dismiss", "reopen", "resolve"].includes(action)) {
      res.status(400).json({ error: "action must be dismiss|reopen|resolve" });
      return;
    }
    const reason = clean(b["reason"], 32);
    const note = clean(b["note"], 2000);
    if (action === "dismiss") {
      if (
        !["false_positive", "already_verified", "duplicate", "other"].includes(
          reason,
        )
      ) {
        res.status(400).json({
          error: "reason must be false_positive|already_verified|duplicate|other",
        });
        return;
      }
      if (note.trim().length < 5) {
        res.status(400).json({
          error: "Justification must be at least 5 characters.",
        });
        return;
      }
    }
    const patch: Partial<typeof caseConsistencyFindingsTable.$inferInsert> = {};
    if (action === "dismiss") {
      patch.status = "dismissed";
      patch.dismissReason = reason;
      patch.dismissNote = note;
      patch.dismissedById = staff.id;
      patch.dismissedByName = staff.displayName;
      patch.dismissedAt = new Date();
    } else if (action === "resolve") {
      patch.status = "resolved";
    } else {
      patch.status = "open";
      patch.dismissReason = null;
      patch.dismissNote = null;
      patch.dismissedById = null;
      patch.dismissedByName = null;
      patch.dismissedAt = null;
    }
    const [row] = await db
      .update(caseConsistencyFindingsTable)
      .set(patch)
      .where(
        and(
          eq(caseConsistencyFindingsTable.id, findingId),
          eq(caseConsistencyFindingsTable.schoolId, schoolId),
          eq(caseConsistencyFindingsTable.caseId, caseId),
        ),
      )
      .returning();
    if (!row) {
      res.status(404).json({ error: "Finding not found" });
      return;
    }
    await refreshConsistencyStateCounts(schoolId, caseId);
    await audit({
      schoolId,
      entityType: "consistency_finding",
      entityId: findingId,
      action,
      staff,
      payload: { caseId, reason: reason || null, noteLen: note.length },
    });
    res.json({ finding: row });
  },
);

// Recompute open / high counts on the state row and re-derive score
// from the still-open findings. Called after any human finding insert
// or status change so the header pill reflects the change without
// waiting for the next AI run. We rebuild score from open findings
// (using the same weights as the runner) so the pill stays consistent
// with what the panel shows.
async function refreshConsistencyStateCounts(
  schoolId: number,
  caseId: number,
): Promise<void> {
  const open = await db
    .select({
      kind: caseConsistencyFindingsTable.kind,
      severity: caseConsistencyFindingsTable.severity,
    })
    .from(caseConsistencyFindingsTable)
    .where(
      and(
        eq(caseConsistencyFindingsTable.schoolId, schoolId),
        eq(caseConsistencyFindingsTable.caseId, caseId),
        eq(caseConsistencyFindingsTable.status, "open"),
      ),
    );
  let score = 100;
  let high = 0;
  for (const f of open) {
    if (f.kind === "contradiction") {
      score -= f.severity === "high" ? 15 : f.severity === "med" ? 8 : 4;
      if (f.severity === "high") high += 1;
    } else if (f.kind === "gap") {
      score -= f.severity === "high" ? 6 : f.severity === "med" ? 4 : 2;
    } else if (f.kind === "corroboration") {
      score += 3;
    }
  }
  if (score < 0) score = 0;
  if (score > 100) score = 100;
  await db
    .insert(caseConsistencyStateTable)
    .values({
      schoolId,
      caseId,
      score,
      openFindingCount: open.length,
      highSeverityCount: high,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        caseConsistencyStateTable.schoolId,
        caseConsistencyStateTable.caseId,
      ],
      set: {
        score,
        openFindingCount: open.length,
        highSeverityCount: high,
        updatedAt: new Date(),
      },
    });
}

// =====================================================================
// Case Outcome Catalog (per-school configurable closure types)
// =====================================================================
//
// Closing a case requires picking one of these outcomes — see
// POST /watchlist/cases/:id/close. The catalog itself is admin-managed
// via the School Settings → Case Closure Outcomes tile.

// Helper: lowercase-snake_case slug from a free-text label, used when
// admins add a new outcome and don't supply an explicit code.
function slugifyOutcomeCode(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

// List the school's catalog. Default to active-only; pass ?all=1 for
// the admin editor (which needs to see retired entries too).
router.get("/watchlist/case-outcomes", async (req: Request, res: Response) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const all = req.query["all"] === "1";
  const where = all
    ? eq(caseOutcomeTypesTable.schoolId, schoolId)
    : and(
        eq(caseOutcomeTypesTable.schoolId, schoolId),
        eq(caseOutcomeTypesTable.active, true),
      );
  const rows = await db
    .select()
    .from(caseOutcomeTypesTable)
    .where(where)
    .orderBy(asc(caseOutcomeTypesTable.sortOrder), asc(caseOutcomeTypesTable.label));
  res.json({ outcomes: rows });
});

// Add a new outcome. Admin/SuperUser only.
router.post("/watchlist/case-outcomes", async (req: Request, res: Response) => {
  const staff = (req as ReqWithStaff).staff;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  if (!isAdminOrSuperUser(staff)) {
    res.status(403).json({ error: "Admin role required" });
    return;
  }
  const b = req.body as Record<string, unknown>;
  const label = clean(b["label"], 80);
  if (label.length < 2) {
    res.status(400).json({ error: "label required (min 2 chars)" });
    return;
  }
  let code = clean(b["code"], 60);
  if (!code) code = slugifyOutcomeCode(label);
  if (!/^[a-z0-9_]+$/.test(code)) {
    res
      .status(400)
      .json({ error: "code must be lowercase letters / digits / underscores" });
    return;
  }
  const description = clean(b["description"], 400);
  const sortOrder =
    typeof b["sortOrder"] === "number" && Number.isFinite(b["sortOrder"])
      ? Math.round(b["sortOrder"] as number)
      : 100;
  try {
    const row = await db.transaction(async (tx) => {
      const [r] = await tx
        .insert(caseOutcomeTypesTable)
        .values({
          schoolId,
          code,
          label,
          description,
          sortOrder,
          createdByName: staff.displayName,
        })
        .returning();
      await audit({
        schoolId,
        entityType: "case_outcome_type",
        entityId: r.id,
        action: "created",
        staff,
        payload: { code, label, sortOrder },
        tx,
      });
      return r;
    });
    res.json({ outcome: row });
  } catch (e) {
    // Unique-violation on (school_id, code) — surface as 409 so the UI
    // can show "an outcome with that code already exists".
    res.status(409).json({
      error: "An outcome with that code already exists for this school.",
    });
    req.log?.warn({ err: e }, "case-outcome create conflict");
  }
});

// Edit an existing outcome's label/description/sort/active flag. The
// `code` field is intentionally immutable post-create — historical
// closed cases reference it and we don't want to chase rewrites.
router.patch(
  "/watchlist/case-outcomes/:id",
  async (req: Request, res: Response) => {
    const staff = (req as ReqWithStaff).staff;
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    if (!isAdminOrSuperUser(staff)) {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const id = asInt(req.params["id"]);
    if (!id) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const b = req.body as Record<string, unknown>;
    const patch: Partial<typeof caseOutcomeTypesTable.$inferInsert> = {};
    if (typeof b["label"] === "string") patch.label = clean(b["label"], 80);
    if (typeof b["description"] === "string")
      patch.description = clean(b["description"], 400);
    if (typeof b["sortOrder"] === "number")
      patch.sortOrder = Math.round(b["sortOrder"] as number);
    if (typeof b["active"] === "boolean") patch.active = b["active"];
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: "no changes" });
      return;
    }
    const row = await db.transaction(async (tx) => {
      const [r] = await tx
        .update(caseOutcomeTypesTable)
        .set(patch)
        .where(
          and(
            eq(caseOutcomeTypesTable.id, id),
            eq(caseOutcomeTypesTable.schoolId, schoolId),
          ),
        )
        .returning();
      if (!r) return null;
      await audit({
        schoolId,
        entityType: "case_outcome_type",
        entityId: id,
        action: "updated",
        staff,
        payload: patch as Record<string, unknown>,
        tx,
      });
      return r;
    });
    if (!row) {
      res.status(404).json({ error: "Outcome not found" });
      return;
    }
    res.json({ outcome: row });
  },
);

// =====================================================================
// Close / Reopen case (outcome required)
// =====================================================================

router.post(
  "/watchlist/cases/:id/close",
  async (req: Request, res: Response) => {
    const staff = (req as ReqWithStaff).staff;
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const id = asInt(req.params["id"]);
    if (!id) {
      res.status(400).json({ error: "Invalid case id" });
      return;
    }
    const b = req.body as Record<string, unknown>;
    const outcomeCode = clean(b["outcomeCode"], 60);
    if (!outcomeCode) {
      res
        .status(400)
        .json({ error: "outcomeCode required (pick from the catalog)" });
      return;
    }
    const outcomeNote = clean(b["outcomeNote"], 2000);
    // Verify the outcome belongs to this school AND is active. Inactive
    // codes can be referenced by historical rows but never NEW closures.
    const [outcome] = await db
      .select()
      .from(caseOutcomeTypesTable)
      .where(
        and(
          eq(caseOutcomeTypesTable.schoolId, schoolId),
          eq(caseOutcomeTypesTable.code, outcomeCode),
          eq(caseOutcomeTypesTable.active, true),
        ),
      );
    if (!outcome) {
      res
        .status(400)
        .json({ error: "Unknown or retired outcomeCode for this school" });
      return;
    }
    // The 'other' outcome (or any future outcome whose label flags
    // "note required") demands a note. Today we only enforce by code.
    if (outcomeCode === "other" && outcomeNote.length < 5) {
      res.status(400).json({
        error: "outcomeNote required (min 5 chars) when closing as 'other'",
      });
      return;
    }
    const row = await db.transaction(async (tx) => {
      const [r] = await tx
        .update(interactionCasesTable)
        .set({
          status: "closed",
          closedAt: new Date(),
          outcomeCode,
          outcomeNote,
          closedByStaffId: staff.id,
          closedByName: staff.displayName,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(interactionCasesTable.id, id),
            eq(interactionCasesTable.schoolId, schoolId),
          ),
        )
        .returning();
      if (!r) return null;
      await audit({
        schoolId,
        entityType: "case",
        entityId: id,
        action: "closed",
        staff,
        payload: {
          outcomeCode,
          outcomeLabel: outcome.label,
          outcomeNote: outcomeNote || null,
        },
        tx,
      });
      return r;
    });
    if (!row) {
      res.status(404).json({ error: "Case not found" });
      return;
    }
    res.json({ case: row });
  },
);

router.post(
  "/watchlist/cases/:id/reopen",
  async (req: Request, res: Response) => {
    const staff = (req as ReqWithStaff).staff;
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    if (!isAdminOrSuperUser(staff)) {
      res
        .status(403)
        .json({ error: "Admin role required to reopen a closed case" });
      return;
    }
    const id = asInt(req.params["id"]);
    if (!id) {
      res.status(400).json({ error: "Invalid case id" });
      return;
    }
    const reason = clean((req.body as Record<string, unknown>)["reason"], 500);
    if (reason.length < 5) {
      res.status(400).json({ error: "reason required (min 5 chars)" });
      return;
    }
    // We deliberately PRESERVE outcomeCode/outcomeNote/closedByName so
    // the historical record of the prior closure cycle stays visible.
    // Only status + closedAt flip back to open.
    const row = await db.transaction(async (tx) => {
      const [r] = await tx
        .update(interactionCasesTable)
        .set({ status: "open", closedAt: null, updatedAt: new Date() })
        .where(
          and(
            eq(interactionCasesTable.id, id),
            eq(interactionCasesTable.schoolId, schoolId),
          ),
        )
        .returning();
      if (!r) return null;
      await audit({
        schoolId,
        entityType: "case",
        entityId: id,
        action: "reopened",
        staff,
        payload: { reason, priorOutcomeCode: r.outcomeCode },
        tx,
      });
      return r;
    });
    if (!row) {
      res.status(404).json({ error: "Case not found" });
      return;
    }
    res.json({ case: row });
  },
);

// =====================================================================
// Investigation aggregate (per-incident witness ring)
// =====================================================================
//
// One incident at a time. Returns:
//   - the incident itself
//   - principals (target/instigator participants)
//   - witnesses (anyone with a witness_statements row on the incident)
//   - mentioned-but-silent (students named in any witness statement on
//     the incident via case_mentions, who aren't already principals or
//     witness-statement authors)
//   - edges drawn from case_mentions: every (witness statement) ⇨
//     (mentioned student) becomes an edge anchored on the witness's
//     student id (when the witness IS a student) or on the incident
//     (when the witness is staff with no student id of their own)
//   - edges drawn from case_consistency_findings: corroboration and
//     contradiction pairs between witness statement rows
router.get(
  "/watchlist/cases/:caseId/investigation/:interactionId",
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const caseId = asInt(req.params["caseId"]);
    const interactionId = asInt(req.params["interactionId"]);
    if (!caseId || !interactionId) {
      res.status(400).json({ error: "Invalid ids" });
      return;
    }
    // Confirm the incident actually belongs to the case AND school.
    const [incident] = await db
      .select()
      .from(interactionsTable)
      .where(
        and(
          eq(interactionsTable.id, interactionId),
          eq(interactionsTable.schoolId, schoolId),
          eq(interactionsTable.caseId, caseId),
        ),
      );
    if (!incident) {
      res
        .status(404)
        .json({ error: "Incident not found on this case" });
      return;
    }
    // Participants on the incident (principals + witness-role students).
    const participants = await db
      .select()
      .from(interactionParticipantsTable)
      .where(
        and(
          eq(interactionParticipantsTable.schoolId, schoolId),
          eq(interactionParticipantsTable.interactionId, interactionId),
        ),
      );
    // All witness statements on this incident (the witnesses ring).
    const statements = await db
      .select()
      .from(witnessStatementsTable)
      .where(
        and(
          eq(witnessStatementsTable.schoolId, schoolId),
          eq(witnessStatementsTable.interactionId, interactionId),
        ),
      );
    const statementIds = statements.map((s) => s.id);
    // case_mentions filtered to just THIS incident's statements.
    const mentions = statementIds.length
      ? await db
          .select()
          .from(caseMentionsTable)
          .where(
            and(
              eq(caseMentionsTable.schoolId, schoolId),
              eq(caseMentionsTable.sourceKind, "witness_statement"),
              inArray(caseMentionsTable.sourceId, statementIds),
            ),
          )
      : [];
    // Resolve student display names for every studentId we'll surface.
    const studentIdSet = new Set<string>();
    for (const p of participants) studentIdSet.add(p.studentId);
    for (const s of statements) if (s.studentId) studentIdSet.add(s.studentId);
    for (const m of mentions) studentIdSet.add(m.studentId);
    const studentMap = await loadStudents(schoolId, [...studentIdSet]);

    type StudentMeta = {
      studentId: string;
      firstName: string;
      lastName: string;
      grade: number | string | null;
      initials: string;
    };
    const toMeta = (sid: string): StudentMeta | null => {
      const s = studentMap.get(sid);
      if (!s) return null;
      const initials = `${(s.firstName?.[0] ?? "?").toUpperCase()}${(s.lastName?.[0] ?? "?").toUpperCase()}`;
      return {
        studentId: sid,
        firstName: s.firstName,
        lastName: s.lastName,
        grade: s.grade,
        initials,
      };
    };

    // Principals = students with role target/instigator.
    const principalIds = new Set(
      participants
        .filter((p) => p.role === "target" || p.role === "instigator")
        .map((p) => p.studentId),
    );
    const principals = [...principalIds]
      .map((sid) => {
        const meta = toMeta(sid);
        if (!meta) return null;
        const myParts = participants.filter((p) => p.studentId === sid);
        return {
          ...meta,
          roles: myParts.map((p) => p.role),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x != null);

    // Witnesses (students with statements on this incident). The schema
    // requires `studentId NOT NULL`, so every statement IS a student
    // statement; staff who recorded statements appear as `requestedByName`.
    const witnesses = statements.map((s) => {
      const meta = toMeta(s.studentId);
      return {
        statementId: s.id,
        studentId: s.studentId,
        displayName: meta
          ? `${meta.firstName} ${meta.lastName}`
          : `Student ${s.studentId}`,
        initials: meta?.initials ?? "?",
        grade: meta?.grade ?? null,
        status: s.status,
        body: s.body ?? "",
        requestedAt: s.requestedAt,
        completedAt: s.completedAt,
        requestedByName: s.requestedByName,
      };
    });

    // Mentioned-but-silent: anyone named in a statement who isn't a
    // principal AND doesn't have their own statement on this incident.
    const witnessStudentIds = new Set(
      statements.map((s) => s.studentId).filter((x): x is string => Boolean(x)),
    );
    const mentionedOnly: Array<
      StudentMeta & { mentionedInStatementIds: number[] }
    > = [];
    {
      const seen = new Map<string, Set<number>>();
      for (const m of mentions) {
        if (principalIds.has(m.studentId)) continue;
        if (witnessStudentIds.has(m.studentId)) continue;
        let set = seen.get(m.studentId);
        if (!set) {
          set = new Set<number>();
          seen.set(m.studentId, set);
        }
        set.add(m.sourceId);
      }
      for (const [sid, idSet] of seen.entries()) {
        const meta = toMeta(sid);
        if (!meta) continue;
        mentionedOnly.push({
          ...meta,
          mentionedInStatementIds: [...idSet],
        });
      }
    }

    // Edges from mentions: source = the witness statement's author
    // student, target = the mentioned student. We collapse multiple
    // mentions of the same target by the same author into one edge with
    // a weight (used by the client for line thickness).
    const statementById = new Map(statements.map((s) => [s.id, s] as const));
    type MentionEdge = {
      kind: "mention";
      fromStudentId: string;
      fromStatementId: number;
      toStudentId: string;
      weight: number;
    };
    type ConsistencyEdge = {
      kind: "corroborates" | "contradicts";
      aStatementId: number;
      bStatementId: number;
      findingId: number;
      severity: string;
    };
    const mentionEdges = new Map<string, MentionEdge>();
    for (const m of mentions) {
      const stmt = statementById.get(m.sourceId);
      if (!stmt) continue;
      const key = `${stmt.studentId}|${m.studentId}`;
      const existing = mentionEdges.get(key);
      if (existing) {
        existing.weight += 1;
      } else {
        mentionEdges.set(key, {
          kind: "mention",
          fromStudentId: stmt.studentId,
          fromStatementId: stmt.id,
          toStudentId: m.studentId,
          weight: 1,
        });
      }
    }

    // Consistency-derived edges (corroborates / contradicts) between
    // pairs of witness statements on this incident, if Phase 3 has run.
    const consistencyEdges: ConsistencyEdge[] = [];
    if (statementIds.length > 1) {
      const findings = await db
        .select()
        .from(caseConsistencyFindingsTable)
        .where(
          and(
            eq(caseConsistencyFindingsTable.schoolId, schoolId),
            eq(caseConsistencyFindingsTable.caseId, caseId),
            eq(caseConsistencyFindingsTable.status, "open"),
          ),
        );
      for (const f of findings) {
        if (f.kind !== "contradiction" && f.kind !== "corroboration") continue;
        const refs = (f.citedSourceRefs ?? []) as Array<{
          kind: string;
          id: number;
        }>;
        const stmtRefs = refs
          .filter(
            (r) =>
              r.kind === "witness_statement" && statementIds.includes(r.id),
          )
          .map((r) => r.id);
        // Emit pairwise edges between every pair of statements the
        // finding cites within THIS incident (most findings cite 2).
        for (let i = 0; i < stmtRefs.length; i++) {
          for (let j = i + 1; j < stmtRefs.length; j++) {
            consistencyEdges.push({
              kind: f.kind === "contradiction" ? "contradicts" : "corroborates",
              aStatementId: stmtRefs[i],
              bStatementId: stmtRefs[j],
              findingId: f.id,
              severity: f.severity,
            });
          }
        }
      }
    }

    res.json({
      incident: {
        id: incident.id,
        kind: incident.kind,
        severity: incident.severity,
        occurredAt: incident.occurredAt,
        location: incident.location ?? "",
        summary: incident.summary,
        detail: incident.detail ?? "",
      },
      principals,
      witnesses,
      mentionedOnly,
      edges: {
        mentions: [...mentionEdges.values()],
        consistency: consistencyEdges,
      },
    });
  },
);

// =====================================================================
// AI mention suggester (server-side, optional)
// =====================================================================
//
// Given a witness statement id, ask Claude (via the Replit AI proxy
// already wired for the consistency check) which roster students the
// free-text body appears to reference. The client uses this to show
// a "we think this also references: X, Y — confirm?" strip; it never
// auto-applies, the writer must click to insert chips.

router.post(
  "/watchlist/statements/:id/suggest-mentions",
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const id = asInt(req.params["id"]);
    if (!id) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [stmt] = await db
      .select()
      .from(witnessStatementsTable)
      .where(
        and(
          eq(witnessStatementsTable.schoolId, schoolId),
          eq(witnessStatementsTable.id, id),
        ),
      );
    if (!stmt) {
      res.status(404).json({ error: "Statement not found" });
      return;
    }
    const body = (stmt.body ?? "").trim();
    if (body.length < 20) {
      res.json({ suggestions: [] });
      return;
    }
    // Parse the chips already in the body so we don't re-suggest them.
    const already = new Set<string>();
    for (const m of body.matchAll(/@\[[^|\]]+\|([A-Za-z0-9_-]+)\]/g)) {
      already.add(m[1]);
    }
    const roster = await db
      .select({
        studentId: studentsTable.studentId,
        firstName: studentsTable.firstName,
        lastName: studentsTable.lastName,
        grade: studentsTable.grade,
      })
      .from(studentsTable)
      .where(eq(studentsTable.schoolId, schoolId));
    if (roster.length === 0) {
      res.json({ suggestions: [] });
      return;
    }
    try {
      // Lazy import — keep AI dep out of the route's hot path.
      const { suggestMentions } = await import(
        "../lib/mentionSuggest.js"
      );
      const suggestions = await suggestMentions({
        body,
        roster,
        already,
      });
      res.json({ suggestions });
    } catch (e) {
      req.log?.warn({ err: e }, "mention-suggest failed");
      // Failure is silent for the user — the suggest strip just stays
      // empty. The witness-statement flow should never break because
      // the AI helper hiccupped.
      res.json({ suggestions: [] });
    }
  },
);

// Silence "imported but unused" — `assembleCaseBundle` is referenced
// only by the runner today, but we re-export it here so a future
// admin "preview the bundle without running AI" debug endpoint can
// reach it without re-importing.
export { assembleCaseBundle };

export default router;
