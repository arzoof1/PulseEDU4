// School Store CRUD — school-wide catalog of rewards a student can "buy"
// with their PBIS points. Unlike the classroom store (per-teacher), this
// list is shared across the school: any signed-in staff member can read
// it, but writes are gated to roles that own the school-wide rewards
// program — admins, Behavior Specialists, MTSS Coordinators, and PBIS
// Coordinators. Plain teachers can only browse.
//
// Routes:
//   GET    /api/school-store          → list this school's items
//   POST   /api/school-store          → create (admin / BS / MTSS / PBIS coord)
//   PATCH  /api/school-store/:id      → edit   (admin / BS / MTSS / PBIS coord)
//   DELETE /api/school-store/:id      → delete (admin / BS / MTSS / PBIS coord;
//                                        hard delete — no redemption history
//                                        exists yet, so safe to remove)
import { Router, type IRouter } from "express";
import {
  db,
  schoolStoreItemsTable,
  schoolStoreRedemptionsTable,
  staffTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import { bindObjectToSchool } from "./storage.js";
import {
  redeemItem,
  approveRedemption,
  cancelRedemption,
  fulfillRedemption,
  listRedemptions,
  computeWallet,
  getStudentDisplay,
  canManageStoreFulfillment,
  countPendingFulfillment,
  buildFulfillmentDistribution,
  loadPickSheet,
  type RedeemResult,
} from "../lib/storeRedemptions.js";
import PDFDocument from "pdfkit";

// Map a redemption-engine failure code to an HTTP status.
function redeemErrorStatus(code: string): number {
  switch (code) {
    case "not_found":
      return 404;
    case "insufficient_points":
    case "out_of_stock":
    case "limit_reached":
    case "archived":
    case "invalid_state":
      return 409;
    default:
      return 400;
  }
}

// Sanitize a raw redemption row for the wire. The FLEID (`studentId`) must
// NEVER leave the server — strip it and attach the display-safe `localSisId`
// + student name (looked up school-scoped). Everything else on the row is
// non-PII operational state the Core Team UI needs.
async function sendRedeemResult(
  res: import("express").Response,
  schoolId: number,
  result: RedeemResult,
  okStatus = 200,
) {
  if (result.ok) {
    const { studentId, ...rest } = result.redemption;
    const display = await getStudentDisplay(schoolId, studentId);
    res.status(okStatus).json({
      ...rest,
      localSisId: display?.localSisId ?? null,
      studentName: display?.studentName ?? "Unknown student",
    });
    return;
  }
  res
    .status(redeemErrorStatus(result.code))
    .json({ error: result.message, code: result.code });
}

// Parse + validate an optional non-negative integer body field. Returns
// `undefined` when the field is absent, `null` when explicitly cleared, a
// number when valid, or the sentinel `INVALID` when malformed.
const INVALID = Symbol("invalid");
function parseOptionalNonNegInt(
  value: unknown,
): number | null | undefined | typeof INVALID {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return INVALID;
  return n;
}

const router: IRouter = Router();

async function loadStaff(
  req: import("express").Request,
  res: import("express").Response,
) {
  const staffId = req.staffId;
  if (!staffId) {
    res.status(401).json({ error: "Sign-in required" });
    return null;
  }
  const [staff] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, staffId));
  if (!staff || !staff.active) {
    res.status(401).json({ error: "Sign-in required" });
    return null;
  }
  return staff;
}

// Write access to the school-wide rewards catalog is shared by every role
// that "owns" the school-wide PBIS program: SuperUsers (district-wide),
// admins (everything), Behavior Specialists, MTSS Coordinators, and PBIS
// Coordinators. Plain teachers (and any other role) get a 403. Kept in
// sync with the client's `canEditSchoolStore` in App.tsx.
function hasStoreWriteAccess(staff: typeof staffTable.$inferSelect): boolean {
  return Boolean(
    staff.isSuperUser ||
      staff.isAdmin ||
      staff.isBehaviorSpecialist ||
      staff.isMtssCoordinator ||
      staff.isPbisCoordinator,
  );
}

