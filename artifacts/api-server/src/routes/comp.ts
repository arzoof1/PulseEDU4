// Comp Time (FLSA compensatory time) — non-exempt-only earn/use bank.
//
// Mirrors AST (artifacts/api-server/src/routes/ast.ts) one-for-one on
// the request lifecycle, with these material differences:
//
//   * Eligibility gate: staff.exempt_status must be 'non_exempt'. The
//     route returns 403 with `{ error: 'not_eligible', refer: 'AST' }`
//     for anyone else so the client can render the "refer to AST"
//     splash.
//   * Earn math: 1.5x hours worked over 40/week. Workweek anchor is
//     read from school_settings.workweek_start ('sunday' | 'monday').
//     The submit handler validates `weekStartDate` lines up with that.
//   * 240-hour cap (FLSA): admin-confirm rejects with 409
//     `{ error: 'would_exceed_cap', currentBalanceQh, capQh }` when
//     a credit would push the running balance over 240.
//   * Authorization form: when school_settings.comp_time_require_auth_form
//     is true (default), every earn submit must reference an uploaded
//     object key in /api/storage/* (re-using bindObjectToSchool).
//   * No annual lapse cron — comp-time is contractually banked.
//   * Transfer + payout: paired ledger rows (transfer_in / transfer_out,
//     payout) keep the bank consistent.

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
  schoolsTable,
  schoolSettingsTable,
  staffCompRequestsTable,
  staffCompLedgerTable,
  COMP_TIME_MAX_QH,
  COMP_TIME_MULTIPLIER_NUM,
  COMP_TIME_MULTIPLIER_DEN,
  COMP_TIME_WEEK_THRESHOLD_QH,
} from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import { canApproveCompTime, canSubmitCompTime } from "../lib/coreTeam.js";
import { bindObjectToSchool } from "./storage.js";

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

const requireAnyStaff = requireStaffMW();
const requireApprover = requireStaffMW(canApproveCompTime, "Comp Time approver");

function getStaff(req: Request): StaffRow {
  return (req as Request & { staff: StaffRow }).staff;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------
function parseQuarterHours(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (!Number.isInteger(n)) return null;
  if (n <= 0 || n > 4 * 24 * 31) return null;
  return n;
}

// Compute the FLSA 1.5x credit on overflow above 40/week. Inputs in
// quarter-hours; output in quarter-hours. We use ceiling against the
// multiplier (3/2) so any odd quarter-hour produces a fair round-up
// for the employee (FLSA boundary case favors the worker).
function computeOvertimeCreditQh(hoursWorkedQh: number): number {
  const overflow = Math.max(0, hoursWorkedQh - COMP_TIME_WEEK_THRESHOLD_QH);
  if (overflow === 0) return 0;
  return Math.ceil(
    (overflow * COMP_TIME_MULTIPLIER_NUM) / COMP_TIME_MULTIPLIER_DEN,
  );
}

// ISO YYYY-MM-DD must be a workweek anchor for the school. We validate
// shape here and let the route decide whether to enforce alignment
// (Sundays-only or Mondays-only) — some districts choose to file
// requests against a Monday even when the legal workweek starts
// Sunday. The product call documented in routes/comp.ts header is:
// validate shape strictly, log a warning on misalignment, but accept.
function isIsoDate(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

// JS Date.getUTCDay(): 0 = Sunday, 1 = Monday, ...
function workweekDayIndex(workweekStart: string): number {
  return workweekStart === "monday" ? 1 : 0;
}

// Sum the live ledger balance for (school, staff). Comp Time is
// school-scoped (NOT district-wide like AST) — FLSA + most payroll
// systems calculate per-employer. A district-wide rollup is a Phase 2
// follow-up if any tenant pushes back.
async function balanceQuarterHours(
  schoolId: number,
  staffId: number,
): Promise<number> {
  const [row] = await db
    .select({
      total: sql<number>`COALESCE(SUM(${staffCompLedgerTable.deltaQuarterHours}), 0)::int`,
    })
    .from(staffCompLedgerTable)
    .where(
      and(
        eq(staffCompLedgerTable.schoolId, schoolId),
        eq(staffCompLedgerTable.staffId, staffId),
      ),
    );
  return Number(row?.total ?? 0);
}

async function schoolSettings(schoolId: number) {
  const [row] = await db
    .select()
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, schoolId))
    .limit(1);
  return row;
}

