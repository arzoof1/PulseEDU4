import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  db,
  pulloutsTable,
  staffTable,
  studentsTable,
  interventionEntriesTable,
  issRosterTable,
  schoolSettingsTable,
} from "@workspace/db";
import { eq, and, gte, desc, inArray, or, asc } from "drizzle-orm";
import {
  sendPulloutArrivalEmail,
  sendPulloutDispatchEmail,
  sendPulloutReturnEmail,
  sendPulloutSendToIssEmail,
} from "../lib/pulloutEmail";
import { upsertIssAttendance } from "./issAttendance";
import { requireSchool } from "../lib/scope.js";

// Helper: load a pullout row scoped to the active school. Returns null and
// writes 404 if the row doesn't exist OR belongs to another school. This
// keeps SuperUsers honest while operating in a switched school: even if
// they know an id from another school, they can't act on it without
// switching back.
async function loadScopedPullout(req: Request, res: Response, id: number) {
  const schoolId = req.schoolId;
  if (!schoolId) {
    res.status(401).json({ error: "Sign-in required" });
    return null;
  }
  const [row] = await db
    .select()
    .from(pulloutsTable)
    .where(and(eq(pulloutsTable.id, id), eq(pulloutsTable.schoolId, schoolId)));
  if (!row) {
    res.status(404).json({ error: "Pullout not found" });
    return null;
  }
  return row;
}

const router: IRouter = Router();

type StaffRow = typeof staffTable.$inferSelect;

async function loadStaff(req: Request): Promise<StaffRow | null> {
  const id = req.staffId;
  if (!id) return null;
  const [s] = await db.select().from(staffTable).where(eq(staffTable.id, id));
  return s && s.active ? s : null;
}

function requireStaffMW(check?: (s: StaffRow) => boolean, label = "Sign-in") {
  return async (req: Request, res: Response, next: NextFunction) => {
    const staff = await loadStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    if (check && !check(staff)) {
      res.status(403).json({ error: `${label} only` });
      return;
    }
    (req as Request & { staff: StaffRow }).staff = staff;
    next();
  };
}

const INTERVENTION_WINDOW_DAYS = 7;

// Days-ago helper. Returns ISO timestamp.
function daysAgoIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

