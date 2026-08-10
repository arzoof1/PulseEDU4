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
  housesTable,
  schoolsTable,
  staffMfaRecoveryCodesTable,
  authAuditLogTable,
} from "@workspace/db";
import { and, eq, asc, desc, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  staffIdFromBearerToken,
  bumpStaffAuthTokenVersion,
} from "../lib/staffBearerAuth.js";
import {
  writeAuthAudit,
  ensureAuthAuditChainColumns,
} from "../lib/authAudit.js";
import { verifyChain } from "../lib/authAuditChain.js";
import { bcryptHash } from "../lib/bcrypt.js";
import {
  getDistrictIdForSchool,
  getSchoolIdsForDistrict,
} from "../lib/scope";
import {
  verifyPrivilegedReauth,
  hasFreshPrivilegedReauth,
} from "../lib/privilegedReauth.js";
import { raiseSecurityAlert } from "../lib/securityAlerts.js";
import { generateAndHashTempPassword } from "../lib/tempPassword";
import { bindObjectToSchool } from "./storage.js";

const router: IRouter = Router();

type StaffRow = typeof staffTable.$inferSelect;

async function loadStaff(req: Request): Promise<StaffRow | null> {
  // Trust the server-side session OR a server-signed bearer token issued at
  // login. The bearer token is HMAC-signed with SESSION_SECRET so it can't
  // be forged or modified — that lets the privileged endpoints work inside
  // the Replit preview iframe (where the cookie is sometimes blocked)
  // without ever trusting a raw caller-supplied staffId.
  let id = req.staffId ?? null;
  if (!id) {
    const auth = req.headers.authorization;
    if (typeof auth === "string" && auth.startsWith("Bearer ")) {
      id = await staffIdFromBearerToken(auth.slice(7).trim());
    }
  }
  if (!id) return null;
  const [s] = await db.select().from(staffTable).where(eq(staffTable.id, id));
  return s && s.active ? s : null;
}

// Admin OR SuperUser may use this surface. Page-level cap_staff_roles also
// admits a non-admin who's been explicitly granted the page.
function requireAdminOrSuper() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const staff = await loadStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    if (!staff.isAdmin && !staff.isSuperUser && !staff.capStaffRoles) {
      res.status(403).json({ error: "Admin access required" });
      return;
    }
    (req as Request & { staff: StaffRow }).staff = staff;
    next();
  };
}

// Security-log viewer gate: any privileged role (Admin / District Admin /
// SuperUser). Broader than requireAdminOrSuper (which guards staff mutations)
// because a District Admin — who has no isAdmin flag of their own — must be
// able to read the audit trail for a school they've switched into.
function requirePrivileged() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const staff = await loadStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    if (!staff.isAdmin && !staff.isDistrictAdmin && !staff.isSuperUser) {
      res.status(403).json({ error: "Admin access required" });
      return;
    }
    (req as Request & { staff: StaffRow }).staff = staff;
    next();
  };
}

// True when the actor holds full role-management authority (Admin / SuperUser
// / cap_staff_roles). Core Team (without one of these) is admitted only to the
// list + PATCH endpoints below, and only to assign the four data-import caps —
// every other field is stripped from their PATCH.
function hasFullRoleAuthority(staff: StaffRow): boolean {
  return Boolean(staff.isAdmin || staff.isSuperUser || staff.capStaffRoles);
}

// Wider gate used ONLY for the staff list + the role-management PATCH so Core
// Team can delegate data importers. The create / reset-password / delete /
// bulk endpoints stay on requireAdminOrSuper(). Strict field-stripping in the
// PATCH handler keeps a Core-Team-only actor limited to the import caps.
function requireRoleManagerOrCoreTeam() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const staff = await loadStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    if (!hasFullRoleAuthority(staff) && !staff.isCoreTeam) {
      res.status(403).json({ error: "Admin access required" });
      return;
    }
    (req as Request & { staff: StaffRow }).staff = staff;
    next();
  };
}

const ROLE_FLAGS = [
  "isSuperUser",
  "isDistrictAdmin",
  "isAdmin",
  "isEseCoordinator",
  "isPbisCoordinator",
  "isBehaviorSpecialist",
  "isIssTeacher",
  "isDean",
  "isMtssCoordinator",
  "isCounselor",
  "isSocialWorker",
  "isSchoolPsychologist",
  "isGuidanceCounselor",
  "isNonExemptRole",
  "isFrontOffice",
  "isSro",
  "isGuardian",
  "isCoreTeam",
  "isConfidentialSecretary",
  "isAthleticDirector",
] as const;
type RoleFlag = (typeof ROLE_FLAGS)[number];

const CAP_FLAGS = [
  "capHallPasses",
  "capTardies",
  "capStudentActivity",
  "capPbisAward",
  "capParentEmail",
  "capSupportNotes",
  "capAccommodationLog",
  "capPulloutsRequest",
  "capInterventionLog",
  "capReports",
  "capKioskActivate",
  "capHallPassesViewAll",
  "capPbisManage",
  "capAccommodationManage",
  "capPulloutsVerify",
  "capPulloutsReview",
  "capInterventionManage",
  "capIssDashboard",
  "capManageLocations",
  "capStaffRoles",
  "capManageRoles",
  "capManageDisplays",
  "capCarRiderMonitor",
  "capManageDismissal",
  "capTourNotify",
  "capTourGuide",
  "capManageEsign",
  "capManageContactInfo",
  "capImportGrades",
  "capImportAttendance",
  "capImportFast",
  "capImportIready",
  // Admin-only assignable: NOT added to IMPORT_CAP_FLAGS below, so a
  // Core-Team-but-not-admin actor cannot delegate it (it gets stripped
  // from their PATCH). Only full role authority can set it.
  "capViewFastHistory",
] as const;
type CapFlag = (typeof CAP_FLAGS)[number];

// The four delegable data-import caps. Admin OR Core Team may assign these to
// any staff member; a Core-Team-but-not-admin actor may set ONLY these (every
// other role flag / cap is stripped from their PATCH below).
const IMPORT_CAP_FLAGS: readonly CapFlag[] = [
  "capImportGrades",
  "capImportAttendance",
  "capImportFast",
  "capImportIready",
] as const;

const ALL_BOOL_FIELDS = [...ROLE_FLAGS, ...CAP_FLAGS, "active" as const];

function pickBoolUpdates(
  body: unknown,
): Partial<Record<(typeof ALL_BOOL_FIELDS)[number], boolean>> {
  if (!body || typeof body !== "object") return {};
  const src = body as Record<string, unknown>;
  const out: Partial<Record<(typeof ALL_BOOL_FIELDS)[number], boolean>> = {};
  for (const key of ALL_BOOL_FIELDS) {
    if (typeof src[key] === "boolean") out[key] = src[key] as boolean;
  }
  return out;
}