// ---------------------------------------------------------------------------
// READ — staff side
// ---------------------------------------------------------------------------
router.get(
  "/comp/me",
  requireAnyStaff,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const me = getStaff(req);

    if (!canSubmitCompTime(me)) {
      // Eligibility splash payload. Keeps the page rendering for
      // exempt staff (they may be principals checking on the queue);
      // the client uses `eligible: false` to swap to the "refer to
      // AST" copy.
      res.json({
        eligible: false,
        canApproveCompTime: canApproveCompTime(me),
        balanceQuarterHours: 0,
        needsCompletion: 0,
        requests: [],
      });
      return;
    }

    const [balance, requests, settings] = await Promise.all([
      balanceQuarterHours(schoolId, me.id),
      db
        .select()
        .from(staffCompRequestsTable)
        .where(
          and(
            eq(staffCompRequestsTable.schoolId, schoolId),
            eq(staffCompRequestsTable.staffId, me.id),
          ),
        )
        .orderBy(desc(staffCompRequestsTable.createdAt))
        .limit(200),
      schoolSettings(schoolId),
    ]);

    const needsCompletion = requests.filter(
      (r) => r.kind === "earn" && r.state === "preapproved",
    ).length;

    res.json({
      eligible: true,
      balanceQuarterHours: balance,
      capQuarterHours: COMP_TIME_MAX_QH,
      canApproveCompTime: canApproveCompTime(me),
      needsCompletion,
      requests,
      workweekStart: settings?.workweekStart ?? "sunday",
      requireAuthForm: settings?.compTimeRequireAuthForm ?? true,
      authFormTemplateObjectKey:
        settings?.compTimeAuthFormObjectKey ?? null,
    });
  },
);

// ---------------------------------------------------------------------------
// READ — admin queue
// ---------------------------------------------------------------------------
router.get(
  "/comp/admin-queue",
  requireApprover,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;

    const rows = await db
      .select({
        request: staffCompRequestsTable,
        staffName: staffTable.displayName,
        staffExemptStatus: staffTable.exemptStatus,
      })
      .from(staffCompRequestsTable)
      .leftJoin(staffTable, eq(staffTable.id, staffCompRequestsTable.staffId))
      .where(eq(staffCompRequestsTable.schoolId, schoolId))
      .orderBy(desc(staffCompRequestsTable.createdAt))
      .limit(500);

    const earnPreapprovals = rows.filter(
      (r) =>
        r.request.kind === "earn" &&
        r.request.state === "pending_preapproval",
    );
    const completionConfirms = rows.filter(
      (r) =>
        r.request.kind === "earn" && r.request.state === "pending_confirm",
    );
    const useApprovals = rows.filter(
      (r) =>
        r.request.kind === "use" &&
        r.request.state === "pending_preapproval",
    );

    res.json({
      counts: {
        earnPreapprovals: earnPreapprovals.length,
        completionConfirms: completionConfirms.length,
        useApprovals: useApprovals.length,
        total:
          earnPreapprovals.length +
          completionConfirms.length +
          useApprovals.length,
      },
      earnPreapprovals,
      completionConfirms,
      useApprovals,
      recent: rows
        .filter(
          (r) =>
            r.request.state === "confirmed" ||
            r.request.state === "denied" ||
            (r.request.kind === "use" && r.request.state === "preapproved"),
        )
        .slice(0, 50),
    });
  },
);

router.get(
  "/comp/admin-pending-count",
  requireAnyStaff,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const me = getStaff(req);
    if (!canApproveCompTime(me)) {
      res.json({ count: 0 });
      return;
    }
    const [row] = await db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(staffCompRequestsTable)
      .where(
        and(
          eq(staffCompRequestsTable.schoolId, schoolId),
          sql`(
            (${staffCompRequestsTable.kind} = 'earn'
              AND ${staffCompRequestsTable.state} IN ('pending_preapproval','pending_confirm'))
            OR
            (${staffCompRequestsTable.kind} = 'use'
              AND ${staffCompRequestsTable.state} = 'pending_preapproval')
          )`,
        ),
      );
    res.json({ count: Number(row?.n ?? 0) });
  },
);

router.get(
  "/comp/my-actionable-count",
  requireAnyStaff,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const me = getStaff(req);
    const [row] = await db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(staffCompRequestsTable)
      .where(
        and(
          eq(staffCompRequestsTable.schoolId, schoolId),
          eq(staffCompRequestsTable.staffId, me.id),
          sql`${staffCompRequestsTable.staffAcknowledgedAt} IS NULL`,
          sql`(
            ${staffCompRequestsTable.preapprovedAt} IS NOT NULL
            OR ${staffCompRequestsTable.deniedAt} IS NOT NULL
            OR ${staffCompRequestsTable.confirmedAt} IS NOT NULL
          )`,
        ),
      );
    res.json({ count: Number(row?.n ?? 0) });
  },
);

router.post(
  "/comp/acknowledge",
  requireAnyStaff,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const me = getStaff(req);
    await db
      .update(staffCompRequestsTable)
      .set({ staffAcknowledgedAt: new Date() })
      .where(
        and(
          eq(staffCompRequestsTable.schoolId, schoolId),
          eq(staffCompRequestsTable.staffId, me.id),
          sql`${staffCompRequestsTable.staffAcknowledgedAt} IS NULL`,
          sql`(
            ${staffCompRequestsTable.preapprovedAt} IS NOT NULL
            OR ${staffCompRequestsTable.deniedAt} IS NOT NULL
            OR ${staffCompRequestsTable.confirmedAt} IS NOT NULL
          )`,
        ),
      );
    res.json({ ok: true });
  },
);

