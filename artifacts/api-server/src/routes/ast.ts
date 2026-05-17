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
  schoolsTable,
  staffAstRequestsTable,
  staffAstLedgerTable,
  isAstCategory,
  AST_CATEGORIES,
  type AstCategory,
} from "@workspace/db";

// Strip the admin-only `category` field before returning request rows
// to staff-facing endpoints. Category is set by approvers and powers the
// AST Insights dashboard; staff must never see how their work was
// classified (avoids "you only approved this because it was Athletics"
// arguments). Admin endpoints (/ast/admin-queue, /ast/insights) keep
// category intact.
function stripAdminFields<T extends { category?: AstCategory | null } | null | undefined>(
  row: T,
): T {
  if (!row) return row;
  // Spread + delete to avoid mutating the original Drizzle row.
  const { category: _omit, ...rest } = row as { category?: unknown } & object;
  return rest as T;
}
function stripAdminFieldsList<T extends { category?: AstCategory | null }>(
  rows: T[],
): T[] {
  return rows.map((r) => stripAdminFields(r));
}
import { and, desc, eq, sql } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";

// Parse the optional `category` field on admin pre-approve / decide
// payloads. Returns:
//   { ok: true, value: AstCategory | null } — null = "leave uncategorized"
//   { ok: false }                            — caller passed something
//                                              outside the enum
function parseCategory(
  v: unknown,
): { ok: true; value: AstCategory | null } | { ok: false } {
  if (v === undefined || v === null || v === "") {
    return { ok: true, value: null };
  }
  if (isAstCategory(v)) return { ok: true, value: v };
  return { ok: false };
}

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

// Compute live balance for a staff member from the append-only ledger,
// restricted to schools in the caller's district. Cheap — single SUM
// over an indexed slice with a subquery against the schools table.
//
// District-wide bank: per HCTA negotiation + product decision (May
// 2026), a staff member's AST balance follows them across schools
// WITHIN the same district. Cross-district transfers (rare — e.g.
// staff moving between Hillsborough and Pinellas) do NOT carry the
// bank: the new district starts a fresh ledger. Ledger rows keep
// their originating `school_id` so the audit trail of WHERE hours
// were earned/used is preserved.
//
// `districtId` is derived from the caller's `req.schoolId` at the
// call site (the caller's school IS in their district by construction,
// so we cheaply join through schoolsTable). Reads via `db` rather
// than a passed-in tx are correct: the approval path holds a
// `FOR UPDATE` lock on the staff row, which serializes every other
// approver behind the same lock before THEY can read the ledger,
// so a concurrent ledger INSERT cannot interleave between this SUM
// and the subsequent debit insert.
async function balanceQuarterHoursForDistrict(
  staffId: number,
  districtId: number,
): Promise<number> {
  const [row] = await db
    .select({
      total: sql<number>`COALESCE(SUM(${staffAstLedgerTable.deltaQuarterHours}), 0)::int`,
    })
    .from(staffAstLedgerTable)
    .where(
      and(
        eq(staffAstLedgerTable.staffId, staffId),
        sql`${staffAstLedgerTable.schoolId} IN (SELECT ${schoolsTable.id} FROM ${schoolsTable} WHERE ${schoolsTable.districtId} = ${districtId})`,
      ),
    );
  return Number(row?.total ?? 0);
}

// Helper: look up the district id for the caller's school. Cached
// nowhere — the row is one PK lookup against an indexed table and
// every AST route already does multiple DB calls.
async function districtIdForSchool(
  schoolId: number,
): Promise<number | null> {
  const [row] = await db
    .select({ districtId: schoolsTable.districtId })
    .from(schoolsTable)
    .where(eq(schoolsTable.id, schoolId));
  return row ? Number(row.districtId) : null;
}