const STAFF_SELECT = {
  id: staffTable.id,
  email: staffTable.email,
  displayName: staffTable.displayName,
  title: staffTable.title,
  active: staffTable.active,
  isSuperUser: staffTable.isSuperUser,
  isDistrictAdmin: staffTable.isDistrictAdmin,
  isAdmin: staffTable.isAdmin,
  isEseCoordinator: staffTable.isEseCoordinator,
  isPbisCoordinator: staffTable.isPbisCoordinator,
  isBehaviorSpecialist: staffTable.isBehaviorSpecialist,
  isIssTeacher: staffTable.isIssTeacher,
  isDean: staffTable.isDean,
  isMtssCoordinator: staffTable.isMtssCoordinator,
  isCounselor: staffTable.isCounselor,
  isSocialWorker: staffTable.isSocialWorker,
  isSchoolPsychologist: staffTable.isSchoolPsychologist,
  isGuidanceCounselor: staffTable.isGuidanceCounselor,
  isNonExemptRole: staffTable.isNonExemptRole,
  isFrontOffice: staffTable.isFrontOffice,
  isSro: staffTable.isSro,
  isGuardian: staffTable.isGuardian,
  isCoreTeam: staffTable.isCoreTeam,
  isConfidentialSecretary: staffTable.isConfidentialSecretary,
  isAthleticDirector: staffTable.isAthleticDirector,
  exemptStatus: staffTable.exemptStatus,
  capHallPasses: staffTable.capHallPasses,
  capTardies: staffTable.capTardies,
  capStudentActivity: staffTable.capStudentActivity,
  capPbisAward: staffTable.capPbisAward,
  capParentEmail: staffTable.capParentEmail,
  capSupportNotes: staffTable.capSupportNotes,
  capAccommodationLog: staffTable.capAccommodationLog,
  capPulloutsRequest: staffTable.capPulloutsRequest,
  capInterventionLog: staffTable.capInterventionLog,
  capReports: staffTable.capReports,
  capKioskActivate: staffTable.capKioskActivate,
  capHallPassesViewAll: staffTable.capHallPassesViewAll,
  capPbisManage: staffTable.capPbisManage,
  capAccommodationManage: staffTable.capAccommodationManage,
  capPulloutsVerify: staffTable.capPulloutsVerify,
  capPulloutsReview: staffTable.capPulloutsReview,
  capInterventionManage: staffTable.capInterventionManage,
  capIssDashboard: staffTable.capIssDashboard,
  capManageLocations: staffTable.capManageLocations,
  capStaffRoles: staffTable.capStaffRoles,
  capManageRoles: staffTable.capManageRoles,
  capManageDisplays: staffTable.capManageDisplays,
  capCarRiderMonitor: staffTable.capCarRiderMonitor,
  capManageDismissal: staffTable.capManageDismissal,
  capTourNotify: staffTable.capTourNotify,
  capTourGuide: staffTable.capTourGuide,
  capManageEsign: staffTable.capManageEsign,
  capManageContactInfo: staffTable.capManageContactInfo,
  capImportGrades: staffTable.capImportGrades,
  capImportAttendance: staffTable.capImportAttendance,
  capImportFast: staffTable.capImportFast,
  capImportIready: staffTable.capImportIready,
  capViewFastHistory: staffTable.capViewFastHistory,
  defaultRoom: staffTable.defaultRoom,
  houseId: staffTable.houseId,
  department: staffTable.department,
  photoObjectKey: staffTable.photoObjectKey,
  schoolId: staffTable.schoolId,
} as const;

// Fixed set of academic departments offered in the Staff & Roles dropdown
// and accepted by the patch endpoint. Kept in sync with the client list.
const DEPARTMENTS = [
  "ELA",
  "Math",
  "Science",
  "Social Studies",
  "CTE",
  "Elective",
  "Other",
] as const;

// Best-effort department guess from a display name that carries a subject
// suffix (e.g. "Jane Doe - ELA G6" -> "ELA"). Returns "" when nothing maps,
// so the export shows a blank the admin can fill in via the dropdown.
function deriveDepartmentFromName(displayName: string): string {
  const idx = displayName.lastIndexOf(" - ");
  if (idx === -1) return "";
  const subject = displayName.slice(idx + 3).toLowerCase();
  const has = (...needles: string[]) =>
    needles.some((n) => subject.includes(n));
  if (has("ela", "english", "reading", "lang arts", "language arts", "writing"))
    return "ELA";
  if (has("math", "algebra", "geometry", "calculus", "stats")) return "Math";
  if (has("science", "biology", "chemistry", "physics", "anatomy", "earth"))
    return "Science";
  if (
    has(
      "social studies",
      "history",
      "civics",
      "government",
      "geography",
      "economics",
    )
  )
    return "Social Studies";
  if (has("cte", "career", "technical", "computer", "coding", "business"))
    return "CTE";
  if (
    has(
      "elective",
      "art",
      "music",
      "band",
      "chorus",
      "pe",
      "physical ed",
      "health",
      "drama",
      "theatre",
      "theater",
      "spanish",
      "french",
      "world lang",
    )
  )
    return "Elective";
  return "";
}

// Human-readable role labels from the boolean role flags, most-senior first.
// Returns "Teacher" when no role flag is set (the baseline).
function roleLabelsFor(s: StaffRow): string {
  const labels: string[] = [];
  if (s.isSuperUser) labels.push("SuperUser");
  if (s.isDistrictAdmin) labels.push("District Admin");
  if (s.isAdmin) labels.push("Admin");
  if (s.isCounselor) labels.push("Counselor");
  if (s.isGuidanceCounselor) labels.push("Guidance Counselor");
  if (s.isDean) labels.push("Dean");
  if (s.isBehaviorSpecialist) labels.push("Behavior Specialist");
  if (s.isMtssCoordinator) labels.push("MTSS Coordinator");
  if (s.isEseCoordinator) labels.push("ESE Coordinator");
  if (s.isPbisCoordinator) labels.push("PBIS Coordinator");
  if (s.isSchoolPsychologist) labels.push("School Psychologist");
  if (s.isSocialWorker) labels.push("Social Worker");
  if (s.isIssTeacher) labels.push("ISS Teacher");
  if (s.isFrontOffice) labels.push("Front Office");
  if (s.isAthleticDirector) labels.push("Athletic Director");
  if (s.isSro) labels.push("SRO");
  if (s.isGuardian) labels.push("Guardian/Monitor");
  if (s.isNonExemptRole) labels.push("Non-Exempt Staff");
  return labels.length > 0 ? labels.join("; ") : "Teacher";
}

// CSV cell escaping. Two jobs:
//   1. Neutralize spreadsheet formula injection — a cell beginning with
//      =, +, -, @, or a tab/CR can execute when opened in Excel/Sheets, and
//      these fields (name, email, default room, external id) are
//      user-controlled. Prefix such values with a single quote. Matches the
//      pattern in routes/ticketing.ts.
//   2. RFC-4180 quoting — wrap in quotes and double any inner quotes when the
//      value contains a quote, comma, or newline.
function csvCell(value: unknown): string {
  let str = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(str)) str = `'${str}`;
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