// ---------------------------------------------------------------------------
// EARN — submit
// ---------------------------------------------------------------------------
router.post(
  "/comp/earn",
  requireAnyStaff,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const me = getStaff(req);
    if (!canSubmitCompTime(me)) {
      res
        .status(403)
        .json({ error: "not_eligible", refer: "AST" });
      return;
    }

    const weekStartDate = String(req.body?.weekStartDate ?? "").trim();
    const reason = String(req.body?.reason ?? "").trim();
    const hoursWorkedQh = parseQuarterHours(req.body?.hoursWorkedQh);
    const authFormObjectKey =
      String(req.body?.authFormObjectKey ?? "").trim() || null;
    const timesheetConfirmed = Boolean(req.body?.timesheetConfirmed);
    const priorSupervisorApprovalConfirmed = Boolean(
      req.body?.priorSupervisorApprovalConfirmed,
    );

    if (!isIsoDate(weekStartDate)) {
      res
        .status(400)
        .json({ error: "Workweek start date is required (YYYY-MM-DD)" });
      return;
    }
    if (!reason) {
      res
        .status(400)
        .json({ error: "Reason is required (storm cleanup, conferences, etc.)" });
      return;
    }
    if (hoursWorkedQh === null) {
      res
        .status(400)
        .json({
          error: "Hours worked must be a positive multiple of ¼ hour",
        });
      return;
    }
    if (hoursWorkedQh <= COMP_TIME_WEEK_THRESHOLD_QH) {
      // 40 h or under = no overflow, no comp credit.
      res.status(400).json({
        error: "no_overflow",
        message:
          "Comp time only accrues on hours WORKED OVER 40 in a single workweek (FLSA).",
        weekThresholdQh: COMP_TIME_WEEK_THRESHOLD_QH,
      });
      return;
    }
    if (!timesheetConfirmed) {
      res.status(400).json({
        error: "timesheet_unconfirmed",
        message:
          "You must confirm these hours are recorded on your timesheet before submitting.",
      });
      return;
    }
    if (!priorSupervisorApprovalConfirmed) {
      res.status(400).json({
        error: "prior_approval_unconfirmed",
        message:
          "FLSA requires prior supervisor approval BEFORE working overflow hours. Confirm or work with your supervisor.",
      });
      return;
    }

    const settings = await schoolSettings(schoolId);
    if (settings?.compTimeRequireAuthForm && !authFormObjectKey) {
      res.status(400).json({
        error: "auth_form_required",
        message:
          "Signed Authorization to Accrue Comp Time is required. Download the template in Settings → Time Tracking, sign it, and re-upload.",
      });
      return;
    }

    // Workweek alignment — hard reject. FLSA 1.5x math is meaningful
    // only when the 7-day window starts on the school's configured
    // workweek anchor (Sun or Mon). A misaligned date would compute
    // overtime against the wrong window.
    {
      const d = new Date(`${weekStartDate}T00:00:00Z`);
      const ww = workweekDayIndex(settings?.workweekStart ?? "sunday");
      if (d.getUTCDay() !== ww) {
        res.status(400).json({
          error: "weekStartDate_misaligned",
          message: `Week start date must fall on ${
            (settings?.workweekStart ?? "sunday") === "monday"
              ? "Monday"
              : "Sunday"
          }, matching this school's workweek anchor (Settings → Time Tracking).`,
        });
        return;
      }
    }

    // Bind the uploaded auth form to this school so it can't be a
    // spoofed/cross-tenant object path. Skip when the form isn't
    // required and the staff member didn't upload one.
    if (authFormObjectKey) {
      const bound = await bindObjectToSchool(authFormObjectKey, schoolId);
      if (!bound) {
        res.status(400).json({
          error: "auth_form_invalid",
          message:
            "Uploaded authorization form could not be verified. Please re-upload.",
        });
        return;
      }
    }

    const computedCreditQh = computeOvertimeCreditQh(hoursWorkedQh);

    const [row] = await db
      .insert(staffCompRequestsTable)
      .values({
        schoolId,
        staffId: me.id,
        kind: "earn",
        state: "pending_preapproval",
        weekStartDate,
        reason,
        hoursWorkedQh,
        computedCreditQh,
        quarterHoursRequested: computedCreditQh,
        authFormObjectKey,
        timesheetConfirmed,
        priorSupervisorApprovalConfirmed,
      })
      .returning();
    req.log.info(
      { requestId: row?.id, staffId: me.id, hoursWorkedQh, computedCreditQh },
      "comp earn submitted",
    );
    res.json({ ok: true, request: row });
  },
);

