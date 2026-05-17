import { Router, type IRouter } from "express";
import {
  db,
  staffTable,
  districtsTable,
  schoolsTable,
  schoolSettingsTable,
  plansTable,
} from "@workspace/db";
import { eq, asc, and } from "drizzle-orm";
import { sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { randomInt } from "node:crypto";
import { getDistrictIdForSchool } from "../lib/scope";
import { applyPlanToSchool } from "../lib/featureLicensing";

const router: IRouter = Router();

// Loads the caller's staff row. Returns null on failure (after writing
// the appropriate error response to res).
async function loadStaff(req: any, res: any) {
  const id = req.staffId ?? null;
  if (!id) {
    res.status(401).json({ error: "Sign-in required" });
    return null;
  }
  const [staff] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, id));
  if (!staff || !staff.active) {
    res.status(401).json({ error: "Sign-in required" });
    return null;
  }
  return staff;
}

async function requireSuperUser(req: any, res: any) {
  const staff = await loadStaff(req, res);
  if (!staff) return null;
  if (!staff.isSuperUser) {
    res.status(403).json({ error: "SuperUser access required" });
    return null;
  }
  return staff;
}

// ---------------------------------------------------------------------------
// GET /api/tenancy/schools
//   Lists schools the caller can pick from. SuperUsers see every active
//   school **in their own district** (the role is district-wide, not
//   cross-district). Regular staff see exactly their home school. Used to
//   populate the top-bar switcher (SuperUser) and the read-only badge
//   (everyone else).
// ---------------------------------------------------------------------------
router.get("/tenancy/schools", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;

  const actorDistrictId = await getDistrictIdForSchool(staff.schoolId);

  const all = await db
    .select()
    .from(schoolsTable)
    .where(
      and(
        eq(schoolsTable.active, true),
        // For SuperUsers, restrict to their own district. For everyone else
        // we still pull the row so the badge can render their home school's
        // name; the .filter below narrows to exactly that one row.
        actorDistrictId !== null
          ? eq(schoolsTable.districtId, actorDistrictId)
          : sql`false`,
      ),
    )
    .orderBy(asc(schoolsTable.districtId), asc(schoolsTable.id));

  const visible = staff.isSuperUser
    ? all
    : all.filter((s) => s.id === staff.schoolId);

  res.json({
    homeSchoolId: staff.schoolId,
    activeSchoolId: req.schoolId ?? staff.schoolId,
    isSwitched: !!req.isSchoolSwitched,
    canSwitch: !!staff.isSuperUser,
    schools: visible.map((s) => ({
      id: s.id,
      districtId: s.districtId,
      name: s.name,
      shortName: s.shortName,
      stateSchoolCode: s.stateSchoolCode,
      isPrimary: s.isPrimary,
    })),
  });
});

// ---------------------------------------------------------------------------
// POST /api/tenancy/switch-school { schoolId }
//   SuperUser-only. Persists session.activeSchoolId so subsequent requests
//   resolve req.schoolId to the chosen school. Pass schoolId=null (or the
//   caller's home school id) to clear the override.
// ---------------------------------------------------------------------------
router.post("/tenancy/switch-school", async (req, res) => {
  const staff = await requireSuperUser(req, res);
  if (!staff) return;

  const raw = (req.body ?? {}) as { schoolId?: unknown };
  const wantsClear = raw.schoolId === null || raw.schoolId === undefined;

  // We persist the override on the staff row instead of req.session because
  // bearer-token requests (the Replit preview iframe blocks session cookies)
  // create a fresh session each request, so session.activeSchoolId never
  // survives a reload.
  if (wantsClear) {
    await db
      .update(staffTable)
      .set({ activeSchoolOverride: null })
      .where(eq(staffTable.id, staff.id));
    res.json({
      ok: true,
      activeSchoolId: staff.schoolId,
      isSwitched: false,
    });
    return;
  }

  const schoolId = Number(raw.schoolId);
  if (!Number.isInteger(schoolId) || schoolId <= 0) {
    res.status(400).json({ error: "schoolId must be a positive integer" });
    return;
  }

  const [school] = await db
    .select()
    .from(schoolsTable)
    .where(and(eq(schoolsTable.id, schoolId), eq(schoolsTable.active, true)));
  if (!school) {
    res.status(404).json({ error: "School not found or inactive" });
    return;
  }

  // Cross-district switching is rejected. A Hernando SuperUser switching
  // into a Pasco school would resolve req.schoolId to a Pasco school for
  // the rest of the session — the scope sweeps from D3-D5 only enforced
  // *school* scoping, so cross-district reach via the switcher would
  // expose Pasco data to Hernando. If we ever want a true cross-district
  // SuperUser, that's a separate flag (e.g. `isCrossDistrictSuperUser`).
  const actorDistrictId = await getDistrictIdForSchool(staff.schoolId);
  if (actorDistrictId === null || school.districtId !== actorDistrictId) {
    res
      .status(403)
      .json({ error: "Cannot switch into a school in another district" });
    return;
  }

  // schoolId === staff.schoolId means the SuperUser picked their own home
  // school explicitly. Treat that as "clear the override" so the badge
  // returns to its non-switched state.
  const overrideValue = schoolId === staff.schoolId ? null : schoolId;
  await db
    .update(staffTable)
    .set({ activeSchoolOverride: overrideValue })
    .where(eq(staffTable.id, staff.id));

  res.json({
    ok: true,
    activeSchoolId: schoolId,
    isSwitched: schoolId !== staff.schoolId,
    schoolName: school.name,
  });
});