// List staff with full role + capability flags. Scoped to the active school
// (`req.schoolId`) for everyone, including SuperUsers — a SuperUser sees the
// school they're currently switched into, and switches schools to manage
// another. District-wide reporting lives on dedicated district routes
// (e.g. districtOverview.ts), gated by capability, not this roster surface.
router.get(
  "/admin/staff",
  requireRoleManagerOrCoreTeam(),
  async (req: Request, res: Response) => {
    const schoolId = req.schoolId;
    if (!schoolId) {
      res.status(400).json({ error: "No active school" });
      return;
    }
    const rows = await db
      .select(STAFF_SELECT)
      .from(staffTable)
      .where(eq(staffTable.schoolId, schoolId))
      .orderBy(asc(staffTable.displayName));
    res.json(rows);
  },
);

// Security Events viewer (Section 3 — Logging & Monitoring). Read-only view of
// the authentication / privileged-action audit trail (auth_audit_log), written
// by the auth + MFA flows via writeAuthAudit. Scoped to the ACTIVE school
// (req.schoolId) exactly like the staff roster above — a SuperUser switches
// schools to view another, and no row from another tenant is ever returned.
router.get(
  "/admin/audit-log",
  requirePrivileged(),
  async (req: Request, res: Response) => {
    const schoolId = req.schoolId;
    if (!schoolId) {
      res.status(400).json({ error: "No active school" });
      return;
    }

    // limit: default 100, clamped to [1, 500]. action: optional exact filter.
    const parsedLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), 500)
      : 100;
    const action =
      typeof req.query.action === "string" && req.query.action.trim()
        ? req.query.action.trim()
        : null;

    const target = alias(staffTable, "audit_target");
    const whereClause = action
      ? and(
          eq(authAuditLogTable.schoolId, schoolId),
          eq(authAuditLogTable.action, action),
        )
      : eq(authAuditLogTable.schoolId, schoolId);

    const [events, actionRows] = await Promise.all([
      db
        .select({
          id: authAuditLogTable.id,
          action: authAuditLogTable.action,
          actorStaffId: authAuditLogTable.actorStaffId,
          actorName: authAuditLogTable.actorName,
          targetStaffId: authAuditLogTable.targetStaffId,
          targetName: target.displayName,
          ip: authAuditLogTable.ip,
          payload: authAuditLogTable.payload,
          createdAt: authAuditLogTable.createdAt,
        })
        .from(authAuditLogTable)
        .leftJoin(target, eq(target.id, authAuditLogTable.targetStaffId))
        .where(whereClause)
        .orderBy(desc(authAuditLogTable.createdAt))
        .limit(limit),
      // Distinct action names for the client's filter dropdown (small table).
      db
        .selectDistinct({ action: authAuditLogTable.action })
        .from(authAuditLogTable)
        .where(eq(authAuditLogTable.schoolId, schoolId)),
    ]);

    res.json({
      events,
      actions: actionRows
        .map((r) => r.action)
        .filter((a): a is string => !!a)
        .sort(),
    });
  },
);

// Verify the tamper-evidence hash chain over the entire auth audit log
// (Section 3.8). Returns aggregate integrity only — no row content — so it is
// safe for any privileged admin to run without exposing cross-school events.
// Step-up reauth gated like the other sensitive audit/export actions.
router.get(
  "/admin/audit-log/verify",
  requirePrivileged(),
  async (req: Request, res: Response) => {
    if (!hasFreshPrivilegedReauth(req.session)) {
      res.status(401).json({ error: "reauth_required" });
      return;
    }

    try {
      // Self-heal on a DB that predates 3.8 (prod runs without boot
      // migrations) so the query below never references a missing column.
      await ensureAuthAuditChainColumns();

      const rows = await db
        .select({
          id: authAuditLogTable.id,
          schoolId: authAuditLogTable.schoolId,
          action: authAuditLogTable.action,
          actorStaffId: authAuditLogTable.actorStaffId,
          actorName: authAuditLogTable.actorName,
          targetStaffId: authAuditLogTable.targetStaffId,
          ip: authAuditLogTable.ip,
          payload: authAuditLogTable.payload,
          createdAt: authAuditLogTable.createdAt,
          prevHash: authAuditLogTable.prevHash,
          entryHash: authAuditLogTable.entryHash,
        })
        .from(authAuditLogTable)
        .orderBy(asc(authAuditLogTable.id));

      const result = verifyChain(
        rows.map((r) => ({
          id: r.id,
          schoolId: r.schoolId,
          action: r.action,
          actorStaffId: r.actorStaffId,
          actorName: r.actorName,
          targetStaffId: r.targetStaffId,
          ip: r.ip,
          payload: r.payload,
          createdAtISO: r.createdAt.toISOString(),
          prevHash: r.prevHash,
          entryHash: r.entryHash,
        })),
      );

      res.json({ ...result, totalRows: rows.length });
    } catch (err) {
      // Chain not yet provisioned (e.g. no DDL privilege to add columns).
      // Degrade cleanly rather than 500 — the first successful audit write
      // provisions the columns and this endpoint then verifies normally.
      res.status(503).json({
        ok: null,
        pending: true,
        error: "audit_chain_unavailable",
        detail:
          "Audit chain columns are being provisioned; retry after the next audited action.",
      });
    }
  },
);