// ---------------------------------------------------------------------------
// EARN — admin pre-approve / deny
// ---------------------------------------------------------------------------
router.patch(
  "/comp/earn/:id/preapprove",
  requireApprover,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const me = getStaff(req);
    const id = Number(req.params["id"]);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Bad id" });
      return;
    }
    const decision = String(req.body?.decision ?? "");
    const note = String(req.body?.note ?? "").trim() || null;

    if (decision !== "approve" && decision !== "deny") {
      res
        .status(400)
        .json({ error: "decision must be 'approve' or 'deny'" });
      return;
    }
    if (decision === "deny" && !note) {
      res
        .status(400)
        .json({ error: "Denial note is required so staff can re-request" });
      return;
    }

    const [existing] = await db
      .select()
      .from(staffCompRequestsTable)
      .where(
        and(
          eq(staffCompRequestsTable.id, id),
          eq(staffCompRequestsTable.schoolId, schoolId),
        ),
      );
    if (!existing) {
      res.status(404).json({ error: "Request not found" });
      return;
    }
    if (existing.kind !== "earn" || existing.state !== "pending_preapproval") {
      res.status(409).json({
        error: `Request is not awaiting pre-approval (state=${existing.state})`,
      });
      return;
    }

    const now = new Date();
    const [updated] = await db
      .update(staffCompRequestsTable)
      .set(
        decision === "approve"
          ? {
              state: "preapproved",
              preapprovedAt: now,
              preapprovedByStaffId: me.id,
              preapprovalNote: note,
            }
          : {
              state: "denied",
              deniedAt: now,
              deniedByStaffId: me.id,
              denyNote: note,
            },
      )
      .where(eq(staffCompRequestsTable.id, id))
      .returning();
    res.json({ ok: true, request: updated });
  },
);

// ---------------------------------------------------------------------------
// EARN — staff submits completion
// ---------------------------------------------------------------------------
router.post(
  "/comp/earn/:id/complete",
  requireAnyStaff,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const me = getStaff(req);
    const id = Number(req.params["id"]);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Bad id" });
      return;
    }
    const actualHoursWorkedQh = parseQuarterHours(req.body?.hoursWorkedQh);
    const note = String(req.body?.note ?? "").trim() || null;

    if (actualHoursWorkedQh === null) {
      res
        .status(400)
        .json({ error: "Actual hours worked must be a positive multiple of ¼ hour" });
      return;
    }
    if (actualHoursWorkedQh <= COMP_TIME_WEEK_THRESHOLD_QH) {
      res.status(400).json({
        error: "no_overflow",
        message:
          "Actual hours did not exceed 40/week — no comp credit. Cancel this request.",
      });
      return;
    }

    const [existing] = await db
      .select()
      .from(staffCompRequestsTable)
      .where(
        and(
          eq(staffCompRequestsTable.id, id),
          eq(staffCompRequestsTable.schoolId, schoolId),
        ),
      );
    if (!existing) {
      res.status(404).json({ error: "Request not found" });
      return;
    }
    if (existing.staffId !== me.id) {
      res.status(403).json({ error: "Not your request" });
      return;
    }
    if (existing.kind !== "earn" || existing.state !== "preapproved") {
      res.status(409).json({
        error: `Request is not in the pre-approved state (state=${existing.state})`,
      });
      return;
    }

    const actualCreditQh = computeOvertimeCreditQh(actualHoursWorkedQh);

    const [updated] = await db
      .update(staffCompRequestsTable)
      .set({
        state: "pending_confirm",
        hoursWorkedQh: actualHoursWorkedQh,
        computedCreditQh: actualCreditQh,
        quarterHoursActual: actualCreditQh,
        completionSubmittedAt: new Date(),
        completionNote: note,
      })
      .where(eq(staffCompRequestsTable.id, id))
      .returning();
    res.json({ ok: true, request: updated });
  },
);

