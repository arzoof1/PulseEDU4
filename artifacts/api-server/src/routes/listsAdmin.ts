// Manage controlled vocabularies used elsewhere in PulseED:
//   - PBIS Reasons (positive behaviors awarded to students)
//   - Classroom Intervention Types
//
// Public read endpoints (any signed-in staff). Write endpoints gated by role:
//   PBIS Reasons      -> admin OR PBIS coordinator
//   Intervention list -> admin OR behavior specialist
//
// Modeled directly on accommodationsAdmin.ts.

import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  db,
  pbisReasonsTable,
  pbisNoteTemplatesTable,
  interventionTypesTable,
  trustedAdultInterventionsTable,
  staffTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";

const router: IRouter = Router();

async function loadStaff(req: Request, res: Response) {
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

function requireRole(check: (s: typeof staffTable.$inferSelect) => boolean, label: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const staff = await loadStaff(req, res);
    if (!staff) return;
    if (!check(staff)) {
      res.status(403).json({ error: `${label} only` });
      return;
    }
    (req as Request & { staff: typeof staff }).staff = staff;
    next();
  };
}

// School-wide PBIS rows (rubric + templates) can only be edited by admins,
// behavior specialists, and MTSS coordinators. PBIS coordinator and rank-and-
// file teachers can manage their OWN classroom-scope rows (see per-row checks
// further down in this file).
const requireSchoolPbisAdmin = requireRole(
  (s) => s.isAdmin || s.isBehaviorSpecialist || s.isMtssCoordinator,
  "Admin, behavior specialist, or MTSS coordinator",
);

// Helper used in per-row write paths: can the caller edit this row?
//   - school-scope row → admin / BS / MTSS
//   - teacher-scope row → admin OR the owning teacher
function canWriteRow(
  staff: typeof staffTable.$inferSelect,
  row: { ownerScope: string; ownerStaffId: number | null },
) {
  if (row.ownerScope === "school") {
    return !!(staff.isAdmin || staff.isBehaviorSpecialist || staff.isMtssCoordinator);
  }
  // teacher-scope
  return !!staff.isAdmin || row.ownerStaffId === staff.id;
}

function normalizeScope(v: unknown): "school" | "teacher" | null {
  if (v === "school" || v === "teacher") return v;
  return null;
}
const requireInterventionAdmin = requireRole(
  (s) =>
    s.isAdmin || s.isBehaviorSpecialist || s.isMtssCoordinator || s.isDean,
  "Admin, behavior specialist, MTSS coordinator, or dean",
);

// ---- PBIS Reasons ----

// GET /pbis-reasons[?scope=school|mine|all]
//   school → only school-wide rows
//   mine   → only the caller's own teacher-scope rows
//   all    → school-wide rows + caller's own teacher-scope rows (default)
router.get("/pbis-reasons", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const scope = (req.query.scope as string | undefined) ?? "all";
  const wantSchool = scope === "school" || scope === "all";
  const wantMine = scope === "mine" || scope === "all";
  const ownerOr =
    wantSchool && wantMine
      ? sql`(${pbisReasonsTable.ownerScope} = 'school' OR (${pbisReasonsTable.ownerScope} = 'teacher' AND ${pbisReasonsTable.ownerStaffId} = ${staff.id}))`
      : wantSchool
        ? sql`${pbisReasonsTable.ownerScope} = 'school'`
        : sql`${pbisReasonsTable.ownerScope} = 'teacher' AND ${pbisReasonsTable.ownerStaffId} = ${staff.id}`;
  const rows = await db
    .select()
    .from(pbisReasonsTable)
    .where(and(eq(pbisReasonsTable.schoolId, schoolId), ownerOr))
    .orderBy(
      pbisReasonsTable.category,
      pbisReasonsTable.sortOrder,
      pbisReasonsTable.name,
    );
  res.json(rows);
});

function normalizePolarity(v: unknown): "positive" | "negative" | null {
  if (v === undefined) return "positive"; // default for new rows
  if (v === "positive" || v === "negative") return v;
  return null;
}