// Has the student had any logged classroom intervention recently?
// School-scoped so school A can't probe school B's intervention history
// via the preflight endpoint.
async function hasRecentIntervention(
  studentId: string,
  schoolId: number,
): Promise<boolean> {
  const since = daysAgoIso(INTERVENTION_WINDOW_DAYS);
  const rows = await db
    .select({ id: interventionEntriesTable.id })
    .from(interventionEntriesTable)
    .where(
      and(
        eq(interventionEntriesTable.studentId, studentId),
        eq(interventionEntriesTable.schoolId, schoolId),
        gte(interventionEntriesTable.createdAt, since),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Request Pullout — dispatch notification config (admin / superuser only).
// No-code surface for WHO is notified (role-based dispatchers + hand-picked
// extras such as a reading coach) and whether a TEXT is also sent. Registered
// before the dynamic GETs; all GETs here use literal prefixes so there's no
// shadowing, but keeping it first is the safe convention.
// ---------------------------------------------------------------------------
const isPulloutNotifyAdmin = (s: StaffRow) => s.isSuperUser || s.isAdmin;

function pulloutRoleLabels(s: StaffRow): string[] {
  const labels: string[] = [];
  if (s.isAdmin) labels.push("Admin");
  if (s.isDean) labels.push("Dean");
  if (s.isMtssCoordinator) labels.push("MTSS Coordinator");
  if (s.isIssTeacher) labels.push("ISS Teacher");
  if (s.isBehaviorSpecialist) labels.push("Behavior Specialist");
  return labels;
}

router.get(
  "/pullouts/notify-config",
  requireStaffMW(isPulloutNotifyAdmin, "Admin"),
  async (req: Request, res: Response) => {
    const schoolId = req.schoolId;
    if (!schoolId) {
      res.status(400).json({ error: "No active school" });
      return;
    }
    const [settings] = await db
      .select()
      .from(schoolSettingsTable)
      .where(eq(schoolSettingsTable.schoolId, schoolId));
    const extraIds: number[] =
      settings && Array.isArray(settings.pulloutExtraRecipientStaffIds)
        ? settings.pulloutExtraRecipientStaffIds.filter(
            (n): n is number => typeof n === "number" && Number.isInteger(n),
          )
        : [];
    // Active staff are pickable; we ALSO surface any already-selected extra
    // whose account has since gone inactive so an admin can still remove it
    // (otherwise a departed staffer would be stuck on the list with no row to
    // toggle off).
    const activeOrExtra = extraIds.length
      ? or(eq(staffTable.active, true), inArray(staffTable.id, extraIds))
      : eq(staffTable.active, true);
    const staff = await db
      .select()
      .from(staffTable)
      .where(and(eq(staffTable.schoolId, schoolId), activeOrExtra))
      .orderBy(asc(staffTable.displayName));
    const list = staff.map((s) => {
      const roleLabels = pulloutRoleLabels(s);
      return {
        id: s.id,
        displayName: s.displayName,
        roleLabels,
        isActive: !!s.active,
        isAutoRecipient: roleLabels.length > 0,
        hasEmail: !!(s.email && s.email.includes("@")),
        hasCell: !!(s.cellPhone && s.cellPhone.trim().length > 0),
        isExtra: extraIds.includes(s.id),
      };
    });
    res.json({
      smsEnabled: !!settings?.pulloutSmsEnabled,
      extraRecipientStaffIds: extraIds,
      staff: list,
    });
  },
);

router.put(
  "/pullouts/notify-config",
  requireStaffMW(isPulloutNotifyAdmin, "Admin"),
  async (req: Request, res: Response) => {
    const schoolId = req.schoolId;
    if (!schoolId) {
      res.status(400).json({ error: "No active school" });
      return;
    }
    const { smsEnabled, extraRecipientStaffIds } = (req.body ?? {}) as {
      smsEnabled?: unknown;
      extraRecipientStaffIds?: unknown;
    };
    const updates: Partial<typeof schoolSettingsTable.$inferInsert> = {};
    if (typeof smsEnabled === "boolean") {
      updates.pulloutSmsEnabled = smsEnabled;
    }
    if (extraRecipientStaffIds !== undefined) {
      if (!Array.isArray(extraRecipientStaffIds)) {
        res
          .status(400)
          .json({ error: "extraRecipientStaffIds must be an array of ids" });
        return;
      }
      const ids = Array.from(
        new Set(
          extraRecipientStaffIds.filter(
            (n): n is number => Number.isInteger(n) && (n as number) > 0,
          ),
        ),
      );
      // Only keep ids that actually belong to THIS school (tenant safety).
      let valid: number[] = [];
      if (ids.length > 0) {
        const rows = await db
          .select({ id: staffTable.id })
          .from(staffTable)
          .where(
            and(eq(staffTable.schoolId, schoolId), inArray(staffTable.id, ids)),
          );
        valid = rows.map((r) => r.id);
      }
      updates.pulloutExtraRecipientStaffIds = valid;
    }
    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }
    const [existing] = await db
      .select({ schoolId: schoolSettingsTable.schoolId })
      .from(schoolSettingsTable)
      .where(eq(schoolSettingsTable.schoolId, schoolId));
    if (existing) {
      await db
        .update(schoolSettingsTable)
        .set(updates)
        .where(eq(schoolSettingsTable.schoolId, schoolId));
    } else {
      await db.insert(schoolSettingsTable).values({ schoolId, ...updates });
    }
    res.json({ ok: true, ...updates });
  },
);

// Pre-flight check used by the form to decide whether to show the
// "no recent interventions, ack required" warning.
router.get(
  "/pullouts/preflight",
  requireStaffMW(),
  async (req: Request, res: Response) => {
    const studentId = String(req.query.studentId ?? "").trim();
    if (!studentId) {
      res.status(400).json({ error: "studentId required" });
      return;
    }
    const has = await hasRecentIntervention(studentId, req.schoolId!);
    res.json({
      studentId,
      hasRecentIntervention: has,
      windowDays: INTERVENTION_WINDOW_DAYS,
    });
  },
);

// List pullouts. By default any signed-in staff sees their own requests.
// Query: ?scope=mine|pending|active|all
//   pending: status=pending (verifiers see this)
//   active:  not yet closed/rejected (ISS dashboard)
//   all:     all rows (Behavior Specialist review)
router.get(
  "/pullouts",
  requireStaffMW(),
  async (req: Request, res: Response) => {
    const staff = (req as Request & { staff: StaffRow }).staff;
    const scope = String(req.query.scope ?? "mine");

    // Mirrors the canonical `isVerifier` defined below (and the client-side
    // `canVerifyPullouts` gate in App.tsx). Keep these in sync — Behavior
    // Specialists and PBIS Coordinators must be able to fetch the pending
    // queue so the bell badge shows up for them, not just admins/dean/MTSS.
    const isVerifier =
      staff.isSuperUser ||
      staff.isAdmin ||
      staff.isDean ||
      staff.isMtssCoordinator ||
      staff.isBehaviorSpecialist ||
      staff.isPbisCoordinator;
    const isIssView =
      staff.isSuperUser ||
      staff.isAdmin ||
      staff.isIssTeacher ||
      staff.isBehaviorSpecialist ||
      staff.isDean ||
      staff.isMtssCoordinator;
    const isReviewer =
      staff.isSuperUser || staff.isAdmin || staff.isBehaviorSpecialist;

    if (scope === "pending" && !isVerifier) {
      res.status(403).json({ error: "Verifier only" });
      return;
    }
    if (scope === "active" && !isIssView) {
      res.status(403).json({ error: "ISS dashboard role only" });
      return;
    }
    if (scope === "all" && !isReviewer) {
      res.status(403).json({ error: "Behavior specialist or admin only" });
      return;
    }
    if (scope === "unreviewed" && !isReviewer) {
      res.status(403).json({ error: "Behavior specialist or admin only" });
      return;
    }

    const all = await db
      .select()
      .from(pulloutsTable)
      .where(eq(pulloutsTable.schoolId, req.schoolId!))
      .orderBy(desc(pulloutsTable.requestedAt))
      .limit(500);

    let rows = all;
    if (scope === "mine") {
      rows = all.filter((r) => r.requestedById === staff.id);
    } else if (scope === "pending") {
      rows = all.filter((r) => r.status === "pending");
    } else if (scope === "active") {
      rows = all.filter(
        (r) =>
          r.status === "verified" ||
          r.status === "enroute" ||
          r.status === "arrived",
      );
    } else if (scope === "unreviewed") {
      rows = all.filter(
        (r) => r.status === "closed" && r.reviewedAt == null,
      );
    }

    // Enrich with localSisId so the UI can render the 6-digit local
    // ID staff know kids by. FLEID stays in the payload as
    // `studentId` (internal key) but is never rendered.
    const sids = Array.from(new Set(rows.map((r) => r.studentId)));
    const localSisMap = new Map<string, string | null>();
    if (sids.length > 0) {
      const stuRows = await db
        .select({
          studentId: studentsTable.studentId,
          localSisId: studentsTable.localSisId,
        })
        .from(studentsTable)
        .where(
          and(
            eq(studentsTable.schoolId, req.schoolId!),
            inArray(studentsTable.studentId, sids),
          ),
        );
      for (const s of stuRows) localSisMap.set(s.studentId, s.localSisId ?? null);
    }
    res.json(
      rows.map((r) => ({
        ...r,
        localSisId: localSisMap.get(r.studentId) ?? null,
      })),
    );
  },
);

router.post(
  "/pullouts",
  requireStaffMW(),
  async (req: Request, res: Response) => {
    const staff = (req as Request & { staff: StaffRow }).staff;
    const {
      studentId,
      reason,
      period,
      interventionsTried,
      acknowledgeNoIntervention,
      referringTeacherStaffId,
      referringTeacherName,
    } = req.body ?? {};

    if (typeof studentId !== "string" || !studentId.trim()) {
      res.status(400).json({ error: "studentId is required" });
      return;
    }
    if (typeof reason !== "string" || !reason.trim()) {
      res.status(400).json({ error: "reason is required" });
      return;
    }
    let periodNum: number | null = null;
    if (period !== undefined && period !== null && period !== "") {
      const p = Number(period);
      if (!Number.isInteger(p) || p < 1 || p > 12) {
        res.status(400).json({ error: "period must be an integer 1-12" });
        return;
      }
      periodNum = p;
    }

    const has = await hasRecentIntervention(studentId.trim(), req.schoolId!);
    if (!has && acknowledgeNoIntervention !== true) {
      res.status(409).json({
        error: `Pullouts require a logged classroom intervention in the past ${INTERVENTION_WINDOW_DAYS} days. If you have tried interventions but not logged them, set acknowledgeNoIntervention=true.`,
        hasRecentIntervention: false,
        windowDays: INTERVENTION_WINDOW_DAYS,
      });
      return;
    }

    // Default referring teacher is the requester. Admin/Dean/MTSS may submit
    // on behalf of another teacher.
    let refStaffId: number | null = staff.id;
    let refName: string = staff.displayName;
    if (
      (staff.isSuperUser ||
        staff.isAdmin ||
        staff.isDean ||
        staff.isMtssCoordinator) &&
      typeof referringTeacherStaffId === "number"
    ) {
      const [other] = await db
        .select()
        .from(staffTable)
        .where(eq(staffTable.id, referringTeacherStaffId));
      if (other) {
        refStaffId = other.id;
        refName = other.displayName;
      }
    } else if (
      typeof referringTeacherName === "string" &&
      referringTeacherName.trim()
    ) {
      refName = referringTeacherName.trim();
    }

    const [row] = await db
      .insert(pulloutsTable)
      .values({
        schoolId: req.schoolId!,
        studentId: studentId.trim(),
        requestedById: staff.id,
        requestedByName: staff.displayName,
        requestedAt: new Date().toISOString(),
        referringTeacherStaffId: refStaffId,
        referringTeacherName: refName,
        period: periodNum,
        reason: reason.trim(),
        interventionsTried:
          typeof interventionsTried === "string" && interventionsTried.trim()
            ? interventionsTried.trim()
            : null,
        status: "pending",
      })
      .returning();

    // Notify dispatch team (admins/dean/MTSS/ISS) by email so they can
    // verify and route this pullout. Synchronous so the UI can surface
    // the result alongside the row.
    const dispatchEmail = await sendPulloutDispatchEmail(row.id);
    res.status(201).json({ ...row, dispatchEmail });
  },
);

// Verifier actions — open to the full Core Team so any of them can log
// a "teacher called instead of using the app" pullout and route it.
// Mirrors the client-side `canVerifyPullouts` gate in App.tsx.
const isVerifier = (s: StaffRow) =>
  s.isSuperUser ||
  s.isAdmin ||
  s.isDean ||
  s.isMtssCoordinator ||
  s.isBehaviorSpecialist ||
  s.isPbisCoordinator;

router.patch(
  "/pullouts/:id/verify",
  requireStaffMW(isVerifier, "Verifier"),
  async (req: Request, res: Response) => {
    const staff = (req as Request & { staff: StaffRow }).staff;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const {
      editedReason,
      period,
      referringTeacherName,
      parentMessage,
    }: {
      editedReason?: unknown;
      period?: unknown;
      referringTeacherName?: unknown;
      parentMessage?: unknown;
    } = req.body ?? {};

    const [existing] = await db
      .select()
      .from(pulloutsTable)
      .where(and(eq(pulloutsTable.id, id), eq(pulloutsTable.schoolId, req.schoolId!)));
    if (!existing) {
      res.status(404).json({ error: "Pullout not found" });
      return;
    }
    if (existing.status !== "pending") {
      res.status(409).json({
        error: `Pullout is ${existing.status}; only pending pullouts can be verified.`,
      });
      return;
    }

    const updates: Partial<typeof pulloutsTable.$inferInsert> = {
      status: "verified",
      verifiedById: staff.id,
      verifiedByName: staff.displayName,
      verifiedAt: new Date().toISOString(),
    };
    if (typeof editedReason === "string" && editedReason.trim()) {
      updates.editedReason = editedReason.trim();
    }
    if (period !== undefined && period !== null && period !== "") {
      const p = Number(period);
      if (!Number.isInteger(p) || p < 1 || p > 12) {
        res.status(400).json({ error: "period must be an integer 1-12" });
        return;
      }
      updates.period = p;
    }
    if (
      typeof referringTeacherName === "string" &&
      referringTeacherName.trim()
    ) {
      updates.referringTeacherName = referringTeacherName.trim();
    }
    // Verify-modal parent message — already-substituted text the
    // verifier authored (or accepted from a template). Stored verbatim
    // and used as the body of the parent arrival email when the
    // student is marked arrived at ISS.
    if (typeof parentMessage === "string") {
      const pm = parentMessage.trim();
      if (pm.length > 4000) {
        res.status(400).json({ error: "parentMessage too long (max 4000)" });
        return;
      }
      updates.parentMessage = pm.length > 0 ? pm : null;
    }

    const [row] = await db
      .update(pulloutsTable)
      .set(updates)
      .where(and(eq(pulloutsTable.id, id), eq(pulloutsTable.schoolId, req.schoolId!)))
      .returning();
    // Fire the parent send-to-ISS email synchronously so the verifier
    // sees the result inline with the row update. Idempotent on
    // pullouts.sent_to_iss_email_sent_at, so a second verify (e.g.
    // re-edit + Send to ISS again) won't double-send.
    const sendToIssEmail = await sendPulloutSendToIssEmail(id);
    if (sendToIssEmail.status === "error") {
      console.error(
        `[pullouts] send-to-ISS email failed (pulloutId=${id}):`,
        sendToIssEmail.errorMsg,
      );
    }
    res.json({ ...row, sendToIssEmail });
  },
);

router.patch(
  "/pullouts/:id/reject",
  requireStaffMW(isVerifier, "Verifier"),
  async (req: Request, res: Response) => {
    const staff = (req as Request & { staff: StaffRow }).staff;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const { rejectedReason } = req.body ?? {};
    if (typeof rejectedReason !== "string" || !rejectedReason.trim()) {
      res.status(400).json({ error: "rejectedReason is required" });
      return;
    }
    const [existing] = await db
      .select()
      .from(pulloutsTable)
      .where(and(eq(pulloutsTable.id, id), eq(pulloutsTable.schoolId, req.schoolId!)));
    if (!existing) {
      res.status(404).json({ error: "Pullout not found" });
      return;
    }
    if (existing.status !== "pending") {
      res.status(409).json({
        error: `Pullout is ${existing.status}; only pending pullouts can be rejected.`,
      });
      return;
    }
    const [row] = await db
      .update(pulloutsTable)
      .set({
        status: "rejected",
        rejectedAt: new Date().toISOString(),
        rejectedReason: rejectedReason.trim(),
        verifiedById: staff.id,
        verifiedByName: staff.displayName,
      })
      .where(and(eq(pulloutsTable.id, id), eq(pulloutsTable.schoolId, req.schoolId!)))
      .returning();
    res.json(row);
  },
);

// Per-student pullout history. Any signed-in staff can view, mirroring
// the Student Activity tab access pattern.
router.get(
  "/pullouts/by-student/:studentId",
  requireStaffMW(),
  async (req: Request, res: Response) => {
    const sid = String(req.params.studentId ?? "").trim();
    if (!sid) {
      res.status(400).json({ error: "studentId required" });
      return;
    }
    const staff = (req as Request & { staff: StaffRow }).staff;
    const rows = await db
      .select()
      .from(pulloutsTable)
      .where(
        and(
          eq(pulloutsTable.studentId, sid),
          eq(pulloutsTable.schoolId, req.schoolId!),
        ),
      )
      .orderBy(desc(pulloutsTable.requestedAt));
    const [stu] = await db
      .select({ localSisId: studentsTable.localSisId })
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.studentId, sid),
          eq(studentsTable.schoolId, req.schoolId!),
        ),
      );
    const localSisId = stu?.localSisId ?? null;
    res.json(rows.map((r) => ({ ...r, localSisId })));
  },
);