// ---------------------------------------------------------------------------
// POST /api/tenancy/schools
//   SuperUser-only. Creates a new school inside a district. Used by the
//   Tenancy panel "Create new school" action so SuperUsers can prove silo
//   isolation by switching into a brand-new (empty) school.
// ---------------------------------------------------------------------------
router.post("/tenancy/schools", async (req, res) => {
  const staff = await requireSuperUser(req, res);
  if (!staff) return;

  const body = (req.body ?? {}) as {
    districtId?: unknown;
    name?: unknown;
    shortName?: unknown;
    stateSchoolCode?: unknown;
  };

  const districtId = Number(body.districtId);
  if (!Number.isInteger(districtId) || districtId <= 0) {
    res.status(400).json({ error: "districtId must be a positive integer" });
    return;
  }

  // SuperUser must be creating a school IN THEIR OWN DISTRICT. Without this
  // a Hernando SuperUser could POST { districtId: 37, name: "..." } and
  // mint a school inside the Pasco silo. Cross-district write was the
  // matching write-side hole alongside the switch-school read-side one.
  const actorDistrictId = await getDistrictIdForSchool(staff.schoolId);
  if (actorDistrictId === null || actorDistrictId !== districtId) {
    res
      .status(403)
      .json({ error: "Cannot create a school in another district" });
    return;
  }

  const [district] = await db
    .select()
    .from(districtsTable)
    .where(eq(districtsTable.id, districtId));
  if (!district) {
    res.status(404).json({ error: "District not found" });
    return;
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const shortName =
    typeof body.shortName === "string" && body.shortName.trim()
      ? body.shortName.trim()
      : null;
  const stateSchoolCode =
    typeof body.stateSchoolCode === "string" && body.stateSchoolCode.trim()
      ? body.stateSchoolCode.trim()
      : null;

  // Reject duplicate name OR state code within the same district. The DB
  // doesn't have a composite unique yet (D4) so we enforce it here.
  const existing = await db
    .select()
    .from(schoolsTable)
    .where(eq(schoolsTable.districtId, districtId));
  if (existing.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
    res
      .status(409)
      .json({ error: `A school named "${name}" already exists in this district` });
    return;
  }
  if (
    stateSchoolCode &&
    existing.some((s) => s.stateSchoolCode === stateSchoolCode)
  ) {
    res
      .status(409)
      .json({ error: `State code ${stateSchoolCode} is already used in this district` });
    return;
  }

  const [created] = await db
    .insert(schoolsTable)
    .values({
      districtId,
      name,
      shortName,
      stateSchoolCode,
      isPrimary: false,
      active: true,
    })
    .returning();

  res.status(201).json({
    school: {
      id: created.id,
      districtId: created.districtId,
      name: created.name,
      shortName: created.shortName,
      stateSchoolCode: created.stateSchoolCode,
      isPrimary: created.isPrimary,
      active: created.active,
    },
  });
});

// Tables we report row counts for. All have a school_id column as of Day 2.
// Day 4 added the per-school settings/config tables so SuperUsers can verify
// silo isolation at a glance (e.g. "1 settings row per school visited").
const COUNT_TABLES = [
  "students",
  "staff",
  "hall_passes",
  "tardies",
  "pbis_entries",
  "pullouts",
  "accommodation_logs",
  "support_notes",
  "intervention_entries",
  "iss_roster",
  "school_settings",
  "bell_schedules",
  "pbis_reasons",
  "pbis_milestones",
] as const;

router.get("/tenancy/status", async (req, res) => {
  const staff = await requireSuperUser(req, res);
  if (!staff) return;

  // District-scope every read in this endpoint. Pre-D6 the Tenancy panel
  // was the canonical "see all districts and all schools" view, which is
  // exactly the cross-district leak we're closing now. A Hernando
  // SuperUser must not see Pasco's name, school list, or per-school row
  // counts — that's tenant-metadata exposure even though the row data
  // itself isn't dumped here.
  const actorDistrictId = await getDistrictIdForSchool(staff.schoolId);

  const districts =
    actorDistrictId === null
      ? []
      : await db
          .select()
          .from(districtsTable)
          .where(eq(districtsTable.id, actorDistrictId))
          .orderBy(asc(districtsTable.id));

  const schools =
    actorDistrictId === null
      ? []
      : await db
          .select()
          .from(schoolsTable)
          .where(eq(schoolsTable.districtId, actorDistrictId))
          .orderBy(asc(schoolsTable.districtId), asc(schoolsTable.id));

  // Build the IN-list of school ids to scope per-table count queries.
  // Orphan rows (school_id IS NULL) stay in scope: they're a system-
  // integrity signal that any district admin should see flagged.
  const districtSchoolIds = schools.map((s) => s.id);
  const inList =
    districtSchoolIds.length > 0 ? districtSchoolIds.join(",") : "NULL";

  const counts: Record<string, number> = {};
  const perSchool: Record<string, Record<number, number>> = {};
  const orphans: Record<string, number> = {};
  for (const t of COUNT_TABLES) {
    perSchool[t] = {};
    const result = await db.execute(
      sql.raw(
        `SELECT school_id, COUNT(*)::int AS n FROM ${t}
         WHERE school_id IN (${inList}) OR school_id IS NULL
         GROUP BY school_id`,
      ),
    );
    const rows = (result as any).rows ?? (result as any);
    let total = 0;
    let orphanCount = 0;
    for (const row of rows) {
      const n = Number(row.n ?? 0);
      const sid = row.school_id;
      total += n;
      if (sid === null || sid === undefined) {
        orphanCount += n;
      } else {
        perSchool[t][Number(sid)] = n;
      }
    }
    counts[t] = total;
    orphans[t] = orphanCount;
  }

  const totalOrphans = Object.values(orphans).reduce((a, b) => a + b, 0);

  res.json({
    districts: districts.map((d) => ({
      id: d.id,
      name: d.name,
      slug: d.slug,
      stateDistrictCode: d.stateDistrictCode,
      timezone: d.timezone,
      active: d.active,
    })),
    schools: schools.map((s) => ({
      id: s.id,
      districtId: s.districtId,
      name: s.name,
      shortName: s.shortName,
      stateSchoolCode: s.stateSchoolCode,
      isPrimary: s.isPrimary,
      active: s.active,
    })),
    counts,
    perSchool,
    orphans,
    totalOrphans,
    perSchoolBreakdownAvailable: true,
  });
});

// ---------------------------------------------------------------------------
// POST /api/tenancy/onboard-district
//   SuperUser-only. End-to-end "stand up a new district" wizard target:
//   creates the district row, its first (primary) school, the school's
//   default settings row, applies the default `enterprise` plan to it,
//   and creates the first school-admin staff member. All inside a single
//   transaction so a partial failure leaves no orphan rows.
//
//   Returns the IDs of all three created rows plus a one-time temporary
//   password for the admin so the SuperUser can hand it off in band. The
//   admin can change it on first login (existing flow).
// ---------------------------------------------------------------------------
router.post("/tenancy/onboard-district", async (req, res) => {
  const staff = await requireSuperUser(req, res);
  if (!staff) return;

  const body = (req.body ?? {}) as {
    districtName?: unknown;
    districtSlug?: unknown;
    stateDistrictCode?: unknown;
    timezone?: unknown;
    schoolName?: unknown;
    schoolShortName?: unknown;
    stateSchoolCode?: unknown;
    adminEmail?: unknown;
    adminFirstName?: unknown;
    adminLastName?: unknown;
  };

  // ---- Validate (all strings, trimmed, required vs. optional). ------------
  const districtName =
    typeof body.districtName === "string" ? body.districtName.trim() : "";
  const districtSlug =
    typeof body.districtSlug === "string" ? body.districtSlug.trim() : "";
  const schoolName =
    typeof body.schoolName === "string" ? body.schoolName.trim() : "";
  const adminEmail =
    typeof body.adminEmail === "string" ? body.adminEmail.trim().toLowerCase() : "";
  const adminFirstName =
    typeof body.adminFirstName === "string" ? body.adminFirstName.trim() : "";
  const adminLastName =
    typeof body.adminLastName === "string" ? body.adminLastName.trim() : "";

  const missing: string[] = [];
  if (!districtName) missing.push("districtName");
  if (!districtSlug) missing.push("districtSlug");
  if (!schoolName) missing.push("schoolName");
  if (!adminEmail) missing.push("adminEmail");
  if (!adminFirstName) missing.push("adminFirstName");
  if (!adminLastName) missing.push("adminLastName");
  if (missing.length > 0) {
    res
      .status(400)
      .json({ error: `Missing required fields: ${missing.join(", ")}` });
    return;
  }

  // Slug shape: lowercase letters + digits + hyphens only. Matches the
  // existing seed convention and keeps URLs predictable.
  if (!/^[a-z0-9-]+$/.test(districtSlug)) {
    res.status(400).json({
      error:
        "districtSlug must contain only lowercase letters, digits, and hyphens",
    });
    return;
  }
  if (!/^\S+@\S+\.\S+$/.test(adminEmail)) {
    res.status(400).json({ error: "adminEmail is not a valid email" });
    return;
  }

  const stateDistrictCode =
    typeof body.stateDistrictCode === "string" && body.stateDistrictCode.trim()
      ? body.stateDistrictCode.trim()
      : null;
  const timezone =
    typeof body.timezone === "string" && body.timezone.trim()
      ? body.timezone.trim()
      : "America/New_York";
  const schoolShortName =
    typeof body.schoolShortName === "string" && body.schoolShortName.trim()
      ? body.schoolShortName.trim()
      : null;
  const stateSchoolCode =
    typeof body.stateSchoolCode === "string" && body.stateSchoolCode.trim()
      ? body.stateSchoolCode.trim()
      : null;

  // ---- Pre-flight uniqueness checks (outside tx for friendlier errors). ---
  const [slugClash] = await db
    .select()
    .from(districtsTable)
    .where(eq(districtsTable.slug, districtSlug));
  if (slugClash) {
    res.status(409).json({
      error: `District slug "${districtSlug}" is already taken`,
    });
    return;
  }
  const [emailClash] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.email, adminEmail));
  if (emailClash) {
    res.status(409).json({
      error: `A staff member with email ${adminEmail} already exists`,
    });
    return;
  }

  // ---- Generate temp password BEFORE the tx (bcrypt is slow). -------------
  // 16 url-safe chars from a constrained alphabet so it's both unguessable
  // and easy to copy out of the success modal. Uses node:crypto's CSPRNG —
  // Math.random is biased AND predictable; never acceptable for credential
  // material.
  const ALPHABET =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let tempPassword = "";
  for (let i = 0; i < 16; i++) {
    tempPassword += ALPHABET[randomInt(0, ALPHABET.length)];
  }
  const passwordHash = await bcrypt.hash(tempPassword, 10);

  // ---- Look up the default plan to assign to the new school. --------------
  const [enterprisePlan] = await db
    .select()
    .from(plansTable)
    .where(eq(plansTable.key, "enterprise"));

  // ---- Transactional create: district → school → settings → admin. -------
  try {
    const result = await db.transaction(async (tx) => {
      const [district] = await tx
        .insert(districtsTable)
        .values({
          name: districtName,
          slug: districtSlug,
          stateDistrictCode,
          timezone,
        })
        .returning();

      const [school] = await tx
        .insert(schoolsTable)
        .values({
          districtId: district.id,
          name: schoolName,
          shortName: schoolShortName,
          stateSchoolCode,
          isPrimary: true,
          active: true,
        })
        .returning();

      // Settings row uses every column's DB default — same shape every
      // school in the system starts with.
      await tx
        .insert(schoolSettingsTable)
        .values({ schoolId: school.id });

      // Assign the enterprise plan (if seeded) so all superFeature_* flags
      // are explicitly true. Wrapped in the same tx for atomicity.
      if (enterprisePlan) {
        await applyPlanToSchool(school.id, enterprisePlan.id, tx);
      }

      const [admin] = await tx
        .insert(staffTable)
        .values({
          schoolId: school.id,
          email: adminEmail,
          passwordHash,
          displayName: `${adminFirstName} ${adminLastName}`,
          isAdmin: true,
          active: true,
        })
        .returning();

      return { district, school, admin };
    });

    res.status(201).json({
      district: {
        id: result.district.id,
        name: result.district.name,
        slug: result.district.slug,
      },
      school: {
        id: result.school.id,
        name: result.school.name,
        shortName: result.school.shortName,
      },
      admin: {
        id: result.admin.id,
        email: result.admin.email,
        displayName: result.admin.displayName,
      },
      // One-time. Not stored anywhere on the server beyond the bcrypt
      // hash. The SuperUser must capture it from the response.
      tempPassword,
    });
  } catch (err: any) {
    // Map race-condition unique-violations back to a deterministic 409
    // so the operator sees the same friendly message the pre-flight
    // check produces. Postgres error code 23505 = unique_violation.
    const pgCode = err?.cause?.code ?? err?.code;
    if (pgCode === "23505") {
      const detail: string = err?.cause?.detail ?? err?.detail ?? "";
      const isSlug = /districts.*slug/i.test(detail);
      const isEmail = /staff.*email/i.test(detail);
      res.status(409).json({
        error: isSlug
          ? `District slug "${districtSlug}" is already taken`
          : isEmail
            ? `A staff member with email ${adminEmail} already exists`
            : "A row with this identifier already exists",
      });
      return;
    }
    req.log?.error?.({ err }, "onboard-district failed");
    res
      .status(500)
      .json({ error: "Failed to onboard district — see server logs" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/tenancy/onboard-school
//   SuperUser-only. Adds a school under an EXISTING district. Mirrors
//   onboard-district but skips the district insert + inherits the district's
//   current default plan (looked up from `plansTable.key = 'enterprise'`,
//   same default the district wizard uses today — when per-district plan
//   selection lands, swap this for the district's actual plan).
//
//   Transactional: school → schoolSettings → applyPlan → first admin.
//   Returns the new IDs plus a one-time CSPRNG temp password.
// ---------------------------------------------------------------------------
router.post("/tenancy/onboard-school", async (req, res) => {
  const staff = await requireSuperUser(req, res);
  if (!staff) return;

  const body = (req.body ?? {}) as {
    districtId?: unknown;
    schoolName?: unknown;
    schoolShortName?: unknown;
    stateSchoolCode?: unknown;
    adminEmail?: unknown;
    adminFirstName?: unknown;
    adminLastName?: unknown;
  };

  const districtId =
    typeof body.districtId === "number" &&
    Number.isInteger(body.districtId) &&
    body.districtId > 0
      ? body.districtId
      : null;
  const schoolName =
    typeof body.schoolName === "string" ? body.schoolName.trim() : "";
  const adminEmail =
    typeof body.adminEmail === "string"
      ? body.adminEmail.trim().toLowerCase()
      : "";
  const adminFirstName =
    typeof body.adminFirstName === "string" ? body.adminFirstName.trim() : "";
  const adminLastName =
    typeof body.adminLastName === "string" ? body.adminLastName.trim() : "";

  const missing: string[] = [];
  if (districtId === null) missing.push("districtId");
  if (!schoolName) missing.push("schoolName");
  if (!adminEmail) missing.push("adminEmail");
  if (!adminFirstName) missing.push("adminFirstName");
  if (!adminLastName) missing.push("adminLastName");
  if (missing.length > 0) {
    res
      .status(400)
      .json({ error: `Missing required fields: ${missing.join(", ")}` });
    return;
  }
  if (!/^\S+@\S+\.\S+$/.test(adminEmail)) {
    res.status(400).json({ error: "adminEmail is not a valid email" });
    return;
  }

  const schoolShortName =
    typeof body.schoolShortName === "string" && body.schoolShortName.trim()
      ? body.schoolShortName.trim()
      : null;
  const stateSchoolCode =
    typeof body.stateSchoolCode === "string" && body.stateSchoolCode.trim()
      ? body.stateSchoolCode.trim()
      : null;

  // Pre-flight: district must exist; admin email must be globally unique.
  const [district] = await db
    .select()
    .from(districtsTable)
    .where(eq(districtsTable.id, districtId!));
  if (!district) {
    res.status(404).json({ error: `District ${districtId} not found` });
    return;
  }

  // Cross-tenant guard — SuperUser is district-wide by default, NOT
  // cross-district. Without this, a SuperUser in District A could
  // create schools + admins inside District B by supplying its id.
  // Matches the same env gate used by /superuser/overview + audit-health.
  const crossDistrict = process.env.ALLOW_CROSS_DISTRICT_SUPERUSER === "1";
  if (!crossDistrict) {
    const callerDistrictId = await getDistrictIdForSchool(staff.schoolId);
    if (callerDistrictId === null || callerDistrictId !== district.id) {
      res.status(403).json({
        error: "Cannot onboard a school into another district",
      });
      return;
    }
  }
  const [emailClash] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.email, adminEmail));
  if (emailClash) {
    res
      .status(409)
      .json({ error: `A staff member with email ${adminEmail} already exists` });
    return;
  }

  // Temp password (CSPRNG, same alphabet as onboard-district).
  const ALPHABET =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let tempPassword = "";
  for (let i = 0; i < 16; i++) {
    tempPassword += ALPHABET[randomInt(0, ALPHABET.length)];
  }
  const passwordHash = await bcrypt.hash(tempPassword, 10);

  const [enterprisePlan] = await db
    .select()
    .from(plansTable)
    .where(eq(plansTable.key, "enterprise"));

  try {
    const result = await db.transaction(async (tx) => {
      const [school] = await tx
        .insert(schoolsTable)
        .values({
          districtId: district.id,
          name: schoolName,
          shortName: schoolShortName,
          stateSchoolCode,
          // Not the primary school of the district — that's the one
          // created at district onboarding. Additional schools default
          // to non-primary; active.
          isPrimary: false,
          active: true,
        })
        .returning();

      await tx.insert(schoolSettingsTable).values({ schoolId: school.id });

      if (enterprisePlan) {
        await applyPlanToSchool(school.id, enterprisePlan.id, tx);
      }

      const [admin] = await tx
        .insert(staffTable)
        .values({
          schoolId: school.id,
          email: adminEmail,
          passwordHash,
          displayName: `${adminFirstName} ${adminLastName}`,
          isAdmin: true,
          active: true,
        })
        .returning();

      return { school, admin };
    });

    res.status(201).json({
      district: {
        id: district.id,
        name: district.name,
        slug: district.slug,
      },
      school: {
        id: result.school.id,
        name: result.school.name,
        shortName: result.school.shortName,
      },
      admin: {
        id: result.admin.id,
        email: result.admin.email,
        displayName: result.admin.displayName,
      },
      tempPassword,
    });
  } catch (err: any) {
    const pgCode = err?.cause?.code ?? err?.code;
    if (pgCode === "23505") {
      const detail: string = err?.cause?.detail ?? err?.detail ?? "";
      const isEmail = /staff.*email/i.test(detail);
      res.status(409).json({
        error: isEmail
          ? `A staff member with email ${adminEmail} already exists`
          : "A row with this identifier already exists",
      });
      return;
    }
    req.log?.error?.({ err }, "onboard-school failed");
    res
      .status(500)
      .json({ error: "Failed to onboard school — see server logs" });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/tenancy/schools/:id
//   SuperUser-only. Edits a school's editable metadata + soft-delete via
//   `active`. Hard-delete is intentionally not offered — too many FK
//   dependents (students, staff, audit rows). Deactivating a school
//   hides it from rollups + lookups; reactivating restores it.
//
//   Guardrails:
//     * Cross-district: same env gate as onboard-school.
//     * Cannot deactivate the district's primary school — that's the
//       row created at district onboarding; if you need to retire it,
//       deactivate the district instead.
// ---------------------------------------------------------------------------
router.patch("/tenancy/schools/:id", async (req, res) => {
  const staff = await requireSuperUser(req, res);
  if (!staff) return;

  const schoolId = Number(req.params.id);
  if (!Number.isInteger(schoolId) || schoolId <= 0) {
    res.status(400).json({ error: "school id must be a positive integer" });
    return;
  }

  const body = (req.body ?? {}) as {
    name?: unknown;
    shortName?: unknown;
    stateSchoolCode?: unknown;
    active?: unknown;
  };

  // Build a partial-update object — only patch keys the caller sent. All
  // strings are trimmed; explicit `null` (or empty string) on the optional
  // fields clears them.
  const patch: {
    name?: string;
    shortName?: string | null;
    stateSchoolCode?: string | null;
    active?: boolean;
  } = {};

  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim()) {
      res.status(400).json({ error: "name must be a non-empty string" });
      return;
    }
    patch.name = body.name.trim();
  }
  if (body.shortName !== undefined) {
    if (body.shortName === null || body.shortName === "") {
      patch.shortName = null;
    } else if (typeof body.shortName === "string") {
      patch.shortName = body.shortName.trim() || null;
    } else {
      res.status(400).json({ error: "shortName must be a string or null" });
      return;
    }
  }
  if (body.stateSchoolCode !== undefined) {
    if (body.stateSchoolCode === null || body.stateSchoolCode === "") {
      patch.stateSchoolCode = null;
    } else if (typeof body.stateSchoolCode === "string") {
      patch.stateSchoolCode = body.stateSchoolCode.trim() || null;
    } else {
      res
        .status(400)
        .json({ error: "stateSchoolCode must be a string or null" });
      return;
    }
  }
  if (body.active !== undefined) {
    if (typeof body.active !== "boolean") {
      res.status(400).json({ error: "active must be a boolean" });
      return;
    }
    patch.active = body.active;
  }

  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: "no editable fields supplied" });
    return;
  }

  // Pre-flight: school must exist; caller must own its district.
  const [school] = await db
    .select()
    .from(schoolsTable)
    .where(eq(schoolsTable.id, schoolId));
  if (!school) {
    res.status(404).json({ error: `School ${schoolId} not found` });
    return;
  }
  const crossDistrict = process.env.ALLOW_CROSS_DISTRICT_SUPERUSER === "1";
  if (!crossDistrict) {
    const callerDistrictId = await getDistrictIdForSchool(staff.schoolId);
    if (callerDistrictId === null || callerDistrictId !== school.districtId) {
      res
        .status(403)
        .json({ error: "Cannot edit a school in another district" });
      return;
    }
  }
  // The primary school of a district is a structural anchor — refuse
  // to deactivate it from this endpoint. (Renaming + state code edits
  // are fine.)
  if (patch.active === false && school.isPrimary) {
    res.status(409).json({
      error:
        "Cannot deactivate the district's primary school. Deactivate the district instead.",
    });
    return;
  }

  try {
    const [updated] = await db
      .update(schoolsTable)
      .set(patch)
      .where(eq(schoolsTable.id, schoolId))
      .returning();
    res.json({
      school: {
        id: updated.id,
        name: updated.name,
        shortName: updated.shortName,
        stateSchoolCode: updated.stateSchoolCode,
        active: updated.active,
        isPrimary: updated.isPrimary,
      },
    });
  } catch (err: any) {
    // Postgres unique_violation. The schema has a composite unique
    // index on (district_id, state_school_code); surface that as 409
    // instead of a generic 500 so the UI can show a useful message.
    if (err?.code === "23505") {
      res.status(409).json({
        error:
          "A school with that state code already exists in this district.",
      });
      return;
    }
    req.log?.error?.({ err, schoolId }, "patch-school failed");
    res.status(500).json({ error: "Failed to update school" });
  }
});

export default router;
