// AST (Alternate Schedule Time) — staff-only earn/use bank per HCTA contract.
//
// State machine, helpers, and gates: see lib/db/src/schema/staffAst.ts.
//
// Notification surface: bell-only by default. Counts are surfaced via
// GET /api/ast/me (staff side) and GET /api/ast/admin-queue (admin side);
// the client polls these for badges. No email is sent — that was the
// explicit product call so chatty schools don't drown in messages.

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
  staffAstRequestsTable,
  staffAstLedgerTable,
} from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";

const router: IRouter = Router();

type StaffRow = typeof staffTable.$inferSelect;

async function loadStaff(req: Request): Promise<StaffRow | null> {
  const id = req.staffId;
  if (!id) return null;
  const [s] = await db.select().from(staffTable).where(eq(staffTable.id, id));
  return s && s.active ? s : null;
}

// Approval gate: site admin tier OR explicit per-staff `canApproveAst`
// flag (granted by an admin to e.g. the confidential secretary). Kept
// loose by design — the policy lets any admin sign off.
function canApproveAst(s: StaffRow): boolean {
  return Boolean(
    s.isAdmin || s.isDistrictAdmin || s.isSuperUser || s.canApproveAst,
  );
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
const requireApprover = requireStaffMW(canApproveAst, "AST approver");

function getStaff(req: Request): StaffRow {
  return (req as Request & { staff: StaffRow }).staff;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
function parseQuarterHours(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (!Number.isInteger(n)) return null;
  if (n <= 0 || n > 4 * 24 * 31) return null; // sane upper bound
  return n;
}

// Compute live balance for a staff member from the append-only ledger.
// Cheap — single SUM over an indexed slice.
async function balanceQuarterHours(
  schoolId: number,
  staffId: number,
): Promise<number> {
  const [row] = await db
    .select({
      total: sql<number>`COALESCE(SUM(${staffAstLedgerTable.deltaQuarterHours}), 0)::int`,
    })
    .from(staffAstLedgerTable)
    .where(
      and(
        eq(staffAstLedgerTable.schoolId, schoolId),
        eq(staffAstLedgerTable.staffId, staffId),
      ),
    );
  return Number(row?.total ?? 0);
}

// ---------------------------------------------------------------------------
// READ — staff side (my balance + my requests + actionable count)
// ---------------------------------------------------------------------------
router.get(
  "/api/ast/me",
  requireAnyStaff,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const me = getStaff(req);

    const [balance, requests] = await Promise.all([
      balanceQuarterHours(schoolId, me.id),
      db
        .select()
        .from(staffAstRequestsTable)
        .where(
          and(
            eq(staffAstRequestsTable.schoolId, schoolId),
            eq(staffAstRequestsTable.staffId, me.id),
          ),
        )
        .orderBy(desc(staffAstRequestsTable.createdAt))
        .limit(200),
    ]);

    // What the staff member needs to do: any earn request that's been
    // pre-approved but not yet completed. (Use requests are decided by
    // admin only — staff just waits.)
    const needsCompletion = requests.filter(
      (r) => r.kind === "earn" && r.state === "preapproved",
    ).length;

    res.json({
      balanceQuarterHours: balance,
      canApproveAst: canApproveAst(me),
      needsCompletion,
      requests,
    });
  },
);

// ---------------------------------------------------------------------------
// READ — admin side (the queue grouped by panel + counts for the tile)
// ---------------------------------------------------------------------------
router.get(
  "/api/ast/admin-queue",
  requireApprover,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;

    const rows = await db
      .select({
        request: staffAstRequestsTable,
        staffName: staffTable.displayName,
      })
      .from(staffAstRequestsTable)
      .leftJoin(staffTable, eq(staffTable.id, staffAstRequestsTable.staffId))
      .where(eq(staffAstRequestsTable.schoolId, schoolId))
      .orderBy(desc(staffAstRequestsTable.createdAt))
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
      // Recent activity feed (decided requests, last 50). Drives the
      // "Recently decided" tail at the bottom of the admin queue page so
      // approvers can see / undo recent calls without leaving the page.
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

// Lightweight endpoint for the Admin Hub tile + nav badge. Single COUNT
// query so the badge poll is cheap. Returns 0 for non-approvers (instead
// of 403) so the client doesn't have to special-case rendering.
router.get(
  "/api/ast/admin-pending-count",
  requireAnyStaff,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const me = getStaff(req);
    if (!canApproveAst(me)) {
      res.json({ count: 0 });
      return;
    }
    const [row] = await db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(staffAstRequestsTable)
      .where(
        and(
          eq(staffAstRequestsTable.schoolId, schoolId),
          sql`(
            (${staffAstRequestsTable.kind} = 'earn'
              AND ${staffAstRequestsTable.state} IN ('pending_preapproval','pending_confirm'))
            OR
            (${staffAstRequestsTable.kind} = 'use'
              AND ${staffAstRequestsTable.state} = 'pending_preapproval')
          )`,
        ),
      );
    res.json({ count: Number(row?.n ?? 0) });
  },
);

// ---------------------------------------------------------------------------
// EARN — submit
// ---------------------------------------------------------------------------
router.post(
  "/api/ast/earn",
  requireAnyStaff,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const me = getStaff(req);

    const eventDate = String(req.body?.eventDate ?? "").trim();
    const reason = String(req.body?.reason ?? "").trim();
    const qh = parseQuarterHours(req.body?.quarterHours);

    if (!eventDate || !/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
      res.status(400).json({ error: "Event date is required (YYYY-MM-DD)" });
      return;
    }
    if (!reason) {
      res
        .status(400)
        .json({ error: "Reason is required (Open House, parent conf., etc.)" });
      return;
    }
    if (qh === null) {
      res
        .status(400)
        .json({ error: "Hours must be a positive multiple of ¼ hour" });
      return;
    }

    const [row] = await db
      .insert(staffAstRequestsTable)
      .values({
        schoolId,
        staffId: me.id,
        kind: "earn",
        state: "pending_preapproval",
        eventDate,
        reason,
        quarterHoursRequested: qh,
      })
      .returning();
    req.log.info({ requestId: row?.id, staffId: me.id }, "AST earn submitted");
    res.json({ ok: true, request: row });
  },
);

