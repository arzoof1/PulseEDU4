// School Store redemption engine — the single source of truth for the
// points wallet and the redemption lifecycle. Every redeem surface (family
// via the Parent Portal, student via ClassLink SSO, or staff on-behalf)
// funnels through these helpers so the no-double-spend, inventory, approval,
// and per-student-limit rules stay consistent across all of them.
//
// Concurrency: the wallet balance is derived (lifetime PBIS points minus
// held redemptions), not a single mutable row, so we serialize all balance-
// affecting writes for a given student with a per-(school, student) Postgres
// transaction advisory lock. Stock decrements use a guarded UPDATE so the
// "last item" race is also safe across different students.
import {
  db,
  schoolStoreItemsTable,
  schoolStoreRedemptionsTable,
  schoolSettingsTable,
  pbisEntriesTable,
  pbisPointMigrationsTable,
  studentsTable,
  staffTable,
  classSectionsTable,
  sectionRosterTable,
  type SchoolStoreRedemptionRow,
} from "@workspace/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { isCoreTeam } from "./coreTeam.js";

// Statuses whose points are currently HELD against the wallet.
const HELD_STATUSES = ["pending", "fulfilled"] as const;
// Statuses that count toward a per-student item limit (everything that is
// not cancelled).
const ACTIVE_STATUSES = ["pending_approval", "pending", "fulfilled"] as const;

export type StoreInventoryMode = "simple" | "quantity";

// Any executor — the top-level `db` or a transaction handle.
type Executor =
  | typeof db
  | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type RedeemActor =
  | { type: "staff"; id: number }
  | { type: "parent"; id: number }
  | { type: "student"; id: number | null };

export type RedeemErrorCode =
  | "not_found"
  | "archived"
  | "out_of_stock"
  | "limit_reached"
  | "insufficient_points"
  | "invalid_state";

export type RedeemResult =
  | { ok: true; redemption: SchoolStoreRedemptionRow }
  | { ok: false; code: RedeemErrorCode; message: string };

export interface StudentWallet {
  earned: number;
  spent: number;
  available: number;
}

function nowIso() {
  return new Date().toISOString();
}

// "Fulfillment crew" gate — who can see and act on the redemption queue
// (approve / cancel / fulfill, and the cart banner). This is the Core Team
// PLUS the PBIS Coordinator, who owns the school-wide rewards program but
// is not otherwise on the intervention Core Team.
export function canManageStoreFulfillment(staff: {
  isSuperUser?: boolean | null;
  isDistrictAdmin?: boolean | null;
  isAdmin?: boolean | null;
  isBehaviorSpecialist?: boolean | null;
  isMtssCoordinator?: boolean | null;
  isSchoolPsychologist?: boolean | null;
  isCoreTeam?: boolean | null;
  isConfidentialSecretary?: boolean | null;
  isPbisCoordinator?: boolean | null;
}): boolean {
  return isCoreTeam(staff) || Boolean(staff.isPbisCoordinator);
}

export async function getInventoryMode(
  schoolId: number,
): Promise<StoreInventoryMode> {
  const [row] = await db
    .select({ mode: schoolSettingsTable.schoolStoreInventoryMode })
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, schoolId));
  return row?.mode === "quantity" ? "quantity" : "simple";
}

// Lifetime PBIS points earned (non-voided). Negatives are already stored
// signed at write-time per the school's pbisNegativeAffectsTotal policy, so
// a plain SUM is correct and matches the Parent Portal / Teacher Roster.
async function computeEarned(
  ex: Executor,
  schoolId: number,
  studentId: string,
): Promise<number> {
  const [row] = await ex
    .select({
      total: sql<number>`coalesce(sum(${pbisEntriesTable.points}), 0)::int`,
    })
    .from(pbisEntriesTable)
    .where(
      and(
        eq(pbisEntriesTable.schoolId, schoolId),
        eq(pbisEntriesTable.studentId, studentId),
        isNull(pbisEntriesTable.voidedAt),
      ),
    );
  // Carried-over balances imported from another PBIS platform (the
  // store-only migration path) live in pbis_point_migrations — spendable
  // here but deliberately invisible to houses/leaderboards. The "count as
  // earned" migration path instead writes pbis_entries, so those points are
  // already in the SUM above and must NOT be added again here.
  const [migrated] = await ex
    .select({
      total: sql<number>`coalesce(sum(${pbisPointMigrationsTable.points}), 0)::int`,
    })
    .from(pbisPointMigrationsTable)
    .where(
      and(
        eq(pbisPointMigrationsTable.schoolId, schoolId),
        eq(pbisPointMigrationsTable.studentId, studentId),
        isNull(pbisPointMigrationsTable.voidedAt),
      ),
    );
  return (row?.total ?? 0) + (migrated?.total ?? 0);
}