// POST /pbis-reasons
//   body: { name, category?, defaultPoints?, polarity?, sortOrder?, scope? }
//   scope='school'  → admin/BS/MTSS; ownerStaffId=null
//   scope='teacher' → any signed-in staff; ownerStaffId=<caller>
router.post("/pbis-reasons", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const scope = normalizeScope(req.body?.scope) ?? "school";
  if (scope === "school") {
    if (!(staff.isAdmin || staff.isBehaviorSpecialist || staff.isMtssCoordinator)) {
      res
        .status(403)
        .json({ error: "Admin, behavior specialist, or MTSS coordinator only" });
      return;
    }
  }
  const { name, category, defaultPoints, polarity, sortOrder } = req.body ?? {};
  if (typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const cat =
    typeof category === "string" && category.trim() ? category.trim() : "General";
  let pts = 1;
  if (defaultPoints !== undefined && defaultPoints !== null) {
    const n = Number(defaultPoints);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
      res
        .status(400)
        .json({ error: "defaultPoints must be a positive integer" });
      return;
    }
    pts = n;
  }
  const pol = normalizePolarity(polarity);
  if (!pol) {
    res.status(400).json({ error: "polarity must be 'positive' or 'negative'" });
    return;
  }
  // Duplicate-name check is scoped to the same owner so two teachers can have
  // a "Participation" behavior without colliding, but a single owner can't
  // have two with the same name.
  const ownerEq =
    scope === "school"
      ? sql`${pbisReasonsTable.ownerScope} = 'school'`
      : sql`${pbisReasonsTable.ownerScope} = 'teacher' AND ${pbisReasonsTable.ownerStaffId} = ${staff.id}`;
  const existing = await db
    .select()
    .from(pbisReasonsTable)
    .where(
      and(
        eq(pbisReasonsTable.schoolId, schoolId),
        ownerEq,
        sql`lower(${pbisReasonsTable.name}) = lower(${name.trim()})`,
      ),
    );
  if (existing.length > 0) {
    res.status(409).json({ error: "Behavior name already exists" });
    return;
  }
  // Default sort_order = max(existing in same owner+category) + 1, so new
  // tiles land at the end of their category instead of jumping to position 0.
  let order = 0;
  if (typeof sortOrder === "number" && Number.isInteger(sortOrder)) {
    order = sortOrder;
  } else {
    const [{ maxOrder }] = await db
      .select({ maxOrder: sql<number>`coalesce(max(${pbisReasonsTable.sortOrder}), -1)` })
      .from(pbisReasonsTable)
      .where(
        and(
          eq(pbisReasonsTable.schoolId, schoolId),
          ownerEq,
          eq(pbisReasonsTable.category, cat),
        ),
      );
    order = (maxOrder ?? -1) + 1;
  }
  const [row] = await db
    .insert(pbisReasonsTable)
    .values({
      schoolId,
      name: name.trim(),
      category: cat,
      defaultPoints: pts,
      polarity: pol,
      sortOrder: order,
      active: true,
      ownerScope: scope,
      ownerStaffId: scope === "teacher" ? staff.id : null,
    })
    .returning();
  res.status(201).json(row);
});

router.patch("/pbis-reasons/:id", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const { name, category, defaultPoints, active, polarity, sortOrder } =
    req.body ?? {};
  const updates: Partial<typeof pbisReasonsTable.$inferInsert> = {};
  if (typeof name === "string" && name.trim()) updates.name = name.trim();
  if (typeof category === "string" && category.trim())
    updates.category = category.trim();
  if (defaultPoints !== undefined && defaultPoints !== null) {
    const n = Number(defaultPoints);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
      res
        .status(400)
        .json({ error: "defaultPoints must be a positive integer" });
      return;
    }
    updates.defaultPoints = n;
  }
  if (typeof active === "boolean") updates.active = active;
  if (polarity !== undefined) {
    if (polarity !== "positive" && polarity !== "negative") {
      res
        .status(400)
        .json({ error: "polarity must be 'positive' or 'negative'" });
      return;
    }
    updates.polarity = polarity;
  }
  if (sortOrder !== undefined) {
    if (typeof sortOrder !== "number" || !Number.isInteger(sortOrder)) {
      res.status(400).json({ error: "sortOrder must be an integer" });
      return;
    }
    updates.sortOrder = sortOrder;
  }
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No updates" });
    return;
  }
  // Per-row scope check: load existing row, then verify the caller can edit it.
  const [existing] = await db
    .select()
    .from(pbisReasonsTable)
    .where(
      and(
        eq(pbisReasonsTable.id, id),
        eq(pbisReasonsTable.schoolId, schoolId),
      ),
    );
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (!canWriteRow(staff, existing)) {
    res.status(403).json({ error: "Not allowed to edit this behavior" });
    return;
  }
  const [row] = await db
    .update(pbisReasonsTable)
    .set(updates)
    .where(
      and(
        eq(pbisReasonsTable.id, id),
        eq(pbisReasonsTable.schoolId, schoolId),
      ),
    )
    .returning();
  res.json(row);
});