// ---------------------------------------------------------------------------
// EARN — admin pre-approve / deny
// ---------------------------------------------------------------------------
router.patch(
  "/api/ast/earn/:id/preapprove",
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
      .from(staffAstRequestsTable)
      .where(
        and(
          eq(staffAstRequestsTable.id, id),
          eq(staffAstRequestsTable.schoolId, schoolId),
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
      .update(staffAstRequestsTable)
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
      .where(eq(staffAstRequestsTable.id, id))
      .returning();
    res.json({ ok: true, request: updated });
  },
);

// ---------------------------------------------------------------------------
// EARN — staff submits completion
// ---------------------------------------------------------------------------
router.post(
  "/api/ast/earn/:id/complete",
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
    const qh = parseQuarterHours(req.body?.quarterHoursActual);
    const note = String(req.body?.note ?? "").trim() || null;

    if (qh === null) {
      res
        .status(400)
        .json({
          error: "Actual hours must be a positive multiple of ¼ hour",
        });
      return;
    }

    const [existing] = await db
      .select()
      .from(staffAstRequestsTable)
      .where(
        and(
          eq(staffAstRequestsTable.id, id),
          eq(staffAstRequestsTable.schoolId, schoolId),
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

    const [updated] = await db
      .update(staffAstRequestsTable)
      .set({
        state: "pending_confirm",
        quarterHoursActual: qh,
        completionSubmittedAt: new Date(),
        completionNote: note,
      })
      .where(eq(staffAstRequestsTable.id, id))
      .returning();
    res.json({ ok: true, request: updated });
  },
);

// ---------------------------------------------------------------------------
// EARN — admin confirms / denies completion → posts ledger row on confirm
// ---------------------------------------------------------------------------
router.patch(
  "/api/ast/earn/:id/confirm",
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

    // Wrap the read+write in a tx so two admins can't double-credit the
    // same request by clicking Confirm at the same time.
    const result = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(staffAstRequestsTable)
        .where(
          and(
            eq(staffAstRequestsTable.id, id),
            eq(staffAstRequestsTable.schoolId, schoolId),
          ),
        );
      if (!existing) return { http: 404, body: { error: "Request not found" } };
      if (
        existing.kind !== "earn" ||
        existing.state !== "pending_confirm"
      ) {
        return {
          http: 409,
          body: {
            error: `Request is not awaiting confirmation (state=${existing.state})`,
          },
        };
      }
      const qh = existing.quarterHoursActual ?? 0;
      if (decision === "approve" && qh <= 0) {
        return {
          http: 409,
          body: { error: "Completion has no actual hours recorded" },
        };
      }

      const now = new Date();
      const [updated] = await tx
        .update(staffAstRequestsTable)
        .set(
          decision === "approve"
            ? {
                state: "confirmed",
                confirmedAt: now,
                confirmedByStaffId: me.id,
                confirmNote: note,
              }
            : {
                state: "denied",
                deniedAt: now,
                deniedByStaffId: me.id,
                denyNote: note,
              },
        )
        .where(eq(staffAstRequestsTable.id, id))
        .returning();

      if (decision === "approve") {
        await tx.insert(staffAstLedgerTable).values({
          schoolId,
          staffId: existing.staffId,
          deltaQuarterHours: qh,
          kind: "earn_confirm",
          requestId: existing.id,
          createdByStaffId: me.id,
          note,
        });
      }
      return { http: 200, body: { ok: true, request: updated } };
    });
    res.status(result.http).json(result.body);
  },
);

