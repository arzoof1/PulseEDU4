// Discipline reasons used by the Add ISS / OSS Log modals.
//
// Two scopes:
//   - District master list (`/district-discipline-reasons`): managed
//     by a district admin, read-only at the school level. Visible at
//     every school in the district.
//   - School list (`/discipline-reasons`): managed by the school admin.
//
// The school-facing GET merges both lists so the modal dropdown shows
// district + school reasons together with a `scope` field for labelling.
import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  db,
  disciplineReasonsTable,
  schoolsTable,
  staffTable,
} from "@workspace/db";
import { and, asc, eq, isNotNull, or } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";

const router: IRouter = Router();
type StaffRow = typeof staffTable.$inferSelect;

async function loadStaff(req: Request): Promise<StaffRow | null> {
  const id = req.staffId;
  if (!id) return null;
  const [s] = await db.select().from(staffTable).where(eq(staffTable.id, id));
  return s && s.active ? s : null;
}

const canRead = (s: StaffRow) =>
  s.isSuperUser ||
  s.isDistrictAdmin ||
  s.isAdmin ||
  s.isDean ||
  s.isBehaviorSpecialist ||
  s.isMtssCoordinator;

const canWriteSchool = (s: StaffRow) =>
  s.isSuperUser || s.isDistrictAdmin || s.isAdmin;

const canWriteDistrict = (s: StaffRow) => s.isSuperUser || s.isDistrictAdmin;

function gate(check: (s: StaffRow) => boolean, label: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const staff = await loadStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    if (!check(staff)) {
      res.status(403).json({ error: `${label} only` });
      return;
    }
    (req as Request & { staff: StaffRow }).staff = staff;
    next();
  };
}

// Look up the school's parent district. Returns null when the school
// is district-less (rare but possible during onboarding).
async function districtIdForSchool(schoolId: number): Promise<number | null> {
  const [s] = await db
    .select({ districtId: schoolsTable.districtId })
    .from(schoolsTable)
    .where(eq(schoolsTable.id, schoolId));
  return s?.districtId ?? null;
}

// Resolve the staff's district context for district-level operations.
// Non-superuser district admins are pinned to their own district via
// req.schoolId → school → district. Superusers can override with a
// `districtId` query/body param.
async function resolveDistrictId(
  req: Request,
  staff: StaffRow,
): Promise<number | null> {
  const override = req.query.districtId ?? (req.body as Record<string, unknown> | undefined)?.districtId;
  if (staff.isSuperUser && override !== undefined && override !== null && override !== "") {
    const n = typeof override === "number" ? override : Number(override);
    if (Number.isInteger(n) && n > 0) return n;
  }
  const schoolId = req.schoolId;
  if (!schoolId) return null;
  return districtIdForSchool(schoolId);
}

// ---------- School-facing: merged read --------------------------------
// Returns district master entries + this school's own entries, each
// tagged with `scope: 'district' | 'school'`. Inactive rows still
// come back so historical references render correctly; the modal
// filters to active in the dropdown.
router.get("/discipline-reasons", gate(canRead, "Admin Hub"), async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const districtId = await districtIdForSchool(schoolId);

  const ownSchool = await db
    .select()
    .from(disciplineReasonsTable)
    .where(eq(disciplineReasonsTable.schoolId, schoolId))
    .orderBy(asc(disciplineReasonsTable.sortOrder), asc(disciplineReasonsTable.label));

  const district = districtId
    ? await db
        .select()
        .from(disciplineReasonsTable)
        .where(eq(disciplineReasonsTable.districtId, districtId))
        .orderBy(asc(disciplineReasonsTable.sortOrder), asc(disciplineReasonsTable.label))
    : [];

  // District rows first so they appear above school-specific overrides
  // in the modal dropdown.
  const merged = [
    ...district.map((r) => ({ ...r, scope: "district" as const })),
    ...ownSchool.map((r) => ({ ...r, scope: "school" as const })),
  ];
  res.json(merged);
});

// ---------- School-scoped CRUD ----------------------------------------
router.post("/discipline-reasons", gate(canWriteSchool, "Admin"), async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!label || label.length > 200) {
    res.status(400).json({ error: "label is required (1-200 chars)" });
    return;
  }
  const sortOrder = Number.isInteger(body.sortOrder) ? Number(body.sortOrder) : 0;
  try {
    const [row] = await db
      .insert(disciplineReasonsTable)
      .values({ schoolId, label, sortOrder })
      .returning();
    res.status(201).json({ ...row, scope: "school" });
  } catch (e: unknown) {
    if (e instanceof Error && /duplicate/i.test(e.message)) {
      res.status(409).json({ error: "Reason already exists" });
      return;
    }
    throw e;
  }
});