// Aggregated pullout report. Restricted to ISS-view roles so it's not
// exposed to all teachers.
router.get(
  "/pullouts/report",
  requireStaffMW(
    (s) =>
      s.isSuperUser ||
      s.isAdmin ||
      s.isBehaviorSpecialist ||
      s.isDean ||
      s.isMtssCoordinator ||
      s.isIssTeacher,
    "ISS dashboard role",
  ),
  async (req: Request, res: Response) => {
    const staff = (req as Request & { staff: StaffRow }).staff;
    let days = Number(req.query.days ?? 30);
    if (!Number.isFinite(days) || days < 1 || days > 365) days = 30;
    const since = daysAgoIso(days);

    const all = await db
      .select()
      .from(pulloutsTable)
      .where(
        and(
          eq(pulloutsTable.schoolId, req.schoolId!),
          gte(pulloutsTable.requestedAt, since),
        ),
      )
      .orderBy(desc(pulloutsTable.requestedAt));

    type Counters = {
      total: number;
      pending: number;
      verified: number;
      arrived: number;
      returned: number;
      closed: number;
      rejected: number;
    };
    const empty = (): Counters => ({
      total: 0,
      pending: 0,
      verified: 0,
      arrived: 0,
      returned: 0,
      closed: 0,
      rejected: 0,
    });
    const bump = (c: Counters, status: string) => {
      c.total += 1;
      if (status === "pending") c.pending += 1;
      else if (status === "verified" || status === "enroute")
        c.verified += 1;
      else if (status === "arrived") c.arrived += 1;
      else if (status === "returned") c.returned += 1;
      else if (status === "closed") c.closed += 1;
      else if (status === "rejected") c.rejected += 1;
    };

    const byStudent = new Map<string, Counters>();
    const byTeacher = new Map<string, Counters>();
    const byReason = new Map<string, Counters>();

    for (const r of all) {
      if (!byStudent.has(r.studentId)) byStudent.set(r.studentId, empty());
      bump(byStudent.get(r.studentId)!, r.status);

      const teacher = r.referringTeacherName || "(unspecified)";
      if (!byTeacher.has(teacher)) byTeacher.set(teacher, empty());
      bump(byTeacher.get(teacher)!, r.status);

      // Bucket reason by lowercased first 60 chars to group near-duplicates.
      const text = (r.editedReason ?? r.reason).trim();
      const bucket =
        text.length > 60 ? text.slice(0, 57) + "…" : text || "(no reason)";
      const key = bucket.toLowerCase();
      if (!byReason.has(key)) byReason.set(key, empty());
      bump(byReason.get(key)!, r.status);
    }

    const toSorted = <K extends string | number>(
      m: Map<string, Counters>,
      keyName: K,
    ) =>
      Array.from(m.entries())
        .map(([k, c]) => ({ [keyName]: k, ...c }))
        .sort((a, b) => b.total - a.total);

    res.json({
      windowDays: days,
      sinceIso: since,
      total: all.length,
      byStudent: toSorted(byStudent, "studentId" as const),
      byTeacher: toSorted(byTeacher, "referringTeacherName" as const),
      byReason: toSorted(byReason, "reason" as const),
    });
  },
);

