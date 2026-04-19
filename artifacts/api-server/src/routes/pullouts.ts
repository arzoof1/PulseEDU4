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
  interventionEntriesTable,
} from "@workspace/db";
import { eq, and, gte, desc } from "drizzle-orm";
import { sendPulloutArrivalEmail } from "../lib/pulloutEmail";

const router: IRouter = Router();

type StaffRow = typeof staffTable.$inferSelect;

async function loadStaff(req: Request): Promise<StaffRow | null> {
  const id = req.session.staffId;
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
async function hasRecentIntervention(studentId: string): Promise<boolean> {
  const since = daysAgoIso(INTERVENTION_WINDOW_DAYS);
  const rows = await db
    .select({ id: interventionEntriesTable.id })
    .from(interventionEntriesTable)
    .where(
      and(
        eq(interventionEntriesTable.studentId, studentId),
        gte(interventionEntriesTable.createdAt, since),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

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
    const has = await hasRecentIntervention(studentId);
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

    const isVerifier =
      staff.isAdmin || staff.isDean || staff.isMtssCoordinator;
    const isIssView =
      staff.isAdmin ||
      staff.isIssTeacher ||
      staff.isBehaviorSpecialist ||
      staff.isDean ||
      staff.isMtssCoordinator;
    const isReviewer = staff.isAdmin || staff.isBehaviorSpecialist;

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

    const all = await db
      .select()
      .from(pulloutsTable)
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
    }
    res.json(rows);
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

    const has = await hasRecentIntervention(studentId.trim());
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
      (staff.isAdmin || staff.isDean || staff.isMtssCoordinator) &&
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
    res.status(201).json(row);
  },
);

// Verifier (admin / dean / MTSS) actions.
const isVerifier = (s: StaffRow) =>
  s.isAdmin || s.isDean || s.isMtssCoordinator;

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
    }: {
      editedReason?: unknown;
      period?: unknown;
      referringTeacherName?: unknown;
    } = req.body ?? {};

    const [existing] = await db
      .select()
      .from(pulloutsTable)
      .where(eq(pulloutsTable.id, id));
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

    const [row] = await db
      .update(pulloutsTable)
      .set(updates)
      .where(eq(pulloutsTable.id, id))
      .returning();
    res.json(row);
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
      .where(eq(pulloutsTable.id, id));
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
      .where(eq(pulloutsTable.id, id))
      .returning();
    res.json(row);
  },
);

// ISS dashboard actions: mark arrived / returned / closed.
const isIssActor = (s: StaffRow) =>
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
      .where(eq(pulloutsTable.id, id));
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
      .where(eq(pulloutsTable.id, id));
    // Send parent email synchronously so the operator sees the result.
    const emailResult = await sendPulloutArrivalEmail(id);
    const [row] = await db
      .select()
      .from(pulloutsTable)
      .where(eq(pulloutsTable.id, id));
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
      .where(eq(pulloutsTable.id, id));
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
      .where(eq(pulloutsTable.id, id))
      .returning();
    res.json(row);
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
      .where(eq(pulloutsTable.id, id));
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
      .where(eq(pulloutsTable.id, id))
      .returning();
    res.json(row);
  },
);

export default router;