// Points currently held against the wallet (pending + fulfilled).
async function computeHeld(
  ex: Executor,
  schoolId: number,
  studentId: string,
): Promise<number> {
  const [row] = await ex
    .select({
      total: sql<number>`coalesce(sum(${schoolStoreRedemptionsTable.pointsSpent}), 0)::int`,
    })
    .from(schoolStoreRedemptionsTable)
    .where(
      and(
        eq(schoolStoreRedemptionsTable.schoolId, schoolId),
        eq(schoolStoreRedemptionsTable.studentId, studentId),
        inArray(schoolStoreRedemptionsTable.status, [...HELD_STATUSES]),
      ),
    );
  return row?.total ?? 0;
}

// Public wallet read used by every catalog/profile surface.
export async function computeWallet(
  schoolId: number,
  studentId: string,
): Promise<StudentWallet> {
  const [earned, spent] = await Promise.all([
    computeEarned(db, schoolId, studentId),
    computeHeld(db, schoolId, studentId),
  ]);
  return { earned, spent, available: earned - spent };
}

// Serialize all balance-affecting work for one student.
async function lockStudent(
  ex: Executor,
  schoolId: number,
  studentId: string,
): Promise<void> {
  await ex.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`store:${schoolId}:${studentId}`})::bigint)`,
  );
}

// Take the per-student advisory lock for the student that OWNS a given
// redemption, so lifecycle mutations (approve/fulfill/cancel) serialize with
// each other and with new redeems for the same student. Returns the
// studentId, or null if the redemption doesn't exist in this school. Callers
// MUST re-read the redemption row after this so decisions use post-lock state.
async function lockRedemptionStudent(
  ex: Executor,
  schoolId: number,
  redemptionId: number,
): Promise<string | null> {
  const [pre] = await ex
    .select({ studentId: schoolStoreRedemptionsTable.studentId })
    .from(schoolStoreRedemptionsTable)
    .where(
      and(
        eq(schoolStoreRedemptionsTable.id, redemptionId),
        eq(schoolStoreRedemptionsTable.schoolId, schoolId),
      ),
    );
  if (!pre) return null;
  await lockStudent(ex, schoolId, pre.studentId);
  return pre.studentId;
}

// Count a student's non-cancelled redemptions of a single item (for the
// per-student limit check).
async function countActiveForItem(
  ex: Executor,
  schoolId: number,
  studentId: string,
  itemId: number,
): Promise<number> {
  const [row] = await ex
    .select({ n: sql<number>`count(*)::int` })
    .from(schoolStoreRedemptionsTable)
    .where(
      and(
        eq(schoolStoreRedemptionsTable.schoolId, schoolId),
        eq(schoolStoreRedemptionsTable.studentId, studentId),
        eq(schoolStoreRedemptionsTable.itemId, itemId),
        inArray(schoolStoreRedemptionsTable.status, [...ACTIVE_STATUSES]),
      ),
    );
  return row?.n ?? 0;
}

// Atomically decrement quantity-on-hand by one, guarded so it never goes
// negative. Returns true if a unit was claimed, false if out of stock.
async function tryDecrementStock(
  ex: Executor,
  schoolId: number,
  itemId: number,
): Promise<boolean> {
  const rows = await ex
    .update(schoolStoreItemsTable)
    .set({
      quantityOnHand: sql`${schoolStoreItemsTable.quantityOnHand} - 1`,
      updatedAt: nowIso(),
    })
    .where(
      and(
        eq(schoolStoreItemsTable.id, itemId),
        eq(schoolStoreItemsTable.schoolId, schoolId),
        sql`${schoolStoreItemsTable.quantityOnHand} > 0`,
      ),
    )
    .returning({ id: schoolStoreItemsTable.id });
  return rows.length > 0;
}

async function restoreStock(
  ex: Executor,
  schoolId: number,
  itemId: number,
): Promise<void> {
  // Only restore when the item still tracks quantity (non-null).
  await ex
    .update(schoolStoreItemsTable)
    .set({
      quantityOnHand: sql`${schoolStoreItemsTable.quantityOnHand} + 1`,
      updatedAt: nowIso(),
    })
    .where(
      and(
        eq(schoolStoreItemsTable.id, itemId),
        eq(schoolStoreItemsTable.schoolId, schoolId),
        sql`${schoolStoreItemsTable.quantityOnHand} IS NOT NULL`,
      ),
    );
}

// --------------------------------------------------------------------------
// redeemItem — create a redemption. Atomic and re-entrant per student.
// --------------------------------------------------------------------------
export async function redeemItem(opts: {
  schoolId: number;
  studentId: string;
  itemId: number;
  actor: RedeemActor;
}): Promise<RedeemResult> {
  const { schoolId, studentId, itemId, actor } = opts;

  // The student must belong to this school (tenant isolation).
  const [student] = await db
    .select({ id: studentsTable.studentId })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.studentId, studentId),
        eq(studentsTable.schoolId, schoolId),
      ),
    );
  if (!student) {
    return { ok: false, code: "not_found", message: "Student not found" };
  }

  const mode = await getInventoryMode(schoolId);

  return db.transaction(async (tx) => {
    await lockStudent(tx, schoolId, studentId);

    const [item] = await tx
      .select()
      .from(schoolStoreItemsTable)
      .where(
        and(
          eq(schoolStoreItemsTable.id, itemId),
          eq(schoolStoreItemsTable.schoolId, schoolId),
        ),
      );
    if (!item) {
      return { ok: false, code: "not_found", message: "Item not found" };
    }
    if (item.archived) {
      return {
        ok: false,
        code: "archived",
        message: "This reward is no longer available",
      };
    }

    // Availability per inventory mode. A null quantity in quantity mode is
    // "untracked" → always available.
    if (mode === "simple") {
      if (!item.inStock) {
        return { ok: false, code: "out_of_stock", message: "Out of stock" };
      }
    } else if (item.quantityOnHand !== null && item.quantityOnHand <= 0) {
      return { ok: false, code: "out_of_stock", message: "Out of stock" };
    }

    // Per-student limit.
    if (item.perStudentLimit !== null) {
      const held = await countActiveForItem(tx, schoolId, studentId, itemId);
      if (held >= item.perStudentLimit) {
        return {
          ok: false,
          code: "limit_reached",
          message: `Limit of ${item.perStudentLimit} per student reached`,
        };
      }
    }

    const cost = item.pointsCost;

    if (item.requiresApproval) {
      // No points held, no stock decremented until a staff member approves.
      const [row] = await tx
        .insert(schoolStoreRedemptionsTable)
        .values({
          schoolId,
          itemId,
          studentId,
          itemName: item.name,
          pointsSpent: cost,
          status: "pending_approval",
          requestedByType: actor.type,
          requestedById: actor.type === "student" ? null : actor.id,
          stockHeld: false,
          pointsRefunded: false,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        })
        .returning();
      return { ok: true, redemption: row };
    }

    // Immediate redemption: re-check balance under the lock, then hold.
    const earned = await computeEarned(tx, schoolId, studentId);
    const heldPts = await computeHeld(tx, schoolId, studentId);
    if (earned - heldPts < cost) {
      return {
        ok: false,
        code: "insufficient_points",
        message: "Not enough points",
      };
    }

    let stockHeld = false;
    if (mode === "quantity" && item.quantityOnHand !== null) {
      const claimed = await tryDecrementStock(tx, schoolId, itemId);
      if (!claimed) {
        return { ok: false, code: "out_of_stock", message: "Out of stock" };
      }
      stockHeld = true;
    }

    const [row] = await tx
      .insert(schoolStoreRedemptionsTable)
      .values({
        schoolId,
        itemId,
        studentId,
        itemName: item.name,
        pointsSpent: cost,
        status: "pending",
        requestedByType: actor.type,
        requestedById: actor.type === "student" ? null : actor.id,
        stockHeld,
        pointsRefunded: false,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })
      .returning();
    return { ok: true, redemption: row };
  });
}

// --------------------------------------------------------------------------
// approveRedemption — pending_approval → pending. Holds points + stock now.
// --------------------------------------------------------------------------
export async function approveRedemption(opts: {
  schoolId: number;
  redemptionId: number;
  staffId: number;
}): Promise<RedeemResult> {
  const { schoolId, redemptionId, staffId } = opts;
  const mode = await getInventoryMode(schoolId);

  return db.transaction(async (tx) => {
    // Discover the student so we can take the per-student lock, then re-read
    // the row's authoritative state UNDER the lock — never decide on a
    // pre-lock snapshot.
    const studentId = await lockRedemptionStudent(tx, schoolId, redemptionId);
    if (studentId === null) {
      return { ok: false, code: "not_found", message: "Redemption not found" };
    }
    const [red] = await tx
      .select()
      .from(schoolStoreRedemptionsTable)
      .where(
        and(
          eq(schoolStoreRedemptionsTable.id, redemptionId),
          eq(schoolStoreRedemptionsTable.schoolId, schoolId),
        ),
      );
    if (!red) {
      return { ok: false, code: "not_found", message: "Redemption not found" };
    }
    if (red.status !== "pending_approval") {
      return {
        ok: false,
        code: "invalid_state",
        message: "This request is not awaiting approval",
      };
    }

    // Re-check the wallet now that we are about to hold the points.
    const earned = await computeEarned(tx, schoolId, red.studentId);
    const heldPts = await computeHeld(tx, schoolId, red.studentId);
    if (earned - heldPts < red.pointsSpent) {
      return {
        ok: false,
        code: "insufficient_points",
        message: "Student no longer has enough points",
      };
    }

    let stockHeld = false;
    if (mode === "quantity") {
      const [item] = await tx
        .select({ qty: schoolStoreItemsTable.quantityOnHand })
        .from(schoolStoreItemsTable)
        .where(
          and(
            eq(schoolStoreItemsTable.id, red.itemId),
            eq(schoolStoreItemsTable.schoolId, schoolId),
          ),
        );
      if (item && item.qty !== null) {
        const claimed = await tryDecrementStock(tx, schoolId, red.itemId);
        if (!claimed) {
          return { ok: false, code: "out_of_stock", message: "Out of stock" };
        }
        stockHeld = true;
      }
    }

    // Status-guarded transition: only flips a row still in pending_approval.
    const updated = await tx
      .update(schoolStoreRedemptionsTable)
      .set({
        status: "pending",
        approvedByStaffId: staffId,
        approvedAt: nowIso(),
        stockHeld,
        updatedAt: nowIso(),
      })
      .where(
        and(
          eq(schoolStoreRedemptionsTable.id, redemptionId),
          eq(schoolStoreRedemptionsTable.schoolId, schoolId),
          eq(schoolStoreRedemptionsTable.status, "pending_approval"),
        ),
      )
      .returning();
    if (updated.length === 0) {
      return {
        ok: false,
        code: "invalid_state",
        message: "This request is not awaiting approval",
      };
    }
    return { ok: true, redemption: updated[0] };
  });
}

// --------------------------------------------------------------------------
// fulfillRedemption — pending → fulfilled. Records the hand-off details.
// --------------------------------------------------------------------------
export async function fulfillRedemption(opts: {
  schoolId: number;
  redemptionId: number;
  staffId: number;
  deliverTeacherName?: string | null;
  deliverPeriod?: string | null;
}): Promise<RedeemResult> {
  const { schoolId, redemptionId, staffId, deliverTeacherName, deliverPeriod } =
    opts;

  return db.transaction(async (tx) => {
    // Lock the owning student so a concurrent cancel can't slip in between
    // our read and the write (which would let us overwrite a cancelled row
    // back to fulfilled, leaving stock/points inconsistent).
    const studentId = await lockRedemptionStudent(tx, schoolId, redemptionId);
    if (studentId === null) {
      return { ok: false, code: "not_found", message: "Redemption not found" };
    }
    const [red] = await tx
      .select()
      .from(schoolStoreRedemptionsTable)
      .where(
        and(
          eq(schoolStoreRedemptionsTable.id, redemptionId),
          eq(schoolStoreRedemptionsTable.schoolId, schoolId),
        ),
      );
    if (!red) {
      return { ok: false, code: "not_found", message: "Redemption not found" };
    }
    if (red.status !== "pending") {
      return {
        ok: false,
        code: "invalid_state",
        message:
          red.status === "pending_approval"
            ? "Approve this request before fulfilling it"
            : "This request cannot be fulfilled",
      };
    }

    const updated = await tx
      .update(schoolStoreRedemptionsTable)
      .set({
        status: "fulfilled",
        fulfilledByStaffId: staffId,
        fulfilledAt: nowIso(),
        deliverTeacherName: deliverTeacherName?.trim()
          ? deliverTeacherName.trim().slice(0, 120)
          : null,
        deliverPeriod: deliverPeriod?.trim()
          ? deliverPeriod.trim().slice(0, 40)
          : null,
        updatedAt: nowIso(),
      })
      .where(
        and(
          eq(schoolStoreRedemptionsTable.id, redemptionId),
          eq(schoolStoreRedemptionsTable.schoolId, schoolId),
          eq(schoolStoreRedemptionsTable.status, "pending"),
        ),
      )
      .returning();
    if (updated.length === 0) {
      return {
        ok: false,
        code: "invalid_state",
        message: "This request cannot be fulfilled",
      };
    }
    return { ok: true, redemption: updated[0] };
  });
}

// --------------------------------------------------------------------------
// cancelRedemption — refund points + restore stock. Idempotent if already
// cancelled. Can cancel from pending_approval / pending / fulfilled.
// --------------------------------------------------------------------------
export async function cancelRedemption(opts: {
  schoolId: number;
  redemptionId: number;
  staffId: number;
  reason?: string | null;
}): Promise<RedeemResult> {
  const { schoolId, redemptionId, staffId, reason } = opts;

  return db.transaction(async (tx) => {
    // Lock the owning student, then read the row's state under the lock.
    const studentId = await lockRedemptionStudent(tx, schoolId, redemptionId);
    if (studentId === null) {
      return { ok: false, code: "not_found", message: "Redemption not found" };
    }
    const [red] = await tx
      .select()
      .from(schoolStoreRedemptionsTable)
      .where(
        and(
          eq(schoolStoreRedemptionsTable.id, redemptionId),
          eq(schoolStoreRedemptionsTable.schoolId, schoolId),
        ),
      );
    if (!red) {
      return { ok: false, code: "not_found", message: "Redemption not found" };
    }
    // Idempotent: cancelling an already-cancelled row is a no-op success.
    if (red.status === "cancelled") {
      return { ok: true, redemption: red };
    }

    // Points were held only once the row left pending_approval (pending /
    // fulfilled). Restore stock ONLY if a unit was actually decremented for
    // this row — `stockHeld` tracks that precisely, so we never over-restore
    // for simple-mode or still-pending-approval rows.
    const wasHeld = red.status === "pending" || red.status === "fulfilled";
    if (red.stockHeld) {
      await restoreStock(tx, schoolId, red.itemId);
    }

    const updated = await tx
      .update(schoolStoreRedemptionsTable)
      .set({
        status: "cancelled",
        cancelledByStaffId: staffId,
        cancelledAt: nowIso(),
        cancelReason: reason?.trim() ? reason.trim().slice(0, 300) : null,
        pointsRefunded: wasHeld,
        stockHeld: false,
        updatedAt: nowIso(),
      })
      .where(
        and(
          eq(schoolStoreRedemptionsTable.id, redemptionId),
          eq(schoolStoreRedemptionsTable.schoolId, schoolId),
          eq(schoolStoreRedemptionsTable.status, red.status),
        ),
      )
      .returning();
    if (updated.length === 0) {
      // Concurrent transition under the same lock is impossible, but stay
      // safe: re-read and treat an already-cancelled row as success.
      const [fresh] = await tx
        .select()
        .from(schoolStoreRedemptionsTable)
        .where(
          and(
            eq(schoolStoreRedemptionsTable.id, redemptionId),
            eq(schoolStoreRedemptionsTable.schoolId, schoolId),
          ),
        );
      if (fresh && fresh.status === "cancelled") {
        return { ok: true, redemption: fresh };
      }
      return {
        ok: false,
        code: "invalid_state",
        message: "This request could not be cancelled",
      };
    }
    return { ok: true, redemption: updated[0] };
  });
}

// --------------------------------------------------------------------------
// listRedemptions — Core Team queue/history. Joins the student for display
// fields. NEVER returns the FLEID — not even as a hidden join/key field;
// `localSisId` is the only student id that leaves the server. Callers key
// rows off the redemption `id`.
// --------------------------------------------------------------------------
export interface RedemptionListRow {
  id: number;
  itemId: number;
  itemName: string;
  localSisId: string | null;
  studentName: string;
  grade: number | null;
  pointsSpent: number;
  status: string;
  requestedByType: string;
  createdAt: string;
  approvedAt: string | null;
  fulfilledAt: string | null;
  deliverTeacherName: string | null;
  deliverPeriod: string | null;
  cancelReason: string | null;
  pointsRefunded: boolean;
}

export async function listRedemptions(opts: {
  schoolId: number;
  status?: string;
  itemId?: number;
}): Promise<RedemptionListRow[]> {
  const { schoolId, status, itemId } = opts;
  const conds = [eq(schoolStoreRedemptionsTable.schoolId, schoolId)];
  if (status) conds.push(eq(schoolStoreRedemptionsTable.status, status));
  if (typeof itemId === "number") {
    conds.push(eq(schoolStoreRedemptionsTable.itemId, itemId));
  }
  const rows = await db
    .select({
      id: schoolStoreRedemptionsTable.id,
      itemId: schoolStoreRedemptionsTable.itemId,
      itemName: schoolStoreRedemptionsTable.itemName,
      localSisId: studentsTable.localSisId,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
      grade: studentsTable.grade,
      pointsSpent: schoolStoreRedemptionsTable.pointsSpent,
      status: schoolStoreRedemptionsTable.status,
      requestedByType: schoolStoreRedemptionsTable.requestedByType,
      createdAt: schoolStoreRedemptionsTable.createdAt,
      approvedAt: schoolStoreRedemptionsTable.approvedAt,
      fulfilledAt: schoolStoreRedemptionsTable.fulfilledAt,
      deliverTeacherName: schoolStoreRedemptionsTable.deliverTeacherName,
      deliverPeriod: schoolStoreRedemptionsTable.deliverPeriod,
      cancelReason: schoolStoreRedemptionsTable.cancelReason,
      pointsRefunded: schoolStoreRedemptionsTable.pointsRefunded,
    })
    .from(schoolStoreRedemptionsTable)
    .leftJoin(
      studentsTable,
      and(
        eq(studentsTable.studentId, schoolStoreRedemptionsTable.studentId),
        eq(studentsTable.schoolId, schoolStoreRedemptionsTable.schoolId),
      ),
    )
    .where(and(...conds))
    .orderBy(sql`${schoolStoreRedemptionsTable.createdAt} DESC`);

  return rows.map((r) => ({
    id: r.id,
    itemId: r.itemId,
    itemName: r.itemName,
    localSisId: r.localSisId ?? null,
    studentName:
      r.firstName || r.lastName
        ? `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim()
        : "Unknown student",
    grade: r.grade ?? null,
    pointsSpent: r.pointsSpent,
    status: r.status,
    requestedByType: r.requestedByType,
    createdAt: r.createdAt,
    approvedAt: r.approvedAt ?? null,
    fulfilledAt: r.fulfilledAt ?? null,
    deliverTeacherName: r.deliverTeacherName ?? null,
    deliverPeriod: r.deliverPeriod ?? null,
    cancelReason: r.cancelReason ?? null,
    pointsRefunded: r.pointsRefunded,
  }));
}