// ---------------------------------------------------------------------------
// EARN — admin confirms / denies completion → posts ledger row on confirm.
// Enforces the 240h cap here.
// ---------------------------------------------------------------------------
router.patch(
  "/comp/earn/:id/confirm",
  requireApprover,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const me = getStaff(req);
    const id = Number(req.params["id"]);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Bad id" });
      return;
    }
    const decision = String(req.body?.decision ?? "");
    const note = String(req.body?.note ?? "").trim() || null;
    const overrideQhRaw = req.body?.quarterHours;
    const overrideQh =
      overrideQhRaw == null ? null : parseQuarterHours(overrideQhRaw);
    if (decision === "approve" && overrideQhRaw != null && overrideQh === null) {
      res.status(400).json({
        error: "Override credit must be a positive multiple of ¼ hour",
      });
      return;
    }
    if (decision !== "approve" && decision !== "deny") {
      res
        .status(400)
        .json({ error: "decision must be 'approve' or 'deny'" });
      return;
    }
    if (decision === "deny" && !note) {
      res
        .status(400)
        .json({ error: "Denial note is required so staff can re-request" });
      return;
    }

    const result = await db.transaction(async (tx) => {
      // Lock the request row to serialize concurrent approvals.
      const [existing] = await tx
        .select()
        .from(staffCompRequestsTable)
        .where(
          and(
            eq(staffCompRequestsTable.id, id),
            eq(staffCompRequestsTable.schoolId, schoolId),
          ),
        )
        .for("update");
      if (!existing) {
        return { status: 404 as const, body: { error: "Request not found" } };
      }
      if (existing.kind !== "earn" || existing.state !== "pending_confirm") {
        return {
          status: 409 as const,
          body: {
            error: `Request is not awaiting completion confirm (state=${existing.state})`,
          },
        };
      }

      if (decision === "deny") {
        const [updated] = await tx
          .update(staffCompRequestsTable)
          .set({
            state: "denied",
            deniedAt: new Date(),
            deniedByStaffId: me.id,
            denyNote: note,
          })
          .where(eq(staffCompRequestsTable.id, id))
          .returning();
        return { status: 200 as const, body: { ok: true, request: updated } };
      }

      // APPROVE path — enforce 240h cap on running balance.
      const creditQh =
        overrideQh ?? existing.quarterHoursActual ?? existing.computedCreditQh ?? 0;
      if (creditQh <= 0) {
        return {
          status: 400 as const,
          body: { error: "Computed credit is zero — denied or cancel instead" },
        };
      }
      const [balRow] = await tx
        .select({
          total: sql<number>`COALESCE(SUM(${staffCompLedgerTable.deltaQuarterHours}), 0)::int`,
        })
        .from(staffCompLedgerTable)
        .where(
          and(
            eq(staffCompLedgerTable.schoolId, schoolId),
            eq(staffCompLedgerTable.staffId, existing.staffId),
          ),
        );
      const currentBalanceQh = Number(balRow?.total ?? 0);
      if (currentBalanceQh + creditQh > COMP_TIME_MAX_QH) {
        return {
          status: 409 as const,
          body: {
            error: "would_exceed_cap",
            message: `Crediting ${creditQh / 4} h would push the balance over the 240 h FLSA cap. Pay the excess via payroll.`,
            currentBalanceQh,
            creditQh,
            capQh: COMP_TIME_MAX_QH,
          },
        };
      }

      const now = new Date();
      const [updated] = await tx
        .update(staffCompRequestsTable)
        .set({
          state: "confirmed",
          confirmedAt: now,
          confirmedByStaffId: me.id,
          confirmNote: note,
          quarterHoursActual: creditQh,
        })
        .where(eq(staffCompRequestsTable.id, id))
        .returning();

      await tx.insert(staffCompLedgerTable).values({
        schoolId,
        staffId: existing.staffId,
        deltaQuarterHours: creditQh,
        kind: "earn_confirm",
        requestId: id,
        note: note ?? null,
        createdByStaffId: me.id,
      });

      return { status: 200 as const, body: { ok: true, request: updated } };
    });

    res.status(result.status).json(result.body);
  },
);

// ---------------------------------------------------------------------------
// USE — submit
// ---------------------------------------------------------------------------
router.post(
  "/comp/use",
  requireAnyStaff,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const me = getStaff(req);
    if (!canSubmitCompTime(me)) {
      res.status(403).json({ error: "not_eligible", refer: "AST" });
      return;
    }
    const startAtRaw = String(req.body?.startAt ?? "");
    const endAtRaw = String(req.body?.endAt ?? "");
    const startAt = new Date(startAtRaw);
    const endAt = new Date(endAtRaw);
    if (
      !Number.isFinite(startAt.getTime()) ||
      !Number.isFinite(endAt.getTime())
    ) {
      res
        .status(400)
        .json({ error: "Start/end must be valid ISO timestamps" });
      return;
    }
    if (endAt.getTime() <= startAt.getTime()) {
      res.status(400).json({ error: "End must be after start" });
      return;
    }
    const minutes = Math.round((endAt.getTime() - startAt.getTime()) / 60000);
    if (minutes <= 0 || minutes % 15 !== 0) {
      res
        .status(400)
        .json({ error: "Use window must be a multiple of 15 minutes" });
      return;
    }
    const qh = minutes / 15;

    const [row] = await db
      .insert(staffCompRequestsTable)
      .values({
        schoolId,
        staffId: me.id,
        kind: "use",
        state: "pending_preapproval",
        useStartAt: startAt,
        useEndAt: endAt,
        quarterHoursRequested: qh,
      })
      .returning();
    res.json({ ok: true, request: row });
  },
);