function requireWriteAccess(
  staff: typeof staffTable.$inferSelect,
  res: import("express").Response,
) {
  const allowed = hasStoreWriteAccess(staff);
  if (!allowed) {
    res.status(403).json({
      error:
        "Only admins, Behavior Specialists, MTSS Coordinators, and PBIS Coordinators can edit the school store",
    });
    return false;
  }
  return true;
}

// Purchasing on behalf of a student is shared by the catalog owners
// (hasStoreWriteAccess) AND the fulfillment crew (Core Team + PBIS
// coordinator, via canManageStoreFulfillment) who run the redemption
// queue. Kept in sync with the client's `canPurchaseSchoolStore`
// (canEditSchoolStore || canFulfillStore) in App.tsx.
function requirePurchaseAccess(
  staff: typeof staffTable.$inferSelect,
  res: import("express").Response,
): boolean {
  if (!(hasStoreWriteAccess(staff) || canManageStoreFulfillment(staff))) {
    res.status(403).json({
      error:
        "Only the school store crew or the Core Team can purchase on behalf of a student",
    });
    return false;
  }
  return true;
}

function nowIso() {
  return new Date().toISOString();
}

// ---- LIST ----
// Any signed-in staffer in the school can read the catalog.
router.get("/school-store", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const rows = await db
    .select()
    .from(schoolStoreItemsTable)
    .where(eq(schoolStoreItemsTable.schoolId, schoolId))
    .orderBy(
      schoolStoreItemsTable.archived,
      schoolStoreItemsTable.sortOrder,
      schoolStoreItemsTable.name,
    );
  res.json(rows);
});

// ---- CREATE ----
router.post("/school-store", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!requireWriteAccess(staff, res)) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const {
    name,
    description,
    pointsCost,
    imageUrl,
    inStock,
    quantityOnHand,
    perStudentLimit,
    requiresApproval,
  } = req.body ?? {};
  if (typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const cleanName = name.trim().slice(0, 80);
  const cleanDesc =
    typeof description === "string" ? description.trim().slice(0, 500) : "";
  let pts = 1;
  if (pointsCost !== undefined && pointsCost !== null) {
    const n = Number(pointsCost);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      res
        .status(400)
        .json({ error: "pointsCost must be a non-negative integer" });
      return;
    }
    pts = n;
  }
  const qty = parseOptionalNonNegInt(quantityOnHand);
  if (qty === INVALID) {
    res
      .status(400)
      .json({ error: "quantityOnHand must be a non-negative integer or null" });
    return;
  }
  const perStudent = parseOptionalNonNegInt(perStudentLimit);
  if (perStudent === INVALID || perStudent === 0) {
    res.status(400).json({
      error: "perStudentLimit must be a positive integer or null",
    });
    return;
  }
  let cleanImage: string | null = null;
  if (typeof imageUrl === "string" && imageUrl.trim()) {
    // Only accept normalized object-storage paths to avoid storing arbitrary
    // off-site URLs.
    const t = imageUrl.trim();
    if (!t.startsWith("/objects/")) {
      res
        .status(400)
        .json({ error: "imageUrl must be a stored object path" });
      return;
    }
    cleanImage = t.slice(0, 500);
  }
  // Default sort_order: append at the end of the school's list.
  const [{ maxOrder }] = await db
    .select({
      maxOrder: sql<number>`coalesce(max(${schoolStoreItemsTable.sortOrder}), -1)`,
    })
    .from(schoolStoreItemsTable)
    .where(eq(schoolStoreItemsTable.schoolId, schoolId));
  const order = (maxOrder ?? -1) + 1;
  const [row] = await db
    .insert(schoolStoreItemsTable)
    .values({
      schoolId,
      name: cleanName,
      description: cleanDesc,
      pointsCost: pts,
      imageUrl: cleanImage,
      sortOrder: order,
      archived: false,
      inStock: typeof inStock === "boolean" ? inStock : true,
      quantityOnHand: qty === undefined ? null : qty,
      perStudentLimit: perStudent === undefined ? null : perStudent,
      requiresApproval:
        typeof requiresApproval === "boolean" ? requiresApproval : false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .returning();
  // Bind the uploaded image to this school so cross-tenant reads are blocked.
  // If binding refuses (no upload URL was issued to this school for this
  // path, or it's already owned by someone else), tear the row back down
  // and reject — we don't want to persist a thumbnail we can't serve.
  if (row.imageUrl) {
    let bound = false;
    try {
      bound = await bindObjectToSchool(row.imageUrl, schoolId);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[schoolStore] failed to bind image ACL", e);
    }
    if (!bound) {
      await db
        .delete(schoolStoreItemsTable)
        .where(eq(schoolStoreItemsTable.id, row.id));
      res.status(400).json({ error: "Invalid imageUrl" });
      return;
    }
  }
  res.status(201).json(row);
});