// Batch reorder. Body: { items: [{id, sortOrder, category?}] }.
// Every targeted row must belong to the caller's school AND be writable by
// the caller (per-row scope check) — any disallowed id rejects the whole batch
// before any writes happen.
router.post("/pbis-reasons/reorder", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const items = req.body?.items;
  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: "items array required" });
    return;
  }
  for (const it of items) {
    if (
      !it ||
      typeof it.id !== "number" ||
      !Number.isInteger(it.id) ||
      typeof it.sortOrder !== "number" ||
      !Number.isInteger(it.sortOrder)
    ) {
      res
        .status(400)
        .json({ error: "each item needs integer id and sortOrder" });
      return;
    }
    if (it.category !== undefined && typeof it.category !== "string") {
      res.status(400).json({ error: "category must be a string" });
      return;
    }
  }
  const ids = items.map((i: { id: number }) => i.id);
  const owned = await db
    .select({
      id: pbisReasonsTable.id,
      ownerScope: pbisReasonsTable.ownerScope,
      ownerStaffId: pbisReasonsTable.ownerStaffId,
    })
    .from(pbisReasonsTable)
    .where(
      and(
        eq(pbisReasonsTable.schoolId, schoolId),
        sql`${pbisReasonsTable.id} = ANY(${ids})`,
      ),
    );
  if (owned.length !== ids.length) {
    res.status(403).json({ error: "Some behaviors are not in your school" });
    return;
  }
  for (const row of owned) {
    if (!canWriteRow(staff, row)) {
      res
        .status(403)
        .json({ error: "Not allowed to reorder one of these behaviors" });
      return;
    }
  }
  // Wrap in a transaction so a partial failure can't leave the rubric in a
  // half-reordered state across two concurrent drag operations.
  await db.transaction(async (tx) => {
    for (const it of items) {
      const upd: Partial<typeof pbisReasonsTable.$inferInsert> = {
        sortOrder: it.sortOrder,
      };
      if (typeof it.category === "string" && it.category.trim()) {
        upd.category = it.category.trim();
      }
      await tx
        .update(pbisReasonsTable)
        .set(upd)
        .where(
          and(
            eq(pbisReasonsTable.id, it.id),
            eq(pbisReasonsTable.schoolId, schoolId),
          ),
        );
    }
  });
  res.json({ ok: true, count: items.length });
});

// ---- PBIS Note Templates ----
// Per-school library of reusable note text. Any signed-in staff can READ
// (so they show up in the bulk-award picker), but only PBIS admins can write.

router.get("/pbis-note-templates", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const scope = (req.query.scope as string | undefined) ?? "all";
  const wantSchool = scope === "school" || scope === "all";
  const wantMine = scope === "mine" || scope === "all";
  const ownerOr =
    wantSchool && wantMine
      ? sql`(${pbisNoteTemplatesTable.ownerScope} = 'school' OR (${pbisNoteTemplatesTable.ownerScope} = 'teacher' AND ${pbisNoteTemplatesTable.ownerStaffId} = ${staff.id}))`
      : wantSchool
        ? sql`${pbisNoteTemplatesTable.ownerScope} = 'school'`
        : sql`${pbisNoteTemplatesTable.ownerScope} = 'teacher' AND ${pbisNoteTemplatesTable.ownerStaffId} = ${staff.id}`;
  const rows = await db
    .select()
    .from(pbisNoteTemplatesTable)
    .where(and(eq(pbisNoteTemplatesTable.schoolId, schoolId), ownerOr))
    .orderBy(pbisNoteTemplatesTable.sortOrder, pbisNoteTemplatesTable.title);
  res.json(rows);
});