// Export the school's authentication / privileged-action audit trail as a CSV
// (Section 2.5). Every row carries the required fields — timestamp, action,
// actor, target, IP, and details — for a real privileged action. Privileged +
// step-up-reauth gated like the audit viewer and the roster export.
router.get(
  "/admin/audit-log/export.csv",
  requirePrivileged(),
  async (req: Request, res: Response) => {
    if (!hasFreshPrivilegedReauth(req.session)) {
      res.status(403).json({ error: "reauth_required" });
      return;
    }
    const schoolId = req.schoolId;
    if (!schoolId) {
      res.status(400).json({ error: "No active school" });
      return;
    }
    const target = alias(staffTable, "audit_export_target");
    const rows = await db
      .select({
        id: authAuditLogTable.id,
        createdAt: authAuditLogTable.createdAt,
        action: authAuditLogTable.action,
        actorStaffId: authAuditLogTable.actorStaffId,
        actorName: authAuditLogTable.actorName,
        targetStaffId: authAuditLogTable.targetStaffId,
        targetName: target.displayName,
        ip: authAuditLogTable.ip,
        payload: authAuditLogTable.payload,
      })
      .from(authAuditLogTable)
      .leftJoin(target, eq(target.id, authAuditLogTable.targetStaffId))
      .where(eq(authAuditLogTable.schoolId, schoolId))
      .orderBy(desc(authAuditLogTable.createdAt))
      .limit(5000);

    const header = [
      "ID",
      "Timestamp (UTC)",
      "Action",
      "Actor ID",
      "Actor",
      "Target ID",
      "Target",
      "IP",
      "Details",
    ];
    const lines = [header.map(csvCell).join(",")];
    for (const r of rows) {
      lines.push(
        [
          String(r.id),
          r.createdAt ? new Date(r.createdAt).toISOString() : "",
          r.action,
          r.actorStaffId != null ? String(r.actorStaffId) : "",
          r.actorName ?? "",
          r.targetStaffId != null ? String(r.targetStaffId) : "",
          r.targetName ?? "",
          r.ip ?? "",
          r.payload ? JSON.stringify(r.payload) : "",
        ]
          .map(csvCell)
          .join(","),
      );
    }
    const csv = "﻿" + lines.join("\r\n") + "\r\n";
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="security-audit-log-${stamp}.csv"`,
    );
    res.send(csv);
  },
);

// Export the full staff roster as a CSV (opens in Excel). Same scoping as the
// list endpoint: the active school only (SuperUsers switch schools to export
// another). Cell phone is admin-gated (admin / district admin / super only).
router.get(
  "/admin/staff/export.csv",
  requireAdminOrSuper(),
  async (req: Request, res: Response) => {
    const actor = (req as Request & { staff: StaffRow }).staff;
    // Step-up reauth (Section 1.15): bulk roster export is a PII-exfil surface.
    if (!hasFreshPrivilegedReauth(req.session)) {
      res.status(403).json({ error: "reauth_required" });
      return;
    }
    const canSeeCell =
      actor.isAdmin || actor.isDistrictAdmin || actor.isSuperUser;

    const schoolId = req.schoolId;
    if (!schoolId) {
      res.status(400).json({ error: "No active school" });
      return;
    }
    // status filter mirrors the on-screen roster filter so the CSV matches
    // what the admin is viewing. "current" = active staff (default),
    // "historical" = retired/inactive, "all" = both.
    const status = typeof req.query.status === "string" ? req.query.status : "";
    const activeCond =
      status === "historical"
        ? eq(staffTable.active, false)
        : status === "all"
          ? undefined
          : eq(staffTable.active, true);
    const rows: StaffRow[] = await db
      .select()
      .from(staffTable)
      .where(
        activeCond
          ? and(eq(staffTable.schoolId, schoolId), activeCond)
          : eq(staffTable.schoolId, schoolId),
      )
      .orderBy(asc(staffTable.displayName));

    // Resolve school + house names in two small lookups (avoids a join).
    const schoolIds = [...new Set(rows.map((r) => r.schoolId))];
    const houseIds = [
      ...new Set(rows.map((r) => r.houseId).filter((h): h is number => !!h)),
    ];
    const schoolNames = new Map<number, string>();
    if (schoolIds.length > 0) {
      const srows = await db
        .select({ id: schoolsTable.id, name: schoolsTable.name })
        .from(schoolsTable)
        .where(inArray(schoolsTable.id, schoolIds));
      for (const s of srows) schoolNames.set(s.id, s.name);
    }
    const houseNames = new Map<number, string>();
    if (houseIds.length > 0) {
      const hrows = await db
        .select({ id: housesTable.id, name: housesTable.name })
        .from(housesTable)
        .where(inArray(housesTable.id, houseIds));
      for (const h of hrows) houseNames.set(h.id, h.name);
    }

    const header = [
      "Name",
      "Email",
      "Role",
      "Department",
      "School",
      "Status",
      "Work extension",
      "Cell phone",
      "Default room",
      "PBIS house",
      "Exempt status",
      "SIS / External ID",
      "Date added",
    ];
    const lines = [header.map(csvCell).join(",")];
    for (const s of rows) {
      const department =
        (s.department && s.department.trim()) ||
        deriveDepartmentFromName(s.displayName);
      const exempt =
        s.exemptStatus === "exempt"
          ? "Exempt"
          : s.exemptStatus === "non_exempt"
            ? "Non-exempt"
            : "";
      const dateAdded = s.createdAt
        ? new Date(s.createdAt).toISOString().slice(0, 10)
        : "";
      lines.push(
        [
          s.displayName,
          s.email,
          roleLabelsFor(s),
          department,
          schoolNames.get(s.schoolId) ?? "",
          s.active ? "Active" : "Inactive",
          s.workExtension ?? "",
          canSeeCell ? (s.cellPhone ?? "") : "",
          s.defaultRoom ?? "",
          s.houseId ? (houseNames.get(s.houseId) ?? "") : "",
          exempt,
          s.externalId ?? "",
          dateAdded,
        ]
          .map(csvCell)
          .join(","),
      );
    }
    // BOM so Excel reads UTF-8 names correctly; CRLF line endings for Excel.
    const csv = "\uFEFF" + lines.join("\r\n") + "\r\n";
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="staff-roster-${stamp}.csv"`,
    );
    res.send(csv);
  },
);