// ---- UPDATE ----
router.patch("/school-store/:id", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!requireWriteAccess(staff, res)) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [existing] = await db
    .select()
    .from(schoolStoreItemsTable)
    .where(
      and(
        eq(schoolStoreItemsTable.id, id),
        eq(schoolStoreItemsTable.schoolId, schoolId),
      ),
    );
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const {
    name,
    description,
    pointsCost,
    imageUrl,
    archived,
    sortOrder,
    inStock,
    quantityOnHand,
    perStudentLimit,
    requiresApproval,
  } = req.body ?? {};
  const updates: Partial<typeof schoolStoreItemsTable.$inferInsert> = {};
  if (typeof name === "string" && name.trim()) {
    updates.name = name.trim().slice(0, 80);
  }
  if (typeof description === "string") {
    updates.description = description.trim().slice(0, 500);
  }
  if (pointsCost !== undefined && pointsCost !== null) {
    const n = Number(pointsCost);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      res
        .status(400)
        .json({ error: "pointsCost must be a non-negative integer" });
      return;
    }
    updates.pointsCost = n;
  }
  if (imageUrl !== undefined) {
    if (imageUrl === null || imageUrl === "") {
      updates.imageUrl = null;
    } else if (typeof imageUrl === "string" && imageUrl.trim()) {
      const t = imageUrl.trim();
      if (!t.startsWith("/objects/")) {
        res
          .status(400)
          .json({ error: "imageUrl must be a stored object path" });
        return;
      }
      updates.imageUrl = t.slice(0, 500);
    }
  }
  if (typeof archived === "boolean") updates.archived = archived;
  if (sortOrder !== undefined) {
    if (typeof sortOrder !== "number" || !Number.isInteger(sortOrder)) {
      res.status(400).json({ error: "sortOrder must be an integer" });
      return;
    }
    updates.sortOrder = sortOrder;
  }
  if (typeof inStock === "boolean") updates.inStock = inStock;
  if (typeof requiresApproval === "boolean") {
    updates.requiresApproval = requiresApproval;
  }
  if (quantityOnHand !== undefined) {
    const qty = parseOptionalNonNegInt(quantityOnHand);
    if (qty === INVALID) {
      res.status(400).json({
        error: "quantityOnHand must be a non-negative integer or null",
      });
      return;
    }
    updates.quantityOnHand = qty;
  }
  if (perStudentLimit !== undefined) {
    const perStudent = parseOptionalNonNegInt(perStudentLimit);
    if (perStudent === INVALID || perStudent === 0) {
      res.status(400).json({
        error: "perStudentLimit must be a positive integer or null",
      });
      return;
    }
    updates.perStudentLimit = perStudent;
  }
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No updates" });
    return;
  }
  updates.updatedAt = nowIso();
  // If the image was swapped to a new object, validate the bind FIRST and
  // refuse the whole update if we can't claim it. We do this before writing
  // the row so a failed claim doesn't mutate state.
  if (
    typeof updates.imageUrl === "string" &&
    updates.imageUrl !== existing.imageUrl
  ) {
    let bound = false;
    try {
      bound = await bindObjectToSchool(updates.imageUrl, schoolId);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[schoolStore] failed to bind image ACL", e);
    }
    if (!bound) {
      res.status(400).json({ error: "Invalid imageUrl" });
      return;
    }
  }
  const [row] = await db
    .update(schoolStoreItemsTable)
    .set(updates)
    .where(
      and(
        eq(schoolStoreItemsTable.id, id),
        eq(schoolStoreItemsTable.schoolId, schoolId),
      ),
    )
    .returning();
  res.json(row);
});