// ---------------------------------------------------------------------------
// USE — submit
// ---------------------------------------------------------------------------
router.post(
  "/api/ast/use",
  requireAnyStaff,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const me = getStaff(req);

    const startStr = String(req.body?.startAt ?? "").trim();
    const endStr = String(req.body?.endAt ?? "").trim();
    if (!startStr || !endStr) {
      res.status(400).json({ error: "Start and end times are required" });
      return;
    }
    const start = new Date(startStr);
    const end = new Date(endStr);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      res.status(400).json({ error: "Invalid start or end time" });
      return;
    }
    if (end.getTime() <= start.getTime()) {
      res.status(400).json({ error: "End time must be after start time" });
      return;
    }

    // Snap duration to ¼-hour increments. Round UP so staff can't game
    // the picker (e.g. requesting a 29-min window and getting 14 free
    // minutes). The bank is debited the rounded-up amount.
    const minutes = Math.ceil((end.getTime() - start.getTime()) / 60000);
    const qh = Math.ceil(minutes / 15);
    if (qh <= 0) {
      res
        .status(400)
        .json({ error: "Use requests must be at least ¼ hour (15 min)" });
      return;
    }

    // Soft balance hint at submit time. The hard check happens at admin
    // approval (so the admin sees the live balance, not a stale snapshot
    // from when the staff first submitted).
    const balance = await balanceQuarterHours(schoolId, me.id);
    if (qh > balance) {
      res.status(400).json({
        error: `You only have ${(balance / 4).toFixed(2)} hr in your bank — request a smaller window or earn more first`,
      });
      return;
    }

    const [row] = await db
      .insert(staffAstRequestsTable)
      .values({
        schoolId,
        staffId: me.id,
        kind: "use",
        state: "pending_preapproval",
        useStartAt: start,
        useEndAt: end,
        quarterHoursRequested: qh,
      })
      .returning();
    res.json({ ok: true, request: row });
  },
);