// ---------------------------------------------------------------------------
// READ — staff side (my balance + my requests + actionable count)
// ---------------------------------------------------------------------------
router.get(
  "/ast/me",
  requireAnyStaff,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const me = getStaff(req);

    const districtId = await districtIdForSchool(schoolId);
    if (districtId == null) {
      res.status(500).json({ error: "School has no district" });
      return;
    }
    const [balance, requests] = await Promise.all([
      balanceQuarterHoursForDistrict(me.id, districtId),
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
      requests: stripAdminFieldsList(requests),
    });
  },
);

// ---------------------------------------------------------------------------
// READ — admin side (the queue grouped by panel + counts for the tile)
// ---------------------------------------------------------------------------
router.get(
  "/ast/admin-queue",
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

// Lightweight endpoint for the staff-side AST sidebar bell. Counts ONLY
// admin replies the staff member hasn't read yet — i.e. rows where an
// admin has decided (preapprove / deny / confirm) AND staff_acknowledged_at
// is still NULL. Standing to-dos like "preapproved earn awaiting your
// completion submission" are NOT counted: the user wants the bell to
// mean "admin replied, go look", not "you have homework."
router.get(
  "/ast/my-actionable-count",
  requireAnyStaff,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const me = getStaff(req);
    const [row] = await db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(staffAstRequestsTable)
      .where(
        and(
          eq(staffAstRequestsTable.schoolId, schoolId),
          eq(staffAstRequestsTable.staffId, me.id),
          sql`${staffAstRequestsTable.staffAcknowledgedAt} IS NULL`,
          sql`(
            ${staffAstRequestsTable.preapprovedAt} IS NOT NULL
            OR ${staffAstRequestsTable.deniedAt} IS NOT NULL
            OR ${staffAstRequestsTable.confirmedAt} IS NOT NULL
          )`,
        ),
      );
    res.json({ count: Number(row?.n ?? 0) });
  },
);

// ---------------------------------------------------------------------------
// READ — per-staff ledger drilldown (admin)
// ---------------------------------------------------------------------------
// Admin-only drilldown for balance disputes, year-end audits, and
// bargaining-unit reports. Returns every ledger entry for the target
// staff member ACROSS ALL SCHOOLS in the district (the bank is
// district-wide; this is the surface where the originating school is
// surfaced so an admin can see "earned 12 hrs at Lincoln before
// transferring, used 4 hrs here"). Capped to 500 rows so a long
// career doesn't blow up the modal.
//
// Tenant guard: caller must be an approver, AND the target staff row
// must be visible from the caller's current school (i.e. the staff
// member is currently posted here). This prevents an admin from
// fishing for ledger data on staff who never transferred to their
// school. The originating-school name on each row is still shown so
// the admin can see WHERE hours were earned — that's the whole point.
router.get(
  "/ast/staff/:id/ledger",
  requireApprover,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const targetId = Number(req.params.id);
    if (!Number.isFinite(targetId) || targetId <= 0) {
      res.status(400).json({ error: "Invalid staff id" });
      return;
    }
    // Tenant guard — staff must currently belong to caller's school.
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

    // District scope. The bank is per-(staff, district); ledger rows
    // from other districts must NOT leak into this drilldown even if
    // the same staff record was reused after a cross-district transfer
    // (rare but possible — staff PK is global).
    const districtId = await districtIdForSchool(schoolId);
    if (districtId == null) {
      res.status(500).json({ error: "School has no district" });
      return;
    }

    const rows = await db
      .select({
        id: staffAstLedgerTable.id,
        deltaQuarterHours: staffAstLedgerTable.deltaQuarterHours,
        kind: staffAstLedgerTable.kind,
        note: staffAstLedgerTable.note,
        createdAt: staffAstLedgerTable.createdAt,
        schoolId: staffAstLedgerTable.schoolId,
        schoolName: schoolsTable.name,
        requestId: staffAstLedgerTable.requestId,
      })
      .from(staffAstLedgerTable)
      .innerJoin(
        schoolsTable,
        eq(schoolsTable.id, staffAstLedgerTable.schoolId),
      )
      .where(
        and(
          eq(staffAstLedgerTable.staffId, targetId),
          eq(schoolsTable.districtId, districtId),
        ),
      )
      .orderBy(desc(staffAstLedgerTable.createdAt))
      .limit(500);

    const balance = await balanceQuarterHoursForDistrict(targetId, districtId);
    res.json({
      staff: { id: target.id, displayName: target.displayName },
      balanceQuarterHours: balance,
      entries: rows,
    });
  },
);