router.patch(
  "/discipline-reasons/:id",
  gate(canWriteSchool, "Admin"),
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const updates: Partial<typeof disciplineReasonsTable.$inferInsert> = {};
    if (typeof body.label === "string" && body.label.trim()) {
      updates.label = body.label.trim().slice(0, 200);
    }
    if (typeof body.active === "boolean") updates.active = body.active;
    if (Number.isInteger(body.sortOrder)) {
      updates.sortOrder = Number(body.sortOrder);
    }
    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }
    const [row] = await db
      .update(disciplineReasonsTable)
      .set(updates)
      .where(
        and(
          eq(disciplineReasonsTable.id, id),
          eq(disciplineReasonsTable.schoolId, schoolId),
        ),
      )
      .returning();
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({ ...row, scope: "school" });
  },
);

router.delete(
  "/discipline-reasons/:id",
  gate(canWriteSchool, "Admin"),
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    // Soft-delete by clearing `active` so historical logs that reference
    // this reason still display the label correctly.
    const [row] = await db
      .update(disciplineReasonsTable)
      .set({ active: false })
      .where(
        and(
          eq(disciplineReasonsTable.id, id),
          eq(disciplineReasonsTable.schoolId, schoolId),
        ),
      )
      .returning();
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({ ok: true });
  },
);

// ---------- District-scoped CRUD (district master list) ---------------
// District admins manage the district's master list; superusers can
// pass `?districtId=N` to act on any district.
router.get(
  "/district-discipline-reasons",
  gate(canWriteDistrict, "District admin"),
  async (req, res) => {
    const staff = (req as Request & { staff: StaffRow }).staff;
    const districtId = await resolveDistrictId(req, staff);
    if (!districtId) {
      res.status(400).json({ error: "Could not resolve district" });
      return;
    }
    const rows = await db
      .select()
      .from(disciplineReasonsTable)
      .where(eq(disciplineReasonsTable.districtId, districtId))
      .orderBy(
        asc(disciplineReasonsTable.sortOrder),
        asc(disciplineReasonsTable.label),
      );
    res.json(rows.map((r) => ({ ...r, scope: "district" })));
  },
);

router.post(
  "/district-discipline-reasons",
  gate(canWriteDistrict, "District admin"),
  async (req, res) => {
    const staff = (req as Request & { staff: StaffRow }).staff;
    const districtId = await resolveDistrictId(req, staff);
    if (!districtId) {
      res.status(400).json({ error: "Could not resolve district" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const label = typeof body.label === "string" ? body.label.trim() : "";
    if (!label || label.length > 200) {
      res.status(400).json({ error: "label is required (1-200 chars)" });
      return;
    }
    const sortOrder = Number.isInteger(body.sortOrder) ? Number(body.sortOrder) : 0;
    try {
      const [row] = await db
        .insert(disciplineReasonsTable)
        .values({ districtId, label, sortOrder })
        .returning();
      res.status(201).json({ ...row, scope: "district" });
    } catch (e: unknown) {
      if (e instanceof Error && /duplicate/i.test(e.message)) {
        res.status(409).json({ error: "Reason already exists in this district" });
        return;
      }
      throw e;
    }
  },
);

router.patch(
  "/district-discipline-reasons/:id",
  gate(canWriteDistrict, "District admin"),
  async (req, res) => {
    const staff = (req as Request & { staff: StaffRow }).staff;
    const districtId = await resolveDistrictId(req, staff);
    if (!districtId) {
      res.status(400).json({ error: "Could not resolve district" });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const updates: Partial<typeof disciplineReasonsTable.$inferInsert> = {};
    if (typeof body.label === "string" && body.label.trim()) {
      updates.label = body.label.trim().slice(0, 200);
    }
    if (typeof body.active === "boolean") updates.active = body.active;
    if (Number.isInteger(body.sortOrder)) {
      updates.sortOrder = Number(body.sortOrder);
    }
    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }
    const [row] = await db
      .update(disciplineReasonsTable)
      .set(updates)
      .where(
        and(
          eq(disciplineReasonsTable.id, id),
          eq(disciplineReasonsTable.districtId, districtId),
        ),
      )
      .returning();
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({ ...row, scope: "district" });
  },
);

router.delete(
  "/district-discipline-reasons/:id",
  gate(canWriteDistrict, "District admin"),
  async (req, res) => {
    const staff = (req as Request & { staff: StaffRow }).staff;
    const districtId = await resolveDistrictId(req, staff);
    if (!districtId) {
      res.status(400).json({ error: "Could not resolve district" });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [row] = await db
      .update(disciplineReasonsTable)
      .set({ active: false })
      .where(
        and(
          eq(disciplineReasonsTable.id, id),
          eq(disciplineReasonsTable.districtId, districtId),
        ),
      )
      .returning();
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({ ok: true });
  },
);

// Suppress unused-import warnings — kept available for future shared
// helpers that may need them.
void isNotNull;
void or;

export default router;