// Resolve the display name + local SIS id for a single student (used by the
// staff wallet endpoint so it never leaks the FLEID).
export async function getStudentDisplay(
  schoolId: number,
  studentId: string,
): Promise<{ localSisId: string | null; studentName: string } | null> {
  const [row] = await db
    .select({
      localSisId: studentsTable.localSisId,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
    })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.studentId, studentId),
        eq(studentsTable.schoolId, schoolId),
      ),
    );
  if (!row) return null;
  return {
    localSisId: row.localSisId ?? null,
    studentName: `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim(),
  };
}

// --------------------------------------------------------------------------
// Family / student redeem surfaces — a single FLEID-safe view of one
// student's store: their wallet, the redeemable catalog with per-student
// availability/affordability flags pre-computed, and their order history.
// The FLEID (`studentId`) is the JOIN key only; NONE of the returned shapes
// carry it — callers render `localSisId` (resolved separately) instead.
// --------------------------------------------------------------------------
export interface StoreCatalogItemView {
  id: number;
  name: string;
  description: string;
  pointsCost: number;
  hasImage: boolean;
  requiresApproval: boolean;
  perStudentLimit: number | null;
  ownedActiveCount: number;
  available: boolean;
  unavailableReason: string | null;
  affordable: boolean;
  pointsToGo: number;
}

export interface StoreOrderView {
  id: number;
  itemName: string;
  pointsSpent: number;
  status: string;
  createdAt: string;
  fulfilledAt: string | null;
  deliverTeacherName: string | null;
  deliverPeriod: string | null;
  cancelReason: string | null;
}

export interface StudentStoreView {
  wallet: StudentWallet;
  items: StoreCatalogItemView[];
  orders: StoreOrderView[];
}

// One student's redemption history (newest first). FLEID-safe.
export async function listStudentRedemptions(
  schoolId: number,
  studentId: string,
): Promise<StoreOrderView[]> {
  const rows = await db
    .select({
      id: schoolStoreRedemptionsTable.id,
      itemName: schoolStoreRedemptionsTable.itemName,
      pointsSpent: schoolStoreRedemptionsTable.pointsSpent,
      status: schoolStoreRedemptionsTable.status,
      createdAt: schoolStoreRedemptionsTable.createdAt,
      fulfilledAt: schoolStoreRedemptionsTable.fulfilledAt,
      deliverTeacherName: schoolStoreRedemptionsTable.deliverTeacherName,
      deliverPeriod: schoolStoreRedemptionsTable.deliverPeriod,
      cancelReason: schoolStoreRedemptionsTable.cancelReason,
    })
    .from(schoolStoreRedemptionsTable)
    .where(
      and(
        eq(schoolStoreRedemptionsTable.schoolId, schoolId),
        eq(schoolStoreRedemptionsTable.studentId, studentId),
      ),
    )
    .orderBy(sql`${schoolStoreRedemptionsTable.createdAt} DESC`);
  return rows.map((r) => ({
    id: r.id,
    itemName: r.itemName,
    pointsSpent: r.pointsSpent,
    status: r.status,
    createdAt: r.createdAt,
    fulfilledAt: r.fulfilledAt ?? null,
    deliverTeacherName: r.deliverTeacherName ?? null,
    deliverPeriod: r.deliverPeriod ?? null,
    cancelReason: r.cancelReason ?? null,
  }));
}

// Build the full per-student store view: wallet + catalog (with availability
// and affordability resolved exactly the way `redeemItem` will enforce them,
// so the UI's disabled-state matches the server's decision) + order history.
export async function buildStudentStoreView(
  schoolId: number,
  studentId: string,
): Promise<StudentStoreView> {
  const [wallet, mode] = await Promise.all([
    computeWallet(schoolId, studentId),
    getInventoryMode(schoolId),
  ]);

  // Active (non-cancelled) redemption counts per item — drives the
  // per-student-limit indicator without an N+1 query.
  const activeCounts = await db
    .select({
      itemId: schoolStoreRedemptionsTable.itemId,
      n: sql<number>`count(*)::int`,
    })
    .from(schoolStoreRedemptionsTable)
    .where(
      and(
        eq(schoolStoreRedemptionsTable.schoolId, schoolId),
        eq(schoolStoreRedemptionsTable.studentId, studentId),
        inArray(schoolStoreRedemptionsTable.status, [...ACTIVE_STATUSES]),
      ),
    )
    .groupBy(schoolStoreRedemptionsTable.itemId);
  const countByItem = new Map<number, number>();
  for (const r of activeCounts) countByItem.set(r.itemId, r.n);

  const rows = await db
    .select()
    .from(schoolStoreItemsTable)
    .where(
      and(
        eq(schoolStoreItemsTable.schoolId, schoolId),
        eq(schoolStoreItemsTable.archived, false),
      ),
    )
    .orderBy(schoolStoreItemsTable.sortOrder, schoolStoreItemsTable.name);

  const items: StoreCatalogItemView[] = rows.map((item) => {
    const ownedActiveCount = countByItem.get(item.id) ?? 0;
    // Stock availability mirrors redeemItem: simple mode uses the inStock
    // toggle; quantity mode treats a null quantity as untracked (available).
    const inStock =
      mode === "simple"
        ? item.inStock
        : item.quantityOnHand === null || item.quantityOnHand > 0;
    const limitReached =
      item.perStudentLimit !== null &&
      ownedActiveCount >= item.perStudentLimit;
    const affordable = wallet.available >= item.pointsCost;
    let unavailableReason: string | null = null;
    if (!inStock) {
      unavailableReason = "Out of stock";
    } else if (limitReached) {
      unavailableReason =
        item.perStudentLimit === 1
          ? "Already redeemed"
          : `Limit of ${item.perStudentLimit} reached`;
    }
    return {
      id: item.id,
      name: item.name,
      description: item.description,
      pointsCost: item.pointsCost,
      hasImage: item.imageUrl !== null,
      requiresApproval: item.requiresApproval,
      perStudentLimit: item.perStudentLimit,
      ownedActiveCount,
      available: inStock && !limitReached,
      unavailableReason,
      affordable,
      pointsToGo: Math.max(0, item.pointsCost - wallet.available),
    };
  });

  const orders = await listStudentRedemptions(schoolId, studentId);
  return { wallet, items, orders };
}

// --------------------------------------------------------------------------
// Core Team fulfillment surfaces — the queue badge counter, the
// distribution-by-class view, and the pick-sheet. All FLEID-safe (the join
// key `studentId` never appears in any returned shape; rows carry
// `localSisId` only).
// --------------------------------------------------------------------------

// Format a numeric class period as an ordinal phrase for the
// "delivered in Mrs. Martin's 3rd period soon" confirmation copy.
export function periodLabel(period: number): string {
  const n = Math.trunc(period);
  const mod100 = n % 100;
  let suffix = "th";
  if (mod100 < 11 || mod100 > 13) {
    switch (n % 10) {
      case 1:
        suffix = "st";
        break;
      case 2:
        suffix = "nd";
        break;
      case 3:
        suffix = "rd";
        break;
    }
  }
  return `${n}${suffix} period`;
}

export interface PendingFulfillmentCount {
  pending: number;
  pendingApproval: number;
  total: number;
}

// Counts that drive the pulsing cart badge: items awaiting fulfillment
// (status 'pending') and requests awaiting approval (status
// 'pending_approval'). Both are work the fulfillment crew must act on.
export async function countPendingFulfillment(
  schoolId: number,
): Promise<PendingFulfillmentCount> {
  const rows = await db
    .select({
      status: schoolStoreRedemptionsTable.status,
      n: sql<number>`count(*)::int`,
    })
    .from(schoolStoreRedemptionsTable)
    .where(
      and(
        eq(schoolStoreRedemptionsTable.schoolId, schoolId),
        inArray(schoolStoreRedemptionsTable.status, [
          "pending",
          "pending_approval",
        ]),
      ),
    )
    .groupBy(schoolStoreRedemptionsTable.status);
  let pending = 0;
  let pendingApproval = 0;
  for (const r of rows) {
    if (r.status === "pending") pending = r.n;
    else if (r.status === "pending_approval") pendingApproval = r.n;
  }
  return { pending, pendingApproval, total: pending + pendingApproval };
}

// One pending redemption, display-safe, as it appears in the distribution
// view and on the pick-sheet.
export interface FulfillmentRow {
  redemptionId: number;
  localSisId: string | null;
  studentName: string;
  grade: number | null;
  itemId: number;
  itemName: string;
  pointsSpent: number;
}

export interface FulfillmentCombo {
  teacherStaffId: number;
  teacherName: string;
  period: number;
  periodLabel: string;
  rows: FulfillmentRow[];
}

export interface FulfillmentDistribution {
  combos: FulfillmentCombo[];
  // Students with a pending redemption but no (non-planning) scheduled
  // class — they can't be slotted into a teacher/period combo, so the crew
  // fulfills them without a delivery target.
  unscheduled: FulfillmentRow[];
}

// Build the distribution-by-class view: every 'pending' (approved, points
// held) redemption mapped onto the teacher+period combos the redeeming
// student is ACTUALLY enrolled in (section_roster ⨝ class_sections ⨝ staff,
// school-scoped, non-planning). A student in several classes appears under
// each of their combos; the crew picks ONE combo to deliver to. Students
// with no schedule fall into `unscheduled`.
export async function buildFulfillmentDistribution(
  schoolId: number,
): Promise<FulfillmentDistribution> {
  // 1. Pending redemptions (display-safe), newest first.
  const pendingRows = await db
    .select({
      redemptionId: schoolStoreRedemptionsTable.id,
      studentId: schoolStoreRedemptionsTable.studentId,
      itemId: schoolStoreRedemptionsTable.itemId,
      itemName: schoolStoreRedemptionsTable.itemName,
      pointsSpent: schoolStoreRedemptionsTable.pointsSpent,
      localSisId: studentsTable.localSisId,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
      grade: studentsTable.grade,
    })
    .from(schoolStoreRedemptionsTable)
    .leftJoin(
      studentsTable,
      and(
        eq(studentsTable.studentId, schoolStoreRedemptionsTable.studentId),
        eq(studentsTable.schoolId, schoolStoreRedemptionsTable.schoolId),
      ),
    )
    .where(
      and(
        eq(schoolStoreRedemptionsTable.schoolId, schoolId),
        eq(schoolStoreRedemptionsTable.status, "pending"),
      ),
    )
    .orderBy(sql`${schoolStoreRedemptionsTable.createdAt} DESC`);

  if (pendingRows.length === 0) {
    return { combos: [], unscheduled: [] };
  }

  const toRow = (r: (typeof pendingRows)[number]): FulfillmentRow => ({
    redemptionId: r.redemptionId,
    localSisId: r.localSisId ?? null,
    studentName:
      r.firstName || r.lastName
        ? `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim()
        : "Unknown student",
    grade: r.grade ?? null,
    itemId: r.itemId,
    itemName: r.itemName,
    pointsSpent: r.pointsSpent,
  });

  // 2. Schedules for exactly the redeeming students.
  const studentIds = Array.from(new Set(pendingRows.map((r) => r.studentId)));
  const scheduleRows = await db
    .select({
      studentId: sectionRosterTable.studentId,
      teacherStaffId: classSectionsTable.teacherStaffId,
      teacherName: staffTable.displayName,
      period: classSectionsTable.period,
    })
    .from(sectionRosterTable)
    .innerJoin(
      classSectionsTable,
      eq(sectionRosterTable.sectionId, classSectionsTable.id),
    )
    .innerJoin(staffTable, eq(staffTable.id, classSectionsTable.teacherStaffId))
    .where(
      and(
        eq(sectionRosterTable.schoolId, schoolId),
        eq(classSectionsTable.schoolId, schoolId),
        eq(classSectionsTable.isPlanning, false),
        inArray(sectionRosterTable.studentId, studentIds),
      ),
    );

  // studentId -> list of combos that student is in.
  const combosByStudent = new Map<
    string,
    { teacherStaffId: number; teacherName: string; period: number }[]
  >();
  for (const s of scheduleRows) {
    const arr = combosByStudent.get(s.studentId) ?? [];
    arr.push({
      teacherStaffId: s.teacherStaffId,
      teacherName: s.teacherName,
      period: s.period,
    });
    combosByStudent.set(s.studentId, arr);
  }

  // 3. Fan each pending redemption out onto its student's combos.
  const comboMap = new Map<string, FulfillmentCombo>();
  const unscheduled: FulfillmentRow[] = [];
  for (const r of pendingRows) {
    const combos = combosByStudent.get(r.studentId);
    if (!combos || combos.length === 0) {
      unscheduled.push(toRow(r));
      continue;
    }
    for (const c of combos) {
      const key = `${c.teacherStaffId}|${c.period}`;
      let combo = comboMap.get(key);
      if (!combo) {
        combo = {
          teacherStaffId: c.teacherStaffId,
          teacherName: c.teacherName,
          period: c.period,
          periodLabel: periodLabel(c.period),
          rows: [],
        };
        comboMap.set(key, combo);
      }
      combo.rows.push(toRow(r));
    }
  }

  const combos = Array.from(comboMap.values()).sort(
    (a, b) =>
      a.teacherName.localeCompare(b.teacherName) || a.period - b.period,
  );
  return { combos, unscheduled };
}