// Update any subset of role/capability flags + active for one staff member.
router.patch(
  "/admin/staff/:id",
  requireRoleManagerOrCoreTeam(),
  async (req: Request, res: Response) => {
    const targetId = Number(req.params.id);
    if (!Number.isFinite(targetId)) {
      res.status(400).json({ error: "Invalid staff id" });
      return;
    }
    const boolUpdates = pickBoolUpdates(req.body);
    const updates: Record<string, unknown> = { ...boolUpdates };
    // Optional string field: defaultRoom. Empty string clears it (NULL).
    const body = (req.body ?? {}) as Record<string, unknown>;
    if ("defaultRoom" in body) {
      const v = body.defaultRoom;
      if (v === null || (typeof v === "string" && v.trim() === "")) {
        updates.defaultRoom = null;
      } else if (typeof v === "string") {
        updates.defaultRoom = v.trim();
      } else {
        res.status(400).json({ error: "defaultRoom must be a string or null" });
        return;
      }
    }
    // Optional string field: title (courtesy title / honorific). Empty string
    // clears it (NULL). Capped at 16 chars — it's a short prefix like "Mr."
    // or "Coach", not a free-form note.
    if ("title" in body) {
      const v = body.title;
      if (v === null || (typeof v === "string" && v.trim() === "")) {
        updates.title = null;
      } else if (typeof v === "string" && v.trim().length <= 16) {
        updates.title = v.trim();
      } else {
        res
          .status(400)
          .json({ error: "title must be a string of 16 characters or fewer" });
        return;
      }
    }
    // houseId: nullable FK to houses.id. Null clears it. Server-side
    // same-school validation happens AFTER we look up `target` (a few
    // lines below) — that's the only place we know the target's
    // school_id. We do NOT trust the UI ("picker only loads its school's
    // houses") as the security boundary, since a direct API call could
    // bypass it.
    if ("houseId" in body) {
      const v = body.houseId;
      if (v === null) {
        updates.houseId = null;
      } else if (typeof v === "number" && Number.isInteger(v) && v > 0) {
        updates.houseId = v;
      } else {
        res
          .status(400)
          .json({ error: "houseId must be a positive integer or null" });
        return;
      }
    }
    // exemptStatus: nullable text ('exempt' | 'non_exempt' | null). Admins
    // toggle this independently of the Non-Exempt role preset — some
    // non-exempt staff hold other roles. The Non-Exempt preset additionally
    // auto-flips this below if the field wasn't explicitly set in the same
    // request, so applying the preset "just works" for Comp Time accrual.
    if ("exemptStatus" in body) {
      const v = body.exemptStatus;
      if (v === null || (typeof v === "string" && v.trim() === "")) {
        updates.exemptStatus = null;
      } else if (
        typeof v === "string" &&
        (v === "exempt" || v === "non_exempt")
      ) {
        updates.exemptStatus = v;
      } else {
        res.status(400).json({
          error: "exemptStatus must be 'exempt', 'non_exempt', or null",
        });
        return;
      }
    }
    // department: nullable text constrained to the known DEPARTMENTS set.
    // Empty string clears it (NULL).
    if ("department" in body) {
      const v = body.department;
      if (v === null || (typeof v === "string" && v.trim() === "")) {
        updates.department = null;
      } else if (
        typeof v === "string" &&
        (DEPARTMENTS as readonly string[]).includes(v.trim())
      ) {
        updates.department = v.trim();
      } else {
        res.status(400).json({
          error: `department must be one of: ${DEPARTMENTS.join(", ")}, or empty`,
        });
        return;
      }
    }
    // Auto-flip exempt_status when the Non-Exempt role preset is applied.
    // Only fires when the field wasn't explicitly set in the same request,
    // so an admin can still override (e.g. apply the role bundle but keep
    // them marked 'exempt' for some unusual reason).
    if (updates.isNonExemptRole === true && !("exemptStatus" in body)) {
      updates.exemptStatus = "non_exempt";
    }
    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "No valid fields in request body" });
      return;
    }

    const actor = (req as Request & { staff: StaffRow }).staff;
    if (Object.keys(boolUpdates).length > 0) {
      const reauth = await verifyPrivilegedReauth(
        actor,
        body.reauth as { currentPassword?: unknown; code?: unknown } | undefined,
      );
      if (!reauth.ok) {
        res.status(reauth.status).json({ error: reauth.error });
        return;
      }
    }

    // Core-Team-without-full-authority actors are admitted to this PATCH ONLY
    // to delegate the four data-import caps. Strip every other field BEFORE the
    // role-escalation gates so a stray flag can't 403 the whole save (and can't
    // be smuggled through by a hand-crafted request — client gating is
    // bypassable). Full role managers (Admin/SuperUser/cap_staff_roles) keep
    // the complete field set.
    if (!hasFullRoleAuthority(actor)) {
      const allowed = new Set<string>(IMPORT_CAP_FLAGS);
      for (const key of Object.keys(updates)) {
        if (!allowed.has(key)) delete updates[key];
      }
      if (Object.keys(updates).length === 0) {
        res
          .status(403)
          .json({ error: "You may only assign data-import capabilities." });
        return;
      }
    }

    // Only SuperUser may grant or remove SuperUser. Only SuperUser/Admin may
    // change Admin. cap_staff_roles by itself does NOT permit escalation —
    // the dangerous caps (cap_staff_roles, cap_manage_roles) are also
    // restricted to Admin/SuperUser to prevent a cap_staff_roles holder
    // from bootstrapping themselves into full control.
    if ("isSuperUser" in updates && !actor.isSuperUser) {
      res.status(403).json({ error: "Only a SuperUser can change SuperUser." });
      return;
    }
    // District Admin is grant-only by SuperUser. School Admins cannot
    // promote anyone to a tier above their own scope; without this gate a
    // school Admin could grant District Admin to a colleague (or
    // themselves) and immediately gain district-wide reach.
    if ("isDistrictAdmin" in updates && !actor.isSuperUser) {
      res
        .status(403)
        .json({ error: "Only a SuperUser can change District Admin." });
      return;
    }
    if ("isAdmin" in updates && !actor.isSuperUser && !actor.isAdmin) {
      res.status(403).json({ error: "Only Admin/SuperUser can change Admin." });
      return;
    }
    if (
      ("capStaffRoles" in updates || "capManageRoles" in updates) &&
      !actor.isSuperUser &&
      !actor.isAdmin
    ) {
      res
        .status(403)
        .json({ error: "Only Admin/SuperUser can change role-management capabilities." });
      return;
    }
    // Historical FAST access is Admin/SuperUser-only to assign — Core Team
    // (incl. cap_staff_roles holders, who otherwise pass hasFullRoleAuthority
    // and keep the full field set) CANNOT delegate it. Without this explicit
    // gate a cap_staff_roles actor could grant capViewFastHistory to anyone.
    if (
      "capViewFastHistory" in updates &&
      !actor.isSuperUser &&
      !actor.isAdmin
    ) {
      res
        .status(403)
        .json({ error: "Only Admin/SuperUser can assign Historical FAST access." });
      return;
    }

    if (targetId === actor.id) {
      if (updates.isSuperUser === false && actor.isSuperUser) {
        res
          .status(409)
          .json({ error: "You cannot remove your own SuperUser role." });
        return;
      }
      if (
        updates.isDistrictAdmin === false &&
        actor.isDistrictAdmin &&
        !actor.isSuperUser
      ) {
        res
          .status(409)
          .json({ error: "You cannot remove your own District Admin role." });
        return;
      }
      if (updates.isAdmin === false && actor.isAdmin && !actor.isSuperUser) {
        res
          .status(409)
          .json({ error: "You cannot remove your own admin role." });
        return;
      }
      if (updates.active === false) {
        res
          .status(409)
          .json({ error: "You cannot deactivate your own account." });
        return;
      }
      if (updates.capStaffRoles === false || updates.capManageRoles === false) {
        res
          .status(409)
          .json({ error: "You cannot revoke your own role-management access." });
        return;
      }
    }

    // Non-SuperUsers can only manage staff in their own school. SuperUsers
    // retain district-wide reach but NOT cross-district reach (since D6 /
    // Pasco onboarding). The target must be in the actor's district.
    const actorDistrictSchoolIds = actor.isSuperUser
      ? await (async () => {
          const did = await getDistrictIdForSchool(actor.schoolId);
          return did !== null ? await getSchoolIdsForDistrict(did) : [];
        })()
      : null;

    const [target] = await db
      .select()
      .from(staffTable)
      .where(
        actor.isSuperUser
          ? and(
              eq(staffTable.id, targetId),
              actorDistrictSchoolIds && actorDistrictSchoolIds.length > 0
                ? inArray(staffTable.schoolId, actorDistrictSchoolIds)
                : sql`false`,
            )
          : and(
              eq(staffTable.id, targetId),
              eq(staffTable.schoolId, actor.schoolId),
            ),
      );
    if (!target) {
      res.status(404).json({ error: "Staff not found" });
      return;
    }

    // Cross-tenant guard: a non-null houseId must belong to the same
    // school as the target staff member. Without this, an admin (or
    // any direct API caller) could attach School A's staff to School
    // B's house, silently corrupting multi-tenant data. The check fires
    // only when houseId is being set to a non-null value.
    if (
      "houseId" in updates &&
      typeof updates.houseId === "number"
    ) {
      const [house] = await db
        .select({ id: housesTable.id })
        .from(housesTable)
        .where(
          and(
            eq(housesTable.id, updates.houseId),
            eq(housesTable.schoolId, target.schoolId),
          ),
        );
      if (!house) {
        res.status(400).json({
          error:
            "House does not exist or belongs to a different school than this staff member.",
        });
        return;
      }
    }

    const [updated] = await db
      .update(staffTable)
      .set(updates)
      .where(
        actor.isSuperUser
          ? and(
              eq(staffTable.id, targetId),
              actorDistrictSchoolIds && actorDistrictSchoolIds.length > 0
                ? inArray(staffTable.schoolId, actorDistrictSchoolIds)
                : sql`false`,
            )
          : and(
              eq(staffTable.id, targetId),
              eq(staffTable.schoolId, actor.schoolId),
            ),
      )
      .returning(STAFF_SELECT);

    // Audit any change to a role / capability / active flag (item 3.6). Only
    // security-relevant fields are recorded — routine edits (room, title, house)
    // are intentionally left out so the security log stays signal, not noise.
    const roleChanges: Record<string, { from: unknown; to: unknown }> = {};
    for (const field of ALL_BOOL_FIELDS) {
      const before = (target as Record<string, unknown>)[field];
      const after = (updates as Record<string, unknown>)[field];
      if (field in updates && before !== after) {
        roleChanges[field] = { from: before, to: after };
      }
    }
    if (Object.keys(roleChanges).length > 0) {
      await writeAuthAudit({
        action: "role_changed",
        schoolId: target.schoolId,
        actorStaffId: actor.id,
        actorName: actor.displayName,
        targetStaffId: targetId,
        ip: req.ip ?? null,
        payload: { targetName: target.displayName, changes: roleChanges },
      });
      // Security alert (3.6): notify admins of the role/access change with a
      // human-readable before→after summary.
      const changesSummary = Object.entries(roleChanges)
        .map(([k, v]) => `${k}: ${v.from ? "on" : "off"}→${v.to ? "on" : "off"}`)
        .join(", ");
      await raiseSecurityAlert({
        schoolId: target.schoolId,
        type: "security_role_changed",
        payload: {
          actorName: actor.displayName,
          targetName: target.displayName,
          changesSummary,
        },
      });
    }

    res.json(updated);
  },
);