// ---- DELETE ----
router.delete("/school-store/:id", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!requireWriteAccess(staff, res)) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [existing] = await db
    .select()
    .from(schoolStoreItemsTable)
    .where(
      and(
        eq(schoolStoreItemsTable.id, id),
        eq(schoolStoreItemsTable.schoolId, schoolId),
      ),
    );
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  // Preserve redemption history: once a student has redeemed this item we
  // refuse the hard delete so the ledger (and the wallet math derived from
  // it) stays intact. The caller should archive the item instead.
  const [{ refs }] = await db
    .select({ refs: sql<number>`count(*)::int` })
    .from(schoolStoreRedemptionsTable)
    .where(
      and(
        eq(schoolStoreRedemptionsTable.schoolId, schoolId),
        eq(schoolStoreRedemptionsTable.itemId, id),
      ),
    );
  if (refs > 0) {
    res.status(409).json({
      error:
        "This item has redemption history and can't be deleted. Archive it instead.",
      code: "has_redemptions",
    });
    return;
  }
  await db
    .delete(schoolStoreItemsTable)
    .where(
      and(
        eq(schoolStoreItemsTable.id, id),
        eq(schoolStoreItemsTable.schoolId, schoolId),
      ),
    );
  res.json({ ok: true });
});

// =========================================================================
// Redemption engine — staff-facing endpoints. Family (Parent Portal) and
// student (ClassLink) redeem surfaces are added in their own tasks; they
// call the same `../lib/storeRedemptions` helpers from their auth contexts.
// =========================================================================

// Gate for the fulfillment queue (list / approve / cancel / fulfill) and the
// staff wallet read. Wider than the catalog-write gate: it includes the full
// Core Team plus the PBIS Coordinator.
function requireFulfillmentAccess(
  staff: typeof staffTable.$inferSelect,
  res: import("express").Response,
): boolean {
  if (!canManageStoreFulfillment(staff)) {
    res.status(403).json({
      error: "Only the Core Team can manage School Store redemptions",
    });
    return false;
  }
  return true;
}

function parseRedemptionId(
  req: import("express").Request,
  res: import("express").Response,
): number | null {
  const rid = Number(req.params.rid);
  if (!Number.isInteger(rid) || rid < 1) {
    res.status(400).json({ error: "Invalid redemption id" });
    return null;
  }
  return rid;
}

// ---- WALLET (staff read) ----
// `studentId` here is the FLEID join key (path param), never rendered. The
// response carries `localSisId` for display.
router.get("/school-store/wallet/:studentId", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  // Reading a student's points wallet is a store-management action: gate it
  // to the same staff who can redeem on their behalf (write access) or run
  // the fulfillment queue. A plain teacher does not get arbitrary
  // student-wallet lookups through this endpoint.
  if (
    !(
      hasStoreWriteAccess(staff) ||
      canManageStoreFulfillment(staff)
    )
  ) {
    res.status(403).json({
      error: "You don't have access to School Store wallets",
    });
    return;
  }
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const studentId = String(req.params.studentId || "").trim();
  if (!studentId) {
    res.status(400).json({ error: "studentId is required" });
    return;
  }
  const display = await getStudentDisplay(schoolId, studentId);
  if (!display) {
    res.status(404).json({ error: "Student not found" });
    return;
  }
  const wallet = await computeWallet(schoolId, studentId);
  // NEVER echo the FLEID (path-param `studentId`) back in the body. The
  // caller already holds the id it queried with; the response carries only
  // the display-safe `localSisId`.
  res.json({
    localSisId: display.localSisId,
    studentName: display.studentName,
    ...wallet,
  });
});