export interface PickSheetLine {
  localSisId: string | null;
  studentName: string;
  grade: number | null;
  itemName: string;
  quantity: number;
}

export interface PickSheet {
  teacherStaffId: number;
  teacherName: string;
  period: number;
  periodLabel: string;
  lines: PickSheetLine[];
}

// The bagging list for one teacher/period combo: student → item → quantity,
// derived from that combo's pending redemptions (same schedule validation as
// the distribution view). Returns null when the teacher/period isn't a real
// combo for any pending redemption.
export async function loadPickSheet(
  schoolId: number,
  teacherStaffId: number,
  period: number,
): Promise<PickSheet | null> {
  const dist = await buildFulfillmentDistribution(schoolId);
  const combo = dist.combos.find(
    (c) => c.teacherStaffId === teacherStaffId && c.period === period,
  );
  if (!combo) return null;
  // Group by student + item into quantities (each redemption is one unit).
  const lineMap = new Map<string, PickSheetLine>();
  for (const r of combo.rows) {
    const key = `${r.localSisId ?? r.studentName}|${r.itemName}`;
    const existing = lineMap.get(key);
    if (existing) {
      existing.quantity += 1;
    } else {
      lineMap.set(key, {
        localSisId: r.localSisId,
        studentName: r.studentName,
        grade: r.grade,
        itemName: r.itemName,
        quantity: 1,
      });
    }
  }
  const lines = Array.from(lineMap.values()).sort(
    (a, b) =>
      a.studentName.localeCompare(b.studentName) ||
      a.itemName.localeCompare(b.itemName),
  );
  return {
    teacherStaffId: combo.teacherStaffId,
    teacherName: combo.teacherName,
    period: combo.period,
    periodLabel: combo.periodLabel,
    lines,
  };
}

// Convenience re-export so route code can load a full staff row for the
// fulfillment gate without re-importing the table everywhere.
export { staffTable };