// Create a new staff member. Admin/SuperUser only.
router.post(
  "/admin/staff",
  requireAdminOrSuper(),
  async (req: Request, res: Response) => {
    const actor = (req as Request & { staff: StaffRow }).staff;
    const { email, displayName, password } = (req.body ?? {}) as {
      email?: unknown;
      displayName?: unknown;
      password?: unknown;
    };
    if (
      typeof email !== "string" ||
      typeof displayName !== "string" ||
      typeof password !== "string" ||
      !email.trim() ||
      !displayName.trim() ||
      password.length < 8
    ) {
      res.status(400).json({
        error: "email, displayName, and password (min 8 chars) are required",
      });
      return;
    }
    const normEmail = email.trim().toLowerCase();
    const [existing] = await db
      .select({ id: staffTable.id })
      .from(staffTable)
      .where(eq(staffTable.email, normEmail));
    if (existing) {
      res.status(409).json({ error: "A staff member with that email exists." });
      return;
    }

    const updates = pickBoolUpdates(req.body);
    // Same privilege gating as the patch endpoint. A cap_staff_roles holder
    // who is not Admin/SuperUser must not be able to create users with
    // SuperUser/Admin or with the role-management caps themselves — that
    // would be a privilege-escalation bootstrap.
    if (updates.isSuperUser && !actor.isSuperUser) delete updates.isSuperUser;
    if (updates.isDistrictAdmin && !actor.isSuperUser) {
      delete updates.isDistrictAdmin;
    }
    if (updates.isAdmin && !actor.isSuperUser && !actor.isAdmin) {
      delete updates.isAdmin;
    }
    if (!actor.isSuperUser && !actor.isAdmin) {
      delete updates.capStaffRoles;
      delete updates.capManageRoles;
    }

    // School assignment for the new row:
    //   * SuperUser may target any school via body.schoolId IN THEIR OWN
    //     DISTRICT (defaults to their own school if not supplied). Cross-
    //     district seeding is rejected — that would be a Hernando admin
    //     creating staff inside a Pasco school.
    //   * Everyone else creates strictly into their own school — body
    //     overrides are ignored to prevent cross-school staff seeding.
    const bodySchoolId = Number((req.body as { schoolId?: unknown })?.schoolId);
    let targetSchoolId = actor.schoolId;
    if (
      actor.isSuperUser &&
      Number.isInteger(bodySchoolId) &&
      bodySchoolId > 0
    ) {
      const actorDistrictId = await getDistrictIdForSchool(actor.schoolId);
      const targetDistrictId = await getDistrictIdForSchool(bodySchoolId);
      if (
        actorDistrictId === null ||
        targetDistrictId === null ||
        actorDistrictId !== targetDistrictId
      ) {
        res
          .status(403)
          .json({ error: "Cannot create staff in a school outside your district." });
        return;
      }
      targetSchoolId = bodySchoolId;
    }

    const passwordHash = await bcryptHash(password, 10);
    const [row] = await db
      .insert(staffTable)
      .values({
        email: normEmail,
        displayName: displayName.trim(),
        passwordHash,
        schoolId: targetSchoolId,
        ...updates,
      })
      .returning(STAFF_SELECT);
    await writeAuthAudit({
      action: "staff_created",
      schoolId: row.schoolId ?? targetSchoolId,
      actorStaffId: actor.id,
      actorName: actor.displayName,
      targetStaffId: row.id,
      ip: req.ip ?? null,
      payload: { email: normEmail, displayName: displayName.trim() },
    });
    res.status(201).json(row);
  },
);