// ---------------------------------------------------------------------------
// USE — admin approves / denies → debits bank on approval
// ---------------------------------------------------------------------------
router.patch(
  "/api/ast/use/:id/decide",
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
        .from(staffAstRequestsTable)
        .where(
          and(
            eq(staffAstRequestsTable.id, id),
            eq(staffAstRequestsTable.schoolId, schoolId),
          ),
        );
      if (!existing)
        return { http: 404, body: { error: "Request not found" } };
      if (
        existing.kind !== "use" ||
        existing.state !== "pending_preapproval"
      ) {
        return {
          http: 409,
          body: {
            error: `Request is not awaiting decision (state=${existing.state})`,
          },
        };
      }

      // Serialize all bank-mutating decisions for THIS staff member by
      // taking a row lock on their staff row. Two admins approving two
      // separate USE requests for the same teacher will now queue
      // through this lock instead of both reading the same stale
      // balance and double-spending.
      if (decision === "approve") {
        await tx
          .select({ id: staffTable.id })
          .from(staffTable)
          .where(
            and(
              eq(staffTable.id, existing.staffId),
              eq(staffTable.schoolId, schoolId),
            ),
          )
          .for("update");

        const [bRow] = await tx
          .select({
            total: sql<number>`COALESCE(SUM(${staffAstLedgerTable.deltaQuarterHours}), 0)::int`,
          })
          .from(staffAstLedgerTable)
          .where(
            and(
              eq(staffAstLedgerTable.schoolId, schoolId),
              eq(staffAstLedgerTable.staffId, existing.staffId),
            ),
          );
        const live = Number(bRow?.total ?? 0);
        if (existing.quarterHoursRequested > live) {
          return {
            http: 409,
            body: {
              error: `Insufficient bank — staff has ${(live / 4).toFixed(2)} hr but request is for ${(existing.quarterHoursRequested / 4).toFixed(2)} hr. Deny with a note instead.`,
            },
          };
        }
      }

      const now = new Date();
      const [updated] = await tx
        .update(staffAstRequestsTable)
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
        .where(eq(staffAstRequestsTable.id, id))
        .returning();

      if (decision === "approve") {
        await tx.insert(staffAstLedgerTable).values({
          schoolId,
          staffId: existing.staffId,
          deltaQuarterHours: -existing.quarterHoursRequested,
          kind: "use_approval",
          requestId: existing.id,
          createdByStaffId: me.id,
          note,
        });
      }
      return { http: 200, body: { ok: true, request: updated } };
    });
    res.status(result.http).json(result.body);
  },
);

// ---------------------------------------------------------------------------
// CANCEL — staff cancels their own pending request
// ---------------------------------------------------------------------------
router.post(
  "/api/ast/:id/cancel",
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
      .from(staffAstRequestsTable)
      .where(
        and(
          eq(staffAstRequestsTable.id, id),
          eq(staffAstRequestsTable.schoolId, schoolId),
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
    // Cancellable states differ by kind:
    //   EARN: pending_preapproval, preapproved, pending_confirm — none
    //         of these have credited the bank yet (credit happens at
    //         admin confirm), so cancellation is a pure state change.
    //   USE:  pending_preapproval ONLY. Once an admin approves a use
    //         request the bank is already debited, so allowing the
    //         staff to "cancel" without a reversing credit would lose
    //         the hours. Approved-but-not-yet-taken use windows must
    //         be reversed via an admin adjustment, not staff cancel.
    const cancellable: Record<typeof existing.kind, ReadonlySet<string>> = {
      earn: new Set([
        "pending_preapproval",
        "preapproved",
        "pending_confirm",
      ]),
      use: new Set(["pending_preapproval"]),
    };
    if (!cancellable[existing.kind].has(existing.state)) {
      res.status(409).json({
        error:
          existing.kind === "use" && existing.state === "preapproved"
            ? "This use request is already approved and your bank has been debited. Ask an admin to reverse it."
            : `Cannot cancel a ${existing.state} request`,
      });
      return;
    }

    const [updated] = await db
      .update(staffAstRequestsTable)
      .set({
        state: "cancelled",
        cancelledAt: new Date(),
        cancelNote: note,
      })
      .where(eq(staffAstRequestsTable.id, id))
      .returning();
    res.json({ ok: true, request: updated });
  },
);

export default router;