router.post("/pbis-note-templates", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const tplScope = normalizeScope(req.body?.scope) ?? "school";
  if (tplScope === "school") {
    if (!(staff.isAdmin || staff.isBehaviorSpecialist || staff.isMtssCoordinator)) {
      res
        .status(403)
        .json({ error: "Admin, behavior specialist, or MTSS coordinator only" });
      return;
    }
  }
  const { title, body } = req.body ?? {};
  if (typeof title !== "string" || !title.trim()) {
    res.status(400).json({ error: "title is required" });
    return;
  }
  if (typeof body !== "string" || !body.trim()) {
    res.status(400).json({ error: "body is required" });
    return;
  }
  const cleanTitle = title.trim().slice(0, 80);
  const cleanBody = body.trim().slice(0, 500);
  // Append to the end of the same-owner list by default — pick max(sortOrder)+1.
  const ownerEqTpl =
    tplScope === "school"
      ? sql`${pbisNoteTemplatesTable.ownerScope} = 'school'`
      : sql`${pbisNoteTemplatesTable.ownerScope} = 'teacher' AND ${pbisNoteTemplatesTable.ownerStaffId} = ${staff.id}`;
  const [maxRow] = await db
    .select({ max: sql<number>`COALESCE(MAX(${pbisNoteTemplatesTable.sortOrder}), -1)` })
    .from(pbisNoteTemplatesTable)
    .where(and(eq(pbisNoteTemplatesTable.schoolId, schoolId), ownerEqTpl));
  const nextOrder = (maxRow?.max ?? -1) + 1;
  const [row] = await db
    .insert(pbisNoteTemplatesTable)
    .values({
      schoolId,
      title: cleanTitle,
      body: cleanBody,
      sortOrder: nextOrder,
      createdAt: new Date().toISOString(),
      createdById: staff.id,
      ownerScope: tplScope,
      ownerStaffId: tplScope === "teacher" ? staff.id : null,
    })
    .returning();
  res.status(201).json(row);
});

router.patch("/pbis-note-templates/:id", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const updates: { title?: string; body?: string; sortOrder?: number } = {};
  const { title, body, sortOrder } = req.body ?? {};
  if (title !== undefined) {
    if (typeof title !== "string" || !title.trim()) {
      res.status(400).json({ error: "title must be non-empty" });
      return;
    }
    updates.title = title.trim().slice(0, 80);
  }
  if (body !== undefined) {
    if (typeof body !== "string" || !body.trim()) {
      res.status(400).json({ error: "body must be non-empty" });
      return;
    }
    updates.body = body.trim().slice(0, 500);
  }
  if (sortOrder !== undefined) {
    const n = Number(sortOrder);
    if (!Number.isInteger(n)) {
      res.status(400).json({ error: "sortOrder must be an integer" });
      return;
    }
    updates.sortOrder = n;
  }
  if (!Object.keys(updates).length) {
    res.status(400).json({ error: "Nothing to update" });
    return;
  }
  // Per-row scope check: load existing row first.
  const [existingTpl] = await db
    .select()
    .from(pbisNoteTemplatesTable)
    .where(
      and(
        eq(pbisNoteTemplatesTable.id, id),
        eq(pbisNoteTemplatesTable.schoolId, schoolId),
      ),
    );
  if (!existingTpl) {
    res.status(404).json({ error: "Template not found" });
    return;
  }
  if (!canWriteRow(staff, existingTpl)) {
    res.status(403).json({ error: "Not allowed to edit this template" });
    return;
  }
  const [updated] = await db
    .update(pbisNoteTemplatesTable)
    .set(updates)
    .where(
      and(
        eq(pbisNoteTemplatesTable.id, id),
        eq(pbisNoteTemplatesTable.schoolId, schoolId),
      ),
    )
    .returning();
  res.json(updated);
});

router.delete("/pbis-note-templates/:id", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const [existingDel] = await db
    .select()
    .from(pbisNoteTemplatesTable)
    .where(
      and(
        eq(pbisNoteTemplatesTable.id, id),
        eq(pbisNoteTemplatesTable.schoolId, schoolId),
      ),
    );
  if (!existingDel) {
    res.status(404).json({ error: "Template not found" });
    return;
  }
  if (!canWriteRow(staff, existingDel)) {
    res.status(403).json({ error: "Not allowed to delete this template" });
    return;
  }
  await db
    .delete(pbisNoteTemplatesTable)
    .where(
      and(
        eq(pbisNoteTemplatesTable.id, id),
        eq(pbisNoteTemplatesTable.schoolId, schoolId),
      ),
    );
  res.json({ ok: true });
});

// ---- Intervention Types ----
// Per-school: every endpoint AND-filters by req.schoolId so school A cannot
// list, edit, or delete school B's intervention types — and uniqueness is
// per-school so each school can own its own "Verbal Redirect" entry.

router.get("/intervention-types", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const rows = await db
    .select()
    .from(interventionTypesTable)
    .where(eq(interventionTypesTable.schoolId, schoolId))
    .orderBy(interventionTypesTable.category, interventionTypesTable.name);
  res.json(rows);
});