// ISS dashboard actions: mark arrived / returned / closed.
const isIssActor = (s: StaffRow) =>
  s.isSuperUser ||
  s.isAdmin ||
  s.isIssTeacher ||
  s.isBehaviorSpecialist ||
  s.isDean ||
  s.isMtssCoordinator;

router.patch(
  "/pullouts/:id/arrived",
  requireStaffMW(isIssActor, "ISS dashboard role"),
  async (req: Request, res: Response) => {
    const staff = (req as Request & { staff: StaffRow }).staff;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [existing] = await db
      .select()
      .from(pulloutsTable)
      .where(and(eq(pulloutsTable.id, id), eq(pulloutsTable.schoolId, req.schoolId!)));
    if (!existing) {
      res.status(404).json({ error: "Pullout not found" });
      return;
    }
    if (existing.status !== "verified" && existing.status !== "enroute") {
      res.status(409).json({
        error: `Pullout is ${existing.status}; only verified or en-route pullouts can be marked arrived.`,
      });
      return;
    }
    const nowIso = new Date().toISOString();
    await db
      .update(pulloutsTable)
      .set({
        status: "arrived",
        arrivedAt: nowIso,
        arrivedById: staff.id,
        arrivedByName: staff.displayName,
      })
      .where(and(eq(pulloutsTable.id, id), eq(pulloutsTable.schoolId, req.schoolId!)));
    // Send parent email synchronously so the operator sees the result.
    const emailResult = await sendPulloutArrivalEmail(id);
    if (emailResult && emailResult.status === "error") {
      console.error(
        `[pullouts] arrival email failed (pulloutId=${id}):`,
        emailResult.errorMsg,
      );
    }
    // Add to ISS roster (idempotent via unique pullout_id index).
    try {
      const existingRoster = await db
        .select()
        .from(issRosterTable)
        .where(eq(issRosterTable.pulloutId, id));
      if (existingRoster.length === 0) {
        await db.insert(issRosterTable).values({
          // D5: stamp schoolId from the parent pullout so the roster row is
          // tenant-scoped (otherwise DB DEFAULT 1 would mis-tenant non-Parrott
          // arrivals).
          schoolId: existing.schoolId,
          studentId: existing.studentId,
          source: "pullout",
          pulloutId: id,
          period: existing.period,
          notes: null,
          addedById: staff.id,
          addedByName: staff.displayName,
        });
      }
    } catch (e) {
      console.error("[iss-roster] auto-insert failed:", e);
    }
    try {
      await upsertIssAttendance({
        studentId: existing.studentId,
        schoolId: existing.schoolId,
        source: "pullout",
        pulloutId: id,
        dispatchedByName: existing.referringTeacherName ?? null,
        verifiedByName: existing.verifiedByName ?? null,
        addedById: staff.id,
        addedByName: staff.displayName,
      });
    } catch (e) {
      console.error("[iss-attendance] auto-upsert failed:", e);
    }
    const [row] = await db
      .select()
      .from(pulloutsTable)
      .where(and(eq(pulloutsTable.id, id), eq(pulloutsTable.schoolId, req.schoolId!)));
    res.json({ pullout: row, parentEmail: emailResult });
  },
);