// ---------------------------------------------------------------------------
// USE — admin approve / deny (debit on approve, with balance check)
// ---------------------------------------------------------------------------
router.patch(
  "/comp/use/:id/decide",
  requireApprover,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const me = getStaff(req);
    const id = Number(req.params["id"]);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Bad id" });
      return;
    }
    const decision = String(req.body?.decision ?? "");
    const note = String(req.body?.note ?? "").trim() || null;

    if (decision !== "approve" && decision !== "deny") {
      res
        .status(400)
        .json({ error: "decision must be 'approve' or 'deny'" });
      return;
    }
    if (decision === "deny" && !note) {
      res
        .status(400)
        .json({ error: "Denial note is required so staff can re-request" });
      return;
    }

    const result = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(staffCompRequestsTable)
        .where(
          and(
            eq(staffCompRequestsTable.id, id),
            eq(staffCompRequestsTable.schoolId, schoolId),
          ),
        )
        .for("update");
      if (!existing) {
        return { status: 404 as const, body: { error: "Request not found" } };
      }
      if (existing.kind !== "use" || existing.state !== "pending_preapproval") {
        return {
          status: 409 as const,
          body: {
            error: `Request is not awaiting approval (state=${existing.state})`,
          },
        };
      }

      if (decision === "deny") {
        const [updated] = await tx
          .update(staffCompRequestsTable)
          .set({
            state: "denied",
            deniedAt: new Date(),
            deniedByStaffId: me.id,
            denyNote: note,
          })
          .where(eq(staffCompRequestsTable.id, id))
          .returning();
        return { status: 200 as const, body: { ok: true, request: updated } };
      }

      // APPROVE — debit immediately, never allow negative.
      const debitQh = existing.quarterHoursRequested;
      const [balRow] = await tx
        .select({
          total: sql<number>`COALESCE(SUM(${staffCompLedgerTable.deltaQuarterHours}), 0)::int`,
        })
        .from(staffCompLedgerTable)
        .where(
          and(
            eq(staffCompLedgerTable.schoolId, schoolId),
            eq(staffCompLedgerTable.staffId, existing.staffId),
          ),
        );
      const balance = Number(balRow?.total ?? 0);
      if (balance < debitQh) {
        return {
          status: 409 as const,
          body: {
            error: "insufficient_balance",
            balanceQh: balance,
            requestedQh: debitQh,
            message: `Approving would overdraw the bank (balance ${(balance / 4).toFixed(2)} h, requested ${(debitQh / 4).toFixed(2)} h). Deny instead.`,
          },
        };
      }

      const now = new Date();
      const [updated] = await tx
        .update(staffCompRequestsTable)
        .set({
          state: "preapproved",
          preapprovedAt: now,
          preapprovedByStaffId: me.id,
          preapprovalNote: note,
        })
        .where(eq(staffCompRequestsTable.id, id))
        .returning();

      await tx.insert(staffCompLedgerTable).values({
        schoolId,
        staffId: existing.staffId,
        deltaQuarterHours: -debitQh,
        kind: "use_approval",
        requestId: id,
        note: note ?? null,
        createdByStaffId: me.id,
      });

      return { status: 200 as const, body: { ok: true, request: updated } };
    });

    res.status(result.status).json(result.body);
  },
);

// ---------------------------------------------------------------------------
// CANCEL — staff cancels their own pending request
// ---------------------------------------------------------------------------
router.post(
  "/comp/:id/cancel",
  requireAnyStaff,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const me = getStaff(req);
    const id = Number(req.params["id"]);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Bad id" });
      return;
    }
    const note = String(req.body?.note ?? "").trim() || null;

    const [existing] = await db
      .select()
      .from(staffCompRequestsTable)
      .where(
        and(
          eq(staffCompRequestsTable.id, id),
          eq(staffCompRequestsTable.schoolId, schoolId),
        ),
      );
    if (!existing) {
      res.status(404).json({ error: "Request not found" });
      return;
    }
    if (existing.staffId !== me.id) {
      res.status(403).json({ error: "Not your request" });
      return;
    }
    const cancellable: Record<string, ReadonlySet<string>> = {
      earn: new Set([
        "pending_preapproval",
        "preapproved",
        "pending_confirm",
      ]),
      use: new Set(["pending_preapproval"]),
    };
    if (!cancellable[existing.kind]?.has(existing.state)) {
      res.status(409).json({
        error:
          existing.kind === "use" && existing.state === "preapproved"
            ? "This use request is already approved and your bank has been debited. Ask an admin to reverse it."
            : `Cannot cancel a ${existing.state} request`,
      });
      return;
    }

    const [updated] = await db
      .update(staffCompRequestsTable)
      .set({
        state: "cancelled",
        cancelledAt: new Date(),
        cancelNote: note,
      })
      .where(eq(staffCompRequestsTable.id, id))
      .returning();
    res.json({ ok: true, request: updated });
  },
);