// ---- REDEEM ON BEHALF (staff) ----
router.post("/school-store/:id/redeem", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!requirePurchaseAccess(staff, res)) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const itemId = Number(req.params.id);
  if (!Number.isInteger(itemId) || itemId < 1) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const studentId = String(req.body?.studentId || "").trim();
  if (!studentId) {
    res.status(400).json({ error: "studentId is required" });
    return;
  }
  const result = await redeemItem({
    schoolId,
    studentId,
    itemId,
    actor: { type: "staff", id: staff.id },
  });
  await sendRedeemResult(res, schoolId, result, 201);
});

// ---- LIST REDEMPTIONS (Core Team) ----
router.get("/school-store/redemptions", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!requireFulfillmentAccess(staff, res)) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const allowed = ["pending_approval", "pending", "fulfilled", "cancelled"];
  const statusRaw =
    typeof req.query.status === "string" ? req.query.status : undefined;
  if (statusRaw && !allowed.includes(statusRaw)) {
    res.status(400).json({ error: "Invalid status filter" });
    return;
  }
  let itemId: number | undefined;
  if (typeof req.query.itemId === "string" && req.query.itemId) {
    const n = Number(req.query.itemId);
    if (!Number.isInteger(n) || n < 1) {
      res.status(400).json({ error: "Invalid itemId filter" });
      return;
    }
    itemId = n;
  }
  const rows = await listRedemptions({ schoolId, status: statusRaw, itemId });
  res.json(rows);
});

// ---- APPROVE (Core Team) ----
router.post("/school-store/redemptions/:rid/approve", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!requireFulfillmentAccess(staff, res)) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const rid = parseRedemptionId(req, res);
  if (rid === null) return;
  const result = await approveRedemption({
    schoolId,
    redemptionId: rid,
    staffId: staff.id,
  });
  await sendRedeemResult(res, schoolId, result);
});

// ---- FULFILL (Core Team) ----
router.post("/school-store/redemptions/:rid/fulfill", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!requireFulfillmentAccess(staff, res)) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const rid = parseRedemptionId(req, res);
  if (rid === null) return;
  const deliverTeacherName =
    typeof req.body?.deliverTeacherName === "string"
      ? req.body.deliverTeacherName
      : null;
  const deliverPeriod =
    typeof req.body?.deliverPeriod === "string" ? req.body.deliverPeriod : null;
  const result = await fulfillRedemption({
    schoolId,
    redemptionId: rid,
    staffId: staff.id,
    deliverTeacherName,
    deliverPeriod,
  });
  await sendRedeemResult(res, schoolId, result);
});

// ---- CANCEL / REFUND (Core Team) ----
router.post("/school-store/redemptions/:rid/cancel", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!requireFulfillmentAccess(staff, res)) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const rid = parseRedemptionId(req, res);
  if (rid === null) return;
  const reason =
    typeof req.body?.reason === "string" ? req.body.reason : null;
  const result = await cancelRedemption({
    schoolId,
    redemptionId: rid,
    staffId: staff.id,
    reason,
  });
  await sendRedeemResult(res, schoolId, result);
});

// ---- PENDING COUNT (Core Team) ----
// Drives the pulsing cart badge. Polled, so keep it cheap.
router.get("/school-store/pending-count", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!requireFulfillmentAccess(staff, res)) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const counts = await countPendingFulfillment(schoolId);
  res.json(counts);
});