router.patch(
  "/pullouts/:id/returned",
  requireStaffMW(isIssActor, "ISS dashboard role"),
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [existing] = await db
      .select()
      .from(pulloutsTable)
      .where(and(eq(pulloutsTable.id, id), eq(pulloutsTable.schoolId, req.schoolId!)));
    if (!existing) {
      res.status(404).json({ error: "Pullout not found" });
      return;
    }
    if (existing.status !== "arrived") {
      res.status(409).json({
        error: `Pullout is ${existing.status}; only arrived pullouts can be marked returned.`,
      });
      return;
    }
    const [row] = await db
      .update(pulloutsTable)
      .set({ status: "returned", returnedAt: new Date().toISOString() })
      .where(and(eq(pulloutsTable.id, id), eq(pulloutsTable.schoolId, req.schoolId!)))
      .returning();
    // Persist the canonical Return-to-Class parent string so a future
    // SMS sender can read it back without re-deriving. The actual
    // email body is built inside sendPulloutReturnEmail.
    // TODO(SMS): when Twilio is configured, also send `return_message`
    // via SMS to verified parent phone numbers on file.
    try {
      await db
        .update(pulloutsTable)
        .set({
          returnMessage: `Your student has returned to their regular class schedule.`,
        })
        .where(
          and(
            eq(pulloutsTable.id, id),
            eq(pulloutsTable.schoolId, req.schoolId!),
          ),
        );
    } catch (e) {
      console.error("[pullouts] could not stash return_message:", e);
    }
    // Remove from ISS roster + send parent return email.
    try {
      await db.delete(issRosterTable).where(eq(issRosterTable.pulloutId, id));
    } catch (e) {
      console.error("[iss-roster] auto-remove failed:", e);
    }
    const parentEmail = await sendPulloutReturnEmail(id);
    if (parentEmail && parentEmail.status === "error") {
      console.error(
        `[pullouts] return email failed (pulloutId=${id}):`,
        parentEmail.errorMsg,
      );
    }
    res.json({ pullout: row, parentEmail });
  },
);