// Admin / SuperUser resets another staff member's password.
//   - Non-SuperUser cannot reset a SuperUser's password (would let them
//     take over a SuperUser account).
//   - Non-Admin/SuperUser (i.e. someone holding only cap_staff_roles) is
//     blocked entirely — password reset is a privileged operation, not a
//     matrix-edit operation.
router.post(
  "/admin/staff/:id/password",
  requireAdminOrSuper(),
  async (req: Request, res: Response) => {
    const actor = (req as Request & { staff: StaffRow }).staff;
    if (!actor.isAdmin && !actor.isSuperUser) {
      res
        .status(403)
        .json({ error: "Only Admin or SuperUser can reset passwords." });
      return;
    }

    const targetId = Number(req.params.id);
    if (!Number.isFinite(targetId)) {
      res.status(400).json({ error: "Invalid staff id" });
      return;
    }

    // Self-reset must go through /auth/change-password (which proves the
    // caller knows the current password). Going through the admin path
    // would let anyone with admin/super skip that proof for themselves.
    if (targetId === actor.id) {
      res.status(409).json({
        error: "Use Change Password to update your own password.",
      });
      return;
    }

    const { newPassword } = (req.body ?? {}) as { newPassword?: unknown };
    if (typeof newPassword !== "string" || newPassword.length < 8) {
      res
        .status(400)
        .json({ error: "newPassword (min 8 chars) is required" });
      return;
    }

    // Same scoping as PATCH: non-SuperUser admins may only reset passwords
    // for staff in their own school. Without this, a school A admin who
    // knew a school B staff id could take over that account. SuperUser is
    // district-scoped (since D6) — no cross-district password resets.
    const actorDistrictSchoolIdsPwd = actor.isSuperUser
      ? await (async () => {
          const did = await getDistrictIdForSchool(actor.schoolId);
          return did !== null ? await getSchoolIdsForDistrict(did) : [];
        })()
      : null;

    const [target] = await db
      .select()
      .from(staffTable)
      .where(
        actor.isSuperUser
          ? and(
              eq(staffTable.id, targetId),
              actorDistrictSchoolIdsPwd && actorDistrictSchoolIdsPwd.length > 0
                ? inArray(staffTable.schoolId, actorDistrictSchoolIdsPwd)
                : sql`false`,
            )
          : and(
              eq(staffTable.id, targetId),
              eq(staffTable.schoolId, actor.schoolId),
            ),
      );
    if (!target) {
      res.status(404).json({ error: "Staff not found" });
      return;
    }

    if (!target.active) {
      res.status(409).json({
        error: "Reactivate this account before resetting its password.",
      });
      return;
    }

    if (target.isSuperUser && !actor.isSuperUser) {
      res
        .status(403)
        .json({ error: "Only a SuperUser can reset a SuperUser's password." });
      return;
    }
    // Same defense-in-depth for the new District Admin tier — without this a
    // school Admin could quietly take over a DA account by resetting their
    // password and logging in. The tier-grant gate (above) is necessary but
    // not sufficient on its own.
    if (target.isDistrictAdmin && !actor.isSuperUser) {
      res.status(403).json({
        error: "Only a SuperUser can reset a District Admin's password.",
      });
      return;
    }

    const passwordHash = await bcryptHash(newPassword, 10);
    await db
      .update(staffTable)
      .set({ passwordHash })
      .where(eq(staffTable.id, targetId));
    await writeAuthAudit({
      action: "admin_password_reset",
      schoolId: target.schoolId,
      actorStaffId: actor.id,
      actorName: actor.displayName,
      targetStaffId: targetId,
      ip: req.ip ?? null,
      payload: { targetName: target.displayName, mode: "set_password" },
    });

    res.json({ ok: true });
  },
);

// Admin / SuperUser regenerates a CSPRNG temp password for another staff
// member and gets it back ONCE in the response — same shape as the
// "we created your first admin" panel from the onboard-district wizard.
// Use case: staff member lost their temp password before first sign-in,
// or admin needs to "reinvite" a new hire who never logged in. We don't
// have an email-invite table yet (see Open work in replit.md); until
// then this read-it-once-and-paste-it-to-the-user flow is the smallest
// path to ship the punch-list item without growing a new schema.
//
// Reuses every gate from POST /admin/staff/:id/password above:
//   - Admin/SuperUser only (not cap_staff_roles).
//   - Non-self (self must use /auth/change-password).
//   - Same-school for non-SuperUser, district-scoped for SuperUser.
//   - Cannot reset SuperUser/District-Admin unless caller is SuperUser.
//   - Cannot reset inactive accounts.
router.post(
  "/admin/staff/:id/reset-temp-password",
  requireAdminOrSuper(),
  async (req: Request, res: Response) => {
    const actor = (req as Request & { staff: StaffRow }).staff;
    if (!actor.isAdmin && !actor.isSuperUser) {
      res
        .status(403)
        .json({ error: "Only Admin or SuperUser can reset passwords." });
      return;
    }

    const targetId = Number(req.params.id);
    if (!Number.isFinite(targetId)) {
      res.status(400).json({ error: "Invalid staff id" });
      return;
    }

    if (targetId === actor.id) {
      res.status(409).json({
        error: "Use Change Password to update your own password.",
      });
      return;
    }

    const actorDistrictSchoolIds = actor.isSuperUser
      ? await (async () => {
          const did = await getDistrictIdForSchool(actor.schoolId);
          return did !== null ? await getSchoolIdsForDistrict(did) : [];
        })()
      : null;

    const [target] = await db
      .select()
      .from(staffTable)
      .where(
        actor.isSuperUser
          ? and(
              eq(staffTable.id, targetId),
              actorDistrictSchoolIds && actorDistrictSchoolIds.length > 0
                ? inArray(staffTable.schoolId, actorDistrictSchoolIds)
                : sql`false`,
            )
          : and(
              eq(staffTable.id, targetId),
              eq(staffTable.schoolId, actor.schoolId),
            ),
      );
    if (!target) {
      res.status(404).json({ error: "Staff not found" });
      return;
    }

    if (!target.active) {
      res.status(409).json({
        error: "Reactivate this account before resetting its password.",
      });
      return;
    }

    if (target.isSuperUser && !actor.isSuperUser) {
      res
        .status(403)
        .json({ error: "Only a SuperUser can reset a SuperUser's password." });
      return;
    }
    if (target.isDistrictAdmin && !actor.isSuperUser) {
      res.status(403).json({
        error: "Only a SuperUser can reset a District Admin's password.",
      });
      return;
    }

    const { tempPassword, passwordHash } = await generateAndHashTempPassword();
    await db
      .update(staffTable)
      .set({ passwordHash })
      .where(eq(staffTable.id, targetId));
    await writeAuthAudit({
      action: "admin_password_reset",
      schoolId: target.schoolId,
      actorStaffId: actor.id,
      actorName: actor.displayName,
      targetStaffId: targetId,
      ip: req.ip ?? null,
      payload: { targetName: target.displayName, mode: "temp_password" },
    });

    res.json({
      ok: true,
      tempPassword,
      displayName: target.displayName,
      email: target.email,
    });
  },
);

// ---------------------------------------------------------------------------
// Staff MFA admin controls (Gate A / Section 1). Load a target staff row
// scoped to the actor's authority (SuperUser = own district; else own school),
// then enforce the same role hierarchy as reset-temp-password (only a
// SuperUser may act on a SuperUser / District Admin).
// ---------------------------------------------------------------------------
async function loadScopedTargetStaff(
  actor: StaffRow,
  targetId: number,
): Promise<StaffRow | null> {
  const actorDistrictSchoolIds = actor.isSuperUser
    ? await (async () => {
        const did = await getDistrictIdForSchool(actor.schoolId);
        return did !== null ? await getSchoolIdsForDistrict(did) : [];
      })()
    : null;
  const [target] = await db
    .select()
    .from(staffTable)
    .where(
      actor.isSuperUser
        ? and(
            eq(staffTable.id, targetId),
            actorDistrictSchoolIds && actorDistrictSchoolIds.length > 0
              ? inArray(staffTable.schoolId, actorDistrictSchoolIds)
              : sql`false`,
          )
        : and(
            eq(staffTable.id, targetId),
            eq(staffTable.schoolId, actor.schoolId),
          ),
    );
  return target ?? null;
}