// ---------------------------------------------------------------------------
// ADMIN — adjust (manual +/- with required note) + payout (mark exempt /
// separation, zero out the bank with a payout ledger row).
// ---------------------------------------------------------------------------
router.post(
  "/comp/staff/:id/adjust",
  requireApprover,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const me = getStaff(req);
    const staffId = Number(req.params["id"]);
    if (!Number.isFinite(staffId)) {
      res.status(400).json({ error: "Bad staff id" });
      return;
    }
    const deltaQh = Number(req.body?.deltaQuarterHours);
    const note = String(req.body?.note ?? "").trim() || null;
    if (!Number.isInteger(deltaQh) || deltaQh === 0) {
      res
        .status(400)
        .json({ error: "Adjustment must be a non-zero integer quarter-hour delta" });
      return;
    }
    if (!note) {
      res
        .status(400)
        .json({ error: "Adjustment note is required (audit)" });
      return;
    }

    const result = await db.transaction(async (tx) => {
      const [target] = await tx
        .select()
        .from(staffTable)
        .where(
          and(eq(staffTable.id, staffId), eq(staffTable.schoolId, schoolId)),
        );
      if (!target) {
        return { status: 404 as const, body: { error: "Staff not found in this school" } };
      }
      const [balRow] = await tx
        .select({
          total: sql<number>`COALESCE(SUM(${staffCompLedgerTable.deltaQuarterHours}), 0)::int`,
        })
        .from(staffCompLedgerTable)
        .where(
          and(
            eq(staffCompLedgerTable.schoolId, schoolId),
            eq(staffCompLedgerTable.staffId, staffId),
          ),
        );
      const balance = Number(balRow?.total ?? 0);
      const next = balance + deltaQh;
      if (next < 0) {
        return {
          status: 409 as const,
          body: {
            error: "would_go_negative",
            balanceQh: balance,
            deltaQh,
          },
        };
      }
      if (next > COMP_TIME_MAX_QH) {
        return {
          status: 409 as const,
          body: {
            error: "would_exceed_cap",
            balanceQh: balance,
            deltaQh,
            capQh: COMP_TIME_MAX_QH,
          },
        };
      }
      await tx.insert(staffCompLedgerTable).values({
        schoolId,
        staffId,
        deltaQuarterHours: deltaQh,
        kind: "admin_adjustment",
        note,
        createdByStaffId: me.id,
      });
      return { status: 200 as const, body: { ok: true, balanceQh: next } };
    });

    res.status(result.status).json(result.body);
  },
);

// Pay out the entire bank (called when staff flips to exempt OR
// separates). Writes a single negative `payout` ledger row and stamps
// staff.comp_time_paid_out_at. The PDF receipt is rendered by a
// separate route (Phase 2 follow-up — for now an admin downloads the
// per-staff ledger drilldown).
router.post(
  "/comp/staff/:id/payout",
  requireApprover,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const me = getStaff(req);
    const staffId = Number(req.params["id"]);
    const note = String(req.body?.note ?? "").trim() || null;
    if (!Number.isFinite(staffId)) {
      res.status(400).json({ error: "Bad staff id" });
      return;
    }
    if (!note) {
      res
        .status(400)
        .json({ error: "Payout note is required (reason + payroll batch id)" });
      return;
    }
    const result = await db.transaction(async (tx) => {
      const [target] = await tx
        .select()
        .from(staffTable)
        .where(
          and(eq(staffTable.id, staffId), eq(staffTable.schoolId, schoolId)),
        );
      if (!target) {
        return { status: 404 as const, body: { error: "Staff not found in this school" } };
      }
      const [balRow] = await tx
        .select({
          total: sql<number>`COALESCE(SUM(${staffCompLedgerTable.deltaQuarterHours}), 0)::int`,
        })
        .from(staffCompLedgerTable)
        .where(
          and(
            eq(staffCompLedgerTable.schoolId, schoolId),
            eq(staffCompLedgerTable.staffId, staffId),
          ),
        );
      const balance = Number(balRow?.total ?? 0);
      if (balance <= 0) {
        return {
          status: 409 as const,
          body: { error: "no_balance", message: "Bank already zero." },
        };
      }
      await tx.insert(staffCompLedgerTable).values({
        schoolId,
        staffId,
        deltaQuarterHours: -balance,
        kind: "payout",
        note,
        createdByStaffId: me.id,
      });
      await tx
        .update(staffTable)
        .set({ compTimePaidOutAt: new Date() })
        .where(eq(staffTable.id, staffId));
      return { status: 200 as const, body: { ok: true, paidOutQh: balance } };
    });
    res.status(result.status).json(result.body);
  },
);

// Per-staff ledger drilldown (admin) — mirrors the AST endpoint.
router.get(
  "/comp/staff/:id/ledger",
  requireApprover,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const targetId = Number(req.params.id);
    if (!Number.isFinite(targetId) || targetId <= 0) {
      res.status(400).json({ error: "Invalid staff id" });
      return;
    }
    const [target] = await db
      .select({ id: staffTable.id, displayName: staffTable.displayName })
      .from(staffTable)
      .where(
        and(
          eq(staffTable.id, targetId),
          eq(staffTable.schoolId, schoolId),
        ),
      );
    if (!target) {
      res.status(404).json({ error: "Staff not found in this school" });
      return;
    }
    const rows = await db
      .select({
        id: staffCompLedgerTable.id,
        deltaQuarterHours: staffCompLedgerTable.deltaQuarterHours,
        kind: staffCompLedgerTable.kind,
        note: staffCompLedgerTable.note,
        createdAt: staffCompLedgerTable.createdAt,
        schoolId: staffCompLedgerTable.schoolId,
        schoolName: schoolsTable.name,
        requestId: staffCompLedgerTable.requestId,
      })
      .from(staffCompLedgerTable)
      .innerJoin(
        schoolsTable,
        eq(schoolsTable.id, staffCompLedgerTable.schoolId),
      )
      .where(
        and(
          eq(staffCompLedgerTable.staffId, targetId),
          eq(staffCompLedgerTable.schoolId, schoolId),
        ),
      )
      .orderBy(desc(staffCompLedgerTable.createdAt))
      .limit(500);

    const balance = await balanceQuarterHours(schoolId, targetId);
    res.json({
      staff: { id: target.id, displayName: target.displayName },
      balanceQuarterHours: balance,
      capQuarterHours: COMP_TIME_MAX_QH,
      entries: rows,
    });
  },
);