// Mark all of the signed-in staff member's pending admin replies as read.
// Called by StaffAstPage on mount. Idempotent.
router.post(
  "/ast/acknowledge",
  requireAnyStaff,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const me = getStaff(req);
    await db
      .update(staffAstRequestsTable)
      .set({ staffAcknowledgedAt: new Date() })
      .where(
        and(
          eq(staffAstRequestsTable.schoolId, schoolId),
          eq(staffAstRequestsTable.staffId, me.id),
          sql`${staffAstRequestsTable.staffAcknowledgedAt} IS NULL`,
          sql`(
            ${staffAstRequestsTable.preapprovedAt} IS NOT NULL
            OR ${staffAstRequestsTable.deniedAt} IS NOT NULL
            OR ${staffAstRequestsTable.confirmedAt} IS NOT NULL
          )`,
        ),
      );
    res.json({ ok: true });
  },
);

// Lightweight endpoint for the Admin Hub tile + nav badge. Single COUNT
// query so the badge poll is cheap. Returns 0 for non-approvers (instead
// of 403) so the client doesn't have to special-case rendering.
router.get(
  "/ast/admin-pending-count",
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
  "/ast/earn",
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
    res.json({ ok: true, request: stripAdminFields(row) });
  },
);

// ---------------------------------------------------------------------------
// EARN — admin pre-approve / deny
// ---------------------------------------------------------------------------
router.patch(
  "/ast/earn/:id/preapprove",
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
    const cat = parseCategory(req.body?.category);
    if (!cat.ok) {
      res.status(400).json({ error: "Invalid AST category" });
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
              // Only set category on approval; denial leaves it null so a
              // resubmitted-and-then-approved request gets categorized
              // by the second admin action, not the first.
              category: cat.value,
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
  "/ast/earn/:id/complete",
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
    res.json({ ok: true, request: stripAdminFields(updated) });
  },
);

// ---------------------------------------------------------------------------
// EARN — admin confirms / denies completion → posts ledger row on confirm
// ---------------------------------------------------------------------------
router.patch(
  "/ast/earn/:id/confirm",
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
  "/ast/use",
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
    const districtId = await districtIdForSchool(schoolId);
    if (districtId == null) {
      res.status(500).json({ error: "School has no district" });
      return;
    }
    const balance = await balanceQuarterHoursForDistrict(me.id, districtId);
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
    res.json({ ok: true, request: stripAdminFields(row) });
  },
);