router.patch(
  "/pullouts/:id/closed",
  requireStaffMW(isIssActor, "ISS dashboard role"),
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [existing] = await db
      .select()
      .from(pulloutsTable)
      .where(and(eq(pulloutsTable.id, id), eq(pulloutsTable.schoolId, req.schoolId!)));
    if (!existing) {
      res.status(404).json({ error: "Pullout not found" });
      return;
    }
    if (
      existing.status === "closed" ||
      existing.status === "rejected"
    ) {
      res.status(409).json({
        error: `Pullout is already ${existing.status}.`,
      });
      return;
    }
    const [row] = await db
      .update(pulloutsTable)
      .set({ status: "closed", closedAt: new Date().toISOString() })
      .where(and(eq(pulloutsTable.id, id), eq(pulloutsTable.schoolId, req.schoolId!)))
      .returning();
    res.json(row);
  },
);

// Behavior Specialist / Admin: mark a closed pullout as reviewed.
router.patch(
  "/pullouts/:id/review",
  requireStaffMW(
    (s) => s.isSuperUser || s.isAdmin || s.isBehaviorSpecialist,
    "Behavior specialist or admin",
  ),
  async (req: Request, res: Response) => {
    const staff = (req as Request & { staff: StaffRow }).staff;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const reviewNotesRaw = req.body?.reviewNotes;
    const reviewNotes =
      typeof reviewNotesRaw === "string" && reviewNotesRaw.trim()
        ? reviewNotesRaw.trim().slice(0, 2000)
        : null;

    const [existing] = await db
      .select()
      .from(pulloutsTable)
      .where(and(eq(pulloutsTable.id, id), eq(pulloutsTable.schoolId, req.schoolId!)));
    if (!existing) {
      res.status(404).json({ error: "Pullout not found" });
      return;
    }
    if (existing.status !== "closed") {
      res.status(409).json({
        error: `Pullout is ${existing.status}; only closed pullouts can be reviewed.`,
      });
      return;
    }
    if (existing.reviewedAt != null) {
      res
        .status(409)
        .json({ error: "Pullout has already been reviewed." });
      return;
    }
    const [row] = await db
      .update(pulloutsTable)
      .set({
        reviewedAt: new Date().toISOString(),
        reviewedById: staff.id,
        reviewedByName: staff.displayName,
        reviewNotes,
      })
      .where(and(eq(pulloutsTable.id, id), eq(pulloutsTable.schoolId, req.schoolId!)))
      .returning();
    res.json(row);
  },
);

export default router;