// ---- DISTRIBUTION BY CLASS (Core Team) ----
// Pending redemptions mapped onto the teacher+period combos the redeeming
// students are actually enrolled in, plus an `unscheduled` bucket.
router.get("/school-store/distribution", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!requireFulfillmentAccess(staff, res)) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const distribution = await buildFulfillmentDistribution(schoolId);
  res.json(distribution);
});

// ---- PICK-SHEET PDF (Core Team) ----
// The bagging list for one teacher/period combo. Streamed as a download
// (never opened/printed in a tab — the preview iframe blob gotcha). Renders
// localSisId only; the FLEID never appears.
router.get("/school-store/pick-sheet.pdf", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!requireFulfillmentAccess(staff, res)) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const teacherStaffId = Number(req.query.teacherStaffId);
  const period = Number(req.query.period);
  if (!Number.isInteger(teacherStaffId) || teacherStaffId < 1) {
    res.status(400).json({ error: "Invalid teacherStaffId" });
    return;
  }
  if (!Number.isInteger(period)) {
    res.status(400).json({ error: "Invalid period" });
    return;
  }
  const sheet = await loadPickSheet(schoolId, teacherStaffId, period);
  if (!sheet) {
    res
      .status(404)
      .json({ error: "No pending redemptions for that class right now" });
    return;
  }

  const safeName = sheet.teacherName.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="pick-sheet-${safeName}-period-${sheet.period}.pdf"`,
  );

  const doc = new PDFDocument({ size: "LETTER", margin: 50 });
  doc.pipe(res);

  doc
    .fontSize(20)
    .font("Helvetica-Bold")
    .text("School Store Pick Sheet", { align: "left" });
  doc
    .moveDown(0.3)
    .fontSize(13)
    .font("Helvetica")
    .text(`${sheet.teacherName} — ${sheet.periodLabel}`);
  doc
    .moveDown(0.1)
    .fontSize(10)
    .fillColor("#64748b")
    .text(
      `Generated ${new Date().toLocaleString("en-US")} · ${sheet.lines.length} line item${sheet.lines.length === 1 ? "" : "s"}`,
    );
  doc.fillColor("#0f172a");
  doc.moveDown(0.8);

  // Column layout.
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const colStudent = left;
  const colId = left + 200;
  const colItem = left + 300;
  const colQty = right - 40;

  function drawHeader() {
    doc.fontSize(10).font("Helvetica-Bold").fillColor("#334155");
    const y = doc.y;
    doc.text("Student", colStudent, y);
    doc.text("SIS ID", colId, y);
    doc.text("Item", colItem, y, { width: colQty - colItem - 8 });
    doc.text("Qty", colQty, y);
    doc.moveDown(0.4);
    doc
      .moveTo(left, doc.y)
      .lineTo(right, doc.y)
      .strokeColor("#cbd5e1")
      .stroke();
    doc.moveDown(0.3);
    doc.fillColor("#0f172a").font("Helvetica");
  }
  drawHeader();

  for (const line of sheet.lines) {
    if (doc.y > doc.page.height - doc.page.margins.bottom - 40) {
      doc.addPage();
      drawHeader();
    }
    const y = doc.y;
    doc.fontSize(11).font("Helvetica");
    const gradeSuffix = line.grade !== null ? ` (Gr ${line.grade})` : "";
    doc.text(`${line.studentName}${gradeSuffix}`, colStudent, y, {
      width: colId - colStudent - 8,
    });
    doc.text(line.localSisId ?? "—", colId, y, {
      width: colItem - colId - 8,
    });
    doc.text(line.itemName, colItem, y, {
      width: colQty - colItem - 8,
    });
    doc.font("Helvetica-Bold").text(String(line.quantity), colQty, y);
    doc.moveDown(0.6);
  }

  doc.end();
});

export default router;