// ---------------------------------------------------------------------------
// USE — admin approves / denies → debits bank on approval
// ---------------------------------------------------------------------------
router.patch(
  "/ast/use/:id/decide",
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
    const cat = parseCategory(req.body?.category);
    if (!cat.ok) {
      res.status(400).json({ error: "Invalid AST category" });
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
      //
      // The lock is BY staff_id ONLY — do NOT add a schoolId filter.
      // The staff row's school_id can change on a mid-year transfer
      // and the bank is district-wide; the lock must follow the
      // person regardless of which school they currently sit at,
      // otherwise the SELECT FOR UPDATE matches zero rows and the
      // serialization silently disappears.
      if (decision === "approve") {
        await tx
          .select({ id: staffTable.id })
          .from(staffTable)
          .where(eq(staffTable.id, existing.staffId))
          .for("update");

        // District-scoped bank check — see balanceQuarterHoursForDistrict
        // comment. The hard double-spend check must reflect the same
        // total the staff member sees on /ast/me.
        const districtId = await districtIdForSchool(schoolId);
        if (districtId == null) {
          return {
            http: 500,
            body: { error: "School has no district" },
          };
        }
        const live = await balanceQuarterHoursForDistrict(
          existing.staffId,
          districtId,
        );
        if (existing.quarterHoursRequested > live) {
          return {
            http: 409,
            body: {
              error: `Insufficient bank — staff has ${(live / 4).toFixed(2)} hr but request is for ${(existing.quarterHoursRequested / 4).toFixed(2)} hr. Deny with a note instead.`,
            },
          };
        }
      }

      // Compare-and-swap on state: only flip the row if it is STILL
      // pending_preapproval. Two admins clicking Approve on the same
      // request within milliseconds of each other will now see the
      // second update affect zero rows; we abort that loser with a
      // 409 rather than double-applying the debit below.
      const now = new Date();
      const updatedRows = await tx
        .update(staffAstRequestsTable)
        .set(
          decision === "approve"
            ? {
                state: "preapproved",
                preapprovedAt: now,
                preapprovedByStaffId: me.id,
                preapprovalNote: note,
                category: cat.value,
              }
            : {
                state: "denied",
                deniedAt: now,
                deniedByStaffId: me.id,
                denyNote: note,
              },
        )
        .where(
          and(
            eq(staffAstRequestsTable.id, id),
            eq(staffAstRequestsTable.state, "pending_preapproval"),
          ),
        )
        .returning();
      if (updatedRows.length === 0) {
        return {
          http: 409,
          body: {
            error: "Another approver decided this request first — refresh the queue",
          },
        };
      }
      const updated = updatedRows[0];

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
// INSIGHTS — admin-only dashboard aggregator
// ---------------------------------------------------------------------------
// Single round-trip aggregator for the AST Insights page. Returns the
// five panels (headline tiles, top-5 balances + earners, by-category,
// by-month, by-role-group) for the CURRENT school year (Jul 1 → Jun 30
// in server-local time, matching schoolYearLabelFor's convention).
// "Earned YTD" sums positive `earn_confirm` ledger entries; "Used YTD"
// sums absolute `use_approval` debits. Lapse/transfer rows are excluded
// from earned/used totals (they're flow-control, not contract-funded
// activity). Banked total reads the live ledger sum (no time filter).
router.get(
  "/ast/insights",
  requireApprover,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;

    // Current school year window. Matches lib/schoolYear.ts: the year
    // boundary is July 1 in server-local time. We re-derive it here
    // (rather than importing) because the helper returns a label and we
    // need a Date.
    const now = new Date();
    const sy = now.getMonth() + 1 >= 7 ? now.getFullYear() : now.getFullYear() - 1;
    const yearStart = new Date(sy, 6, 1, 0, 0, 0, 0); // Jul 1 00:00 local
    const yearEnd = new Date(sy + 1, 6, 1, 0, 0, 0, 0); // next Jul 1

    // Headline + ledger-driven aggregates run as parallel SQL.
    const [
      bankedRow,
      earnedRow,
      usedRow,
      topBalanceRows,
      topEarnerRows,
      byCategoryRows,
      byMonthRows,
      byRoleRows,
    ] = await Promise.all([
      // Banked total — sum of every ledger row across the school.
      // Includes lapses/transfers (negative), which is correct: the
      // bank should reflect actual outstanding obligation.
      db
        .select({
          total: sql<number>`COALESCE(SUM(${staffAstLedgerTable.deltaQuarterHours}), 0)::int`,
        })
        .from(staffAstLedgerTable)
        .where(eq(staffAstLedgerTable.schoolId, schoolId)),

      // Earned YTD — positive earn_confirm rows in the current SY.
      db
        .select({
          total: sql<number>`COALESCE(SUM(${staffAstLedgerTable.deltaQuarterHours}), 0)::int`,
        })
        .from(staffAstLedgerTable)
        .where(
          and(
            eq(staffAstLedgerTable.schoolId, schoolId),
            eq(staffAstLedgerTable.kind, "earn_confirm"),
            sql`${staffAstLedgerTable.createdAt} >= ${yearStart}`,
            sql`${staffAstLedgerTable.createdAt} < ${yearEnd}`,
          ),
        ),

      // Used YTD — abs(sum) of use_approval debits in the current SY.
      db
        .select({
          total: sql<number>`COALESCE(ABS(SUM(${staffAstLedgerTable.deltaQuarterHours})), 0)::int`,
        })
        .from(staffAstLedgerTable)
        .where(
          and(
            eq(staffAstLedgerTable.schoolId, schoolId),
            eq(staffAstLedgerTable.kind, "use_approval"),
            sql`${staffAstLedgerTable.createdAt} >= ${yearStart}`,
            sql`${staffAstLedgerTable.createdAt} < ${yearEnd}`,
          ),
        ),

      // Top 5 balances (current bank, all-time).
      db
        .select({
          staffId: staffAstLedgerTable.staffId,
          staffName: staffTable.displayName,
          balanceQh: sql<number>`COALESCE(SUM(${staffAstLedgerTable.deltaQuarterHours}), 0)::int`,
        })
        .from(staffAstLedgerTable)
        .leftJoin(staffTable, eq(staffTable.id, staffAstLedgerTable.staffId))
        .where(eq(staffAstLedgerTable.schoolId, schoolId))
        .groupBy(staffAstLedgerTable.staffId, staffTable.displayName)
        .having(sql`COALESCE(SUM(${staffAstLedgerTable.deltaQuarterHours}), 0) > 0`)
        .orderBy(sql`COALESCE(SUM(${staffAstLedgerTable.deltaQuarterHours}), 0) DESC`)
        .limit(5),

      // Top 5 earners YTD (positive earn_confirm sums, current SY).
      db
        .select({
          staffId: staffAstLedgerTable.staffId,
          staffName: staffTable.displayName,
          earnedQh: sql<number>`COALESCE(SUM(${staffAstLedgerTable.deltaQuarterHours}), 0)::int`,
        })
        .from(staffAstLedgerTable)
        .leftJoin(staffTable, eq(staffTable.id, staffAstLedgerTable.staffId))
        .where(
          and(
            eq(staffAstLedgerTable.schoolId, schoolId),
            eq(staffAstLedgerTable.kind, "earn_confirm"),
            sql`${staffAstLedgerTable.createdAt} >= ${yearStart}`,
            sql`${staffAstLedgerTable.createdAt} < ${yearEnd}`,
          ),
        )
        .groupBy(staffAstLedgerTable.staffId, staffTable.displayName)
        .orderBy(sql`SUM(${staffAstLedgerTable.deltaQuarterHours}) DESC`)
        .limit(5),

      // By category — join ledger to its originating request to read
      // category. Lapse/transfer rows have no request_id and are
      // excluded by the INNER JOIN. Earn vs use split via kind.
      db
        .select({
          category: staffAstRequestsTable.category,
          earnedQh: sql<number>`COALESCE(SUM(CASE WHEN ${staffAstLedgerTable.kind} = 'earn_confirm' THEN ${staffAstLedgerTable.deltaQuarterHours} ELSE 0 END), 0)::int`,
          usedQh: sql<number>`COALESCE(SUM(CASE WHEN ${staffAstLedgerTable.kind} = 'use_approval' THEN -${staffAstLedgerTable.deltaQuarterHours} ELSE 0 END), 0)::int`,
        })
        .from(staffAstLedgerTable)
        .innerJoin(
          staffAstRequestsTable,
          eq(staffAstRequestsTable.id, staffAstLedgerTable.requestId),
        )
        .where(
          and(
            eq(staffAstLedgerTable.schoolId, schoolId),
            sql`${staffAstLedgerTable.createdAt} >= ${yearStart}`,
            sql`${staffAstLedgerTable.createdAt} < ${yearEnd}`,
            sql`${staffAstLedgerTable.kind} IN ('earn_confirm','use_approval')`,
          ),
        )
        .groupBy(staffAstRequestsTable.category),

      // By month — earned vs used per calendar month within the SY.
      db
        .select({
          month: sql<string>`TO_CHAR(${staffAstLedgerTable.createdAt}, 'YYYY-MM')`,
          earnedQh: sql<number>`COALESCE(SUM(CASE WHEN ${staffAstLedgerTable.kind} = 'earn_confirm' THEN ${staffAstLedgerTable.deltaQuarterHours} ELSE 0 END), 0)::int`,
          usedQh: sql<number>`COALESCE(SUM(CASE WHEN ${staffAstLedgerTable.kind} = 'use_approval' THEN -${staffAstLedgerTable.deltaQuarterHours} ELSE 0 END), 0)::int`,
        })
        .from(staffAstLedgerTable)
        .where(
          and(
            eq(staffAstLedgerTable.schoolId, schoolId),
            sql`${staffAstLedgerTable.createdAt} >= ${yearStart}`,
            sql`${staffAstLedgerTable.createdAt} < ${yearEnd}`,
            sql`${staffAstLedgerTable.kind} IN ('earn_confirm','use_approval')`,
          ),
        )
        .groupBy(sql`TO_CHAR(${staffAstLedgerTable.createdAt}, 'YYYY-MM')`)
        .orderBy(sql`TO_CHAR(${staffAstLedgerTable.createdAt}, 'YYYY-MM')`),

      // By role group — derive bucket from staff role flags. No
      // department field exists today (see Future-work note in
      // replit.md), so we group by the highest-priority role flag.
      // Order matters: a teacher who is also a dean groups under
      // "Core Team" so the picture matches who's actually doing the
      // extra-duty work.
      db
        .select({
          isAdmin: staffTable.isAdmin,
          isDistrictAdmin: staffTable.isDistrictAdmin,
          isSuperUser: staffTable.isSuperUser,
          isMtssCoordinator: staffTable.isMtssCoordinator,
          isBehaviorSpecialist: staffTable.isBehaviorSpecialist,
          isDean: staffTable.isDean,
          isPbisCoordinator: staffTable.isPbisCoordinator,
          isEseCoordinator: staffTable.isEseCoordinator,
          isCounselor: staffTable.isCounselor,
          isGuidanceCounselor: staffTable.isGuidanceCounselor,
          isSocialWorker: staffTable.isSocialWorker,
          isSchoolPsychologist: staffTable.isSchoolPsychologist,
          earnedQh: sql<number>`COALESCE(SUM(CASE WHEN ${staffAstLedgerTable.kind} = 'earn_confirm' THEN ${staffAstLedgerTable.deltaQuarterHours} ELSE 0 END), 0)::int`,
          usedQh: sql<number>`COALESCE(SUM(CASE WHEN ${staffAstLedgerTable.kind} = 'use_approval' THEN -${staffAstLedgerTable.deltaQuarterHours} ELSE 0 END), 0)::int`,
        })
        .from(staffAstLedgerTable)
        .innerJoin(staffTable, eq(staffTable.id, staffAstLedgerTable.staffId))
        .where(
          and(
            eq(staffAstLedgerTable.schoolId, schoolId),
            sql`${staffAstLedgerTable.createdAt} >= ${yearStart}`,
            sql`${staffAstLedgerTable.createdAt} < ${yearEnd}`,
            sql`${staffAstLedgerTable.kind} IN ('earn_confirm','use_approval')`,
          ),
        )
        .groupBy(
          staffTable.id,
          staffTable.isAdmin,
          staffTable.isDistrictAdmin,
          staffTable.isSuperUser,
          staffTable.isMtssCoordinator,
          staffTable.isBehaviorSpecialist,
          staffTable.isDean,
          staffTable.isPbisCoordinator,
          staffTable.isEseCoordinator,
          staffTable.isCounselor,
          staffTable.isGuidanceCounselor,
          staffTable.isSocialWorker,
          staffTable.isSchoolPsychologist,
        ),
    ]);

    // Roll up the per-staff role rows into role-group buckets.
    type Bucket = "Admin" | "Core Team" | "Counselor / Social Work" | "Teacher";
    const roleTotals: Record<Bucket, { earnedQh: number; usedQh: number }> = {
      Admin: { earnedQh: 0, usedQh: 0 },
      "Core Team": { earnedQh: 0, usedQh: 0 },
      "Counselor / Social Work": { earnedQh: 0, usedQh: 0 },
      Teacher: { earnedQh: 0, usedQh: 0 },
    };
    for (const r of byRoleRows) {
      let bucket: Bucket = "Teacher";
      if (r.isAdmin || r.isDistrictAdmin || r.isSuperUser) bucket = "Admin";
      else if (
        r.isMtssCoordinator ||
        r.isBehaviorSpecialist ||
        r.isDean ||
        r.isPbisCoordinator ||
        r.isEseCoordinator
      )
        bucket = "Core Team";
      else if (
        r.isCounselor ||
        r.isGuidanceCounselor ||
        r.isSocialWorker ||
        r.isSchoolPsychologist
      )
        bucket = "Counselor / Social Work";
      roleTotals[bucket].earnedQh += Number(r.earnedQh ?? 0);
      roleTotals[bucket].usedQh += Number(r.usedQh ?? 0);
    }
    const byRoleGroup = (Object.keys(roleTotals) as Bucket[])
      .map((name) => ({
        roleGroup: name,
        earnedQh: roleTotals[name].earnedQh,
        usedQh: roleTotals[name].usedQh,
      }))
      .filter((b) => b.earnedQh > 0 || b.usedQh > 0);

    // Pad by-month so every month in the SY shows up even if zero, so
    // the trend chart doesn't look gappy in the first weeks of school.
    const monthMap = new Map<string, { earnedQh: number; usedQh: number }>();
    for (const r of byMonthRows) {
      monthMap.set(r.month, {
        earnedQh: Number(r.earnedQh ?? 0),
        usedQh: Number(r.usedQh ?? 0),
      });
    }
    const byMonth: Array<{ month: string; earnedQh: number; usedQh: number }> = [];
    // Walk Jul → Jun. We pad through the current month only — future
    // months in the SY would just show empty bars and confuse readers.
    const cur = new Date(yearStart);
    while (cur < yearEnd && cur <= now) {
      const key = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}`;
      const v = monthMap.get(key) ?? { earnedQh: 0, usedQh: 0 };
      byMonth.push({ month: key, ...v });
      cur.setMonth(cur.getMonth() + 1);
    }

    // Normalize category rows: NULL → "Uncategorized" + numeric coerce.
    const byCategory = byCategoryRows.map((r) => ({
      category: r.category ?? "Uncategorized",
      earnedQh: Number(r.earnedQh ?? 0),
      usedQh: Number(r.usedQh ?? 0),
    }));

    res.json({
      schoolYearLabel: `${String(sy % 100).padStart(2, "0")}-${String((sy + 1) % 100).padStart(2, "0")}`,
      categories: AST_CATEGORIES,
      totals: {
        bankedQh: Number(bankedRow[0]?.total ?? 0),
        earnedYtdQh: Number(earnedRow[0]?.total ?? 0),
        usedYtdQh: Number(usedRow[0]?.total ?? 0),
      },
      top5Balances: topBalanceRows.map((r) => ({
        staffId: r.staffId,
        staffName: r.staffName ?? `Staff #${r.staffId}`,
        balanceQh: Number(r.balanceQh ?? 0),
      })),
      top5Earners: topEarnerRows.map((r) => ({
        staffId: r.staffId,
        staffName: r.staffName ?? `Staff #${r.staffId}`,
        earnedQh: Number(r.earnedQh ?? 0),
      })),
      byCategory,
      byMonth,
      byRoleGroup,
    });
  },
);

// ---------------------------------------------------------------------------
// CANCEL — staff cancels their own pending request
// ---------------------------------------------------------------------------
router.post(
  "/ast/:id/cancel",
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
    res.json({ ok: true, request: stripAdminFields(updated) });
  },
);

export default router;