// ---------------------------------------------------------------------------
// INSIGHTS — admin
// ---------------------------------------------------------------------------
router.get(
  "/comp/insights",
  requireApprover,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;

    // No school-year window for comp time (it doesn't lapse), but for
    // earned/used trend we still bucket by month to keep the chart
    // readable. Last 12 months.
    const now = new Date();
    const since = new Date(now);
    since.setMonth(since.getMonth() - 12);

    const [bankedRow, paidOutYtdRow, topBalances, byMonthRows] =
      await Promise.all([
        db
          .select({
            total: sql<number>`COALESCE(SUM(${staffCompLedgerTable.deltaQuarterHours}), 0)::int`,
          })
          .from(staffCompLedgerTable)
          .where(eq(staffCompLedgerTable.schoolId, schoolId)),

        db
          .select({
            total: sql<number>`COALESCE(ABS(SUM(${staffCompLedgerTable.deltaQuarterHours})), 0)::int`,
          })
          .from(staffCompLedgerTable)
          .where(
            and(
              eq(staffCompLedgerTable.schoolId, schoolId),
              eq(staffCompLedgerTable.kind, "payout"),
              sql`${staffCompLedgerTable.createdAt} >= ${since}`,
            ),
          ),

        db
          .select({
            staffId: staffCompLedgerTable.staffId,
            staffName: staffTable.displayName,
            balanceQh: sql<number>`COALESCE(SUM(${staffCompLedgerTable.deltaQuarterHours}), 0)::int`,
          })
          .from(staffCompLedgerTable)
          .leftJoin(
            staffTable,
            eq(staffTable.id, staffCompLedgerTable.staffId),
          )
          .where(eq(staffCompLedgerTable.schoolId, schoolId))
          .groupBy(staffCompLedgerTable.staffId, staffTable.displayName)
          .having(
            sql`COALESCE(SUM(${staffCompLedgerTable.deltaQuarterHours}), 0) > 0`,
          )
          .orderBy(
            sql`COALESCE(SUM(${staffCompLedgerTable.deltaQuarterHours}), 0) DESC`,
          )
          .limit(5),

        db
          .select({
            month: sql<string>`TO_CHAR(${staffCompLedgerTable.createdAt}, 'YYYY-MM')`,
            earnedQh: sql<number>`COALESCE(SUM(CASE WHEN ${staffCompLedgerTable.kind} = 'earn_confirm' THEN ${staffCompLedgerTable.deltaQuarterHours} ELSE 0 END), 0)::int`,
            usedQh: sql<number>`COALESCE(SUM(CASE WHEN ${staffCompLedgerTable.kind} = 'use_approval' THEN -${staffCompLedgerTable.deltaQuarterHours} ELSE 0 END), 0)::int`,
          })
          .from(staffCompLedgerTable)
          .where(
            and(
              eq(staffCompLedgerTable.schoolId, schoolId),
              sql`${staffCompLedgerTable.createdAt} >= ${since}`,
              sql`${staffCompLedgerTable.kind} IN ('earn_confirm','use_approval')`,
            ),
          )
          .groupBy(sql`TO_CHAR(${staffCompLedgerTable.createdAt}, 'YYYY-MM')`)
          .orderBy(sql`TO_CHAR(${staffCompLedgerTable.createdAt}, 'YYYY-MM')`),
      ]);

    // Count of staff currently within 10% of the cap — the audit
    // amber-flag for HR.
    const [nearCapRow] = await db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(
        db
          .select({
            staffId: staffCompLedgerTable.staffId,
            bal: sql<number>`COALESCE(SUM(${staffCompLedgerTable.deltaQuarterHours}), 0)::int`,
          })
          .from(staffCompLedgerTable)
          .where(eq(staffCompLedgerTable.schoolId, schoolId))
          .groupBy(staffCompLedgerTable.staffId)
          .having(
            sql`COALESCE(SUM(${staffCompLedgerTable.deltaQuarterHours}), 0) >= ${Math.floor(COMP_TIME_MAX_QH * 0.9)}`,
          )
          .as("near_cap"),
      );

    res.json({
      capQuarterHours: COMP_TIME_MAX_QH,
      totals: {
        bankedQh: Number(bankedRow[0]?.total ?? 0),
        paidOut12moQh: Number(paidOutYtdRow[0]?.total ?? 0),
        staffNearCap: Number(nearCapRow?.n ?? 0),
      },
      top5Balances: topBalances.map((r) => ({
        staffId: r.staffId,
        staffName: r.staffName ?? `Staff #${r.staffId}`,
        balanceQh: Number(r.balanceQh ?? 0),
      })),
      byMonth: byMonthRows.map((r) => ({
        month: r.month,
        earnedQh: Number(r.earnedQh ?? 0),
        usedQh: Number(r.usedQh ?? 0),
      })),
    });
  },
);

export default router;