router.post("/intervention-types", requireInterventionAdmin, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const { name, category, requiresNote } = req.body ?? {};
  if (typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const cat =
    typeof category === "string" && category.trim() ? category.trim() : "Classroom";
  const reqNote = typeof requiresNote === "boolean" ? requiresNote : false;
  const existing = await db
    .select()
    .from(interventionTypesTable)
    .where(
      and(
        eq(interventionTypesTable.schoolId, schoolId),
        sql`lower(${interventionTypesTable.name}) = lower(${name.trim()})`,
      ),
    );
  if (existing.length > 0) {
    res.status(409).json({ error: "Intervention name already exists" });
    return;
  }
  const [row] = await db
    .insert(interventionTypesTable)
    .values({
      schoolId,
      name: name.trim(),
      category: cat,
      requiresNote: reqNote,
      active: true,
    })
    .returning();
  res.status(201).json(row);
});

router.delete("/intervention-types/:id", requireInterventionAdmin, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [row] = await db
    .delete(interventionTypesTable)
    .where(
      and(
        eq(interventionTypesTable.id, id),
        eq(interventionTypesTable.schoolId, schoolId),
      ),
    )
    .returning();
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json({ ok: true, id: row.id });
});

router.patch("/intervention-types/:id", requireInterventionAdmin, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const { name, category, requiresNote, active } = req.body ?? {};
  const updates: Partial<typeof interventionTypesTable.$inferInsert> = {};
  if (typeof name === "string" && name.trim()) updates.name = name.trim();
  if (typeof category === "string" && category.trim())
    updates.category = category.trim();
  if (typeof requiresNote === "boolean") updates.requiresNote = requiresNote;
  if (typeof active === "boolean") updates.active = active;
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No updates" });
    return;
  }
  const [row] = await db
    .update(interventionTypesTable)
    .set(updates)
    .where(
      and(
        eq(interventionTypesTable.id, id),
        eq(interventionTypesTable.schoolId, schoolId),
      ),
    )
    .returning();
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(row);
});

// ---- Trusted Adult Interventions ----
// Per-school, same isolation rules as Intervention Types.

router.get("/trusted-adult-interventions", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const rows = await db
    .select()
    .from(trustedAdultInterventionsTable)
    .where(eq(trustedAdultInterventionsTable.schoolId, schoolId))
    .orderBy(trustedAdultInterventionsTable.category, trustedAdultInterventionsTable.name);
  res.json(rows);
});

router.post("/trusted-adult-interventions", requireInterventionAdmin, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const { name, category } = req.body ?? {};
  if (typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const cat =
    typeof category === "string" && category.trim()
      ? category.trim()
      : "Trusted Adult";
  const existing = await db
    .select()
    .from(trustedAdultInterventionsTable)
    .where(
      and(
        eq(trustedAdultInterventionsTable.schoolId, schoolId),
        sql`lower(${trustedAdultInterventionsTable.name}) = lower(${name.trim()})`,
      ),
    );
  if (existing.length > 0) {
    res.status(409).json({ error: "Intervention name already exists" });
    return;
  }
  const [row] = await db
    .insert(trustedAdultInterventionsTable)
    .values({ schoolId, name: name.trim(), category: cat, active: true })
    .returning();
  res.status(201).json(row);
});

router.patch("/trusted-adult-interventions/:id", requireInterventionAdmin, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const { name, category, active } = req.body ?? {};
  const updates: Partial<typeof trustedAdultInterventionsTable.$inferInsert> = {};
  if (typeof name === "string" && name.trim()) updates.name = name.trim();
  if (typeof category === "string" && category.trim())
    updates.category = category.trim();
  if (typeof active === "boolean") updates.active = active;
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No updates" });
    return;
  }
  const [row] = await db
    .update(trustedAdultInterventionsTable)
    .set(updates)
    .where(
      and(
        eq(trustedAdultInterventionsTable.id, id),
        eq(trustedAdultInterventionsTable.schoolId, schoolId),
      ),
    )
    .returning();
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(row);
});

router.delete("/trusted-adult-interventions/:id", requireInterventionAdmin, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [row] = await db
    .delete(trustedAdultInterventionsTable)
    .where(
      and(
        eq(trustedAdultInterventionsTable.id, id),
        eq(trustedAdultInterventionsTable.schoolId, schoolId),
      ),
    )
    .returning();
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json({ ok: true, id: row.id });
});

export default router;