function mfaAdminGuardError(actor: StaffRow, target: StaffRow): string | null {
  if (!actor.isAdmin && !actor.isSuperUser)
    return "Only Admin or SuperUser can manage staff two-factor.";
  if (target.isSuperUser && !actor.isSuperUser)
    return "Only a SuperUser can act on a SuperUser.";
  if (target.isDistrictAdmin && !actor.isSuperUser)
    return "Only a SuperUser can act on a District Admin.";
  return null;
}

// Force sign-out: invalidate every active session (authenticated OR mid-MFA)
// for a target user, plus bearer tokens. Item 1.14.
router.post(
  "/admin/staff/:id/revoke-sessions",
  requireAdminOrSuper(),
  async (req: Request, res: Response) => {
    const actor = (req as Request & { staff: StaffRow }).staff;
    const targetId = Number(req.params.id);
    if (!Number.isFinite(targetId)) {
      res.status(400).json({ error: "Invalid staff id" });
      return;
    }
    const target = await loadScopedTargetStaff(actor, targetId);
    if (!target) {
      res.status(404).json({ error: "Staff not found" });
      return;
    }
    const guardErr = mfaAdminGuardError(actor, target);
    if (guardErr) {
      res.status(403).json({ error: guardErr });
      return;
    }
    await db.execute(
      sql`DELETE FROM user_sessions
          WHERE (sess->>'staffId')::int = ${targetId}
             OR (sess->>'pendingMfaStaffId')::int = ${targetId}`,
    );
    await bumpStaffAuthTokenVersion(targetId);
    await writeAuthAudit({
      action: "sessions_revoked",
      schoolId: target.schoolId,
      actorStaffId: actor.id,
      actorName: actor.displayName,
      targetStaffId: targetId,
      ip: req.ip ?? null,
    });
    res.json({ ok: true });
  },
);

// Admin reset of a locked-out user's MFA: clear the secret + enrollment and
// delete recovery codes so they can re-enroll (or log in without MFA until a
// policy flag requires it again). Also revokes bearer tokens.
router.post(
  "/admin/staff/:id/mfa-reset",
  requireAdminOrSuper(),
  async (req: Request, res: Response) => {
    const actor = (req as Request & { staff: StaffRow }).staff;
    const targetId = Number(req.params.id);
    if (!Number.isFinite(targetId)) {
      res.status(400).json({ error: "Invalid staff id" });
      return;
    }
    const target = await loadScopedTargetStaff(actor, targetId);
    if (!target) {
      res.status(404).json({ error: "Staff not found" });
      return;
    }
    const guardErr = mfaAdminGuardError(actor, target);
    if (guardErr) {
      res.status(403).json({ error: guardErr });
      return;
    }
    await db
      .update(staffTable)
      .set({ mfaSecretEnc: null, mfaEnrolledAt: null })
      .where(eq(staffTable.id, targetId));
    await db
      .delete(staffMfaRecoveryCodesTable)
      .where(eq(staffMfaRecoveryCodesTable.staffId, targetId));
    await bumpStaffAuthTokenVersion(targetId);
    await writeAuthAudit({
      action: "mfa_admin_reset",
      schoolId: target.schoolId,
      actorStaffId: actor.id,
      actorName: actor.displayName,
      targetStaffId: targetId,
      ip: req.ip ?? null,
    });
    res.json({ ok: true });
  },
);

// ---------------------------------------------------------------------------
// Staff photo manager — mirrors the student photo flow (routes/students.ts).
// Bytes go through the existing /api/storage/* pipeline (so the ACL is
// school-scoped automatically); we just record the resulting objectKey on
// the staff row. Used for ID badges + staff-facing avatars. Admin-gated.
// Bytes are NEVER deleted on replace/clear — the previous object stays in
// storage (orphaned) so an accidental delete can be recovered.
// ---------------------------------------------------------------------------
router.post(
  "/staff/:staffId/photo",
  requireAdminOrSuper(),
  async (req: Request, res: Response): Promise<void> => {
    const staffId = Number(req.params.staffId);
    const objectPath: string =
      typeof req.body?.objectPath === "string"
        ? req.body.objectPath.trim()
        : "";
    if (!Number.isInteger(staffId) || staffId <= 0) {
      res.status(400).json({ error: "staffId required" });
      return;
    }
    if (!objectPath || !objectPath.startsWith("/objects/")) {
      res.status(400).json({ error: "objectPath required (/objects/...)" });
      return;
    }
    // Cross-school safety — the target staff member must be in the active
    // school (the one the actor is currently switched into). SuperUsers
    // switch schools to manage another school's staff.
    const schoolId = req.schoolId;
    if (!schoolId) {
      res.status(400).json({ error: "No active school" });
      return;
    }
    const [target] = await db
      .select({ id: staffTable.id, schoolId: staffTable.schoolId })
      .from(staffTable)
      .where(and(eq(staffTable.id, staffId), eq(staffTable.schoolId, schoolId)));
    if (!target) {
      res.status(404).json({ error: "Staff member not found" });
      return;
    }
    // Bind the freshly-uploaded object to the target's school. Returns
    // false if the path was issued to a different school or already bound
    // elsewhere — both reject so a hostile client can't reassign someone
    // else's image to one of our staff.
    const ok = await bindObjectToSchool(objectPath, target.schoolId);
    if (!ok) {
      res
        .status(403)
        .json({ error: "Object not bound — re-upload and try again" });
      return;
    }
    await db
      .update(staffTable)
      .set({ photoObjectKey: objectPath })
      .where(eq(staffTable.id, target.id));
    res.json({ ok: true, photoObjectKey: objectPath });
  },
);

router.delete(
  "/staff/:staffId/photo",
  requireAdminOrSuper(),
  async (req: Request, res: Response): Promise<void> => {
    const staffId = Number(req.params.staffId);
    if (!Number.isInteger(staffId) || staffId <= 0) {
      res.status(400).json({ error: "staffId required" });
      return;
    }
    const schoolId = req.schoolId;
    if (!schoolId) {
      res.status(400).json({ error: "No active school" });
      return;
    }
    const result = await db
      .update(staffTable)
      .set({ photoObjectKey: null })
      .where(and(eq(staffTable.id, staffId), eq(staffTable.schoolId, schoolId)));
    res.json({ ok: true, updated: result.rowCount ?? 0 });
  },
);

export default router;
