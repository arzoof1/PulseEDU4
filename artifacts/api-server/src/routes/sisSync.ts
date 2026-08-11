import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { db, staffTable, staffPasswordResetsTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import {
  requireSchool,
  canImportSchoolData,
  canImportDistrictData,
  getDistrictIdForSchool,
} from "../lib/scope.js";
import {
  ensureParrottClasslinkIntegration,
  getSisDistrictDashboard,
  listSisSyncIntegrations,
  runScheduledSisRosterSyncs,
  runSisSyncForIntegration,
  runSisSyncForSchool,
} from "../lib/sisRosterSync.js";
import {
  discoverNewClasslinkSchools,
  onboardClasslinkSchools,
} from "../lib/sisSchoolOnboarding.js";
import { writeAuthAudit } from "../lib/authAudit.js";
import {
  hashStaffPasswordResetToken,
  issueStaffPasswordResetToken,
  staffPasswordResetExpiresAt,
} from "../lib/staffPasswordResetToken.js";
import {
  buildStaffPasswordResetUrl,
  sendStaffPasswordResetEmail,
} from "../lib/staffPasswordResetEmail.js";
import { ensureStaffPasswordResetsSchema } from "../seed.js";
import { isEmailGloballyEnabled } from "../lib/emailGlobalSwitch.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

const RESET_LINK_EXPIRES_MINUTES = 30;

type StaffRow = typeof staffTable.$inferSelect;

async function loadStaff(req: Request): Promise<StaffRow | null> {
  const id = req.staffId;
  if (!id) return null;
  const [s] = await db.select().from(staffTable).where(eq(staffTable.id, id));
  return s && s.active ? s : null;
}

function requireSisSyncAdmin() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const staff = await loadStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    if (!canImportSchoolData(staff)) {
      res.status(403).json({ error: "Admin access required for roster sync." });
      return;
    }
    (req as Request & { staff: StaffRow }).staff = staff;
    next();
  };
}

function requireDistrictSisSyncAdmin() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const staff = await loadStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    if (!canImportDistrictData(staff)) {
      res.status(403).json({
        error: "SuperUser or District Admin access required.",
      });
      return;
    }
    (req as Request & { staff: StaffRow }).staff = staff;
    next();
  };
}

function clientIp(req: Request): string | null {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.trim()) return xf.split(",")[0]!.trim();
  return req.socket.remoteAddress ?? null;
}

function userAgent(req: Request): string | null {
  const ua = req.headers["user-agent"];
  return typeof ua === "string" ? ua.slice(0, 500) : null;
}

/** Short Sync button label from district integration school name. */
export function shortSyncSchoolLabel(schoolName: string): string {
  const n = schoolName.trim();
  if (/parrott/i.test(n)) return "Parrott";
  if (/challenger/i.test(n)) return "Challenger";
  if (/springsteen/i.test(n)) return "Springsteen";
  if (/fox\s*chapel/i.test(n)) return "Fox Chapel";
  if (/west\s*hernando/i.test(n)) return "West Hernando";
  if (/nature\s*coast/i.test(n)) return "Nature Coast";
  if (/powell/i.test(n)) return "Powell";
  if (/explorer/i.test(n)) return "Explorer";
  // Fall back to leading tokens before "Middle/Elementary/…"
  const m = n.match(/^(.+?)\s+(Middle|Elementary|High|K-?8|School)/i);
  if (m?.[1]) return m[1].replace(/^D\.?\s*S\.?\s*/i, "").trim() || n;
  return n.length > 28 ? `${n.slice(0, 26)}…` : n;
}

type InviteResult = {
  staffId: number;
  email: string;
  displayName: string;
  emailSent: boolean;
  emailStatus: string;
  resetUrl: string;
  emailError?: string;
};

async function issueSetPasswordInvite(args: {
  staff: { id: number; email: string; displayName: string };
  requestIp: string | null;
  userAgent: string | null;
}): Promise<InviteResult> {
  await ensureStaffPasswordResetsSchema();
  const expiresAt = staffPasswordResetExpiresAt();
  const [resetRow] = await db
    .insert(staffPasswordResetsTable)
    .values({
      staffId: args.staff.id,
      email: args.staff.email,
      status: "requested",
      expiresAt,
      requestIp: args.requestIp,
      userAgent: args.userAgent,
    })
    .returning({ id: staffPasswordResetsTable.id });

  const token = issueStaffPasswordResetToken({
    resetId: resetRow.id,
    staffId: args.staff.id,
    expiresAt,
  });
  const tokenHash = hashStaffPasswordResetToken(token);
  await db
    .update(staffPasswordResetsTable)
    .set({ tokenHash })
    .where(eq(staffPasswordResetsTable.id, resetRow.id));

  const resetUrl = buildStaffPasswordResetUrl(token);
  const emailEnabled = isEmailGloballyEnabled();

  if (!emailEnabled) {
    await db
      .update(staffPasswordResetsTable)
      .set({
        status: "email_skipped",
        emailError: "EMAIL_ENABLED is false — copy-link invite only",
      })
      .where(eq(staffPasswordResetsTable.id, resetRow.id));
    return {
      staffId: args.staff.id,
      email: args.staff.email,
      displayName: args.staff.displayName,
      emailSent: false,
      emailStatus: "email_skipped",
      resetUrl,
      emailError: "Email disabled — use copy link",
    };
  }

  try {
    await sendStaffPasswordResetEmail({
      to: args.staff.email,
      displayName: args.staff.displayName,
      resetUrl,
      expiresMinutes: RESET_LINK_EXPIRES_MINUTES,
      invite: true,
    });
    await db
      .update(staffPasswordResetsTable)
      .set({ status: "email_sent", emailSentAt: new Date() })
      .where(eq(staffPasswordResetsTable.id, resetRow.id));
    return {
      staffId: args.staff.id,
      email: args.staff.email,
      displayName: args.staff.displayName,
      emailSent: true,
      emailStatus: "email_sent",
      resetUrl,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { err, staffId: args.staff.id },
      "ClassLink set-password invite email failed",
    );
    await db
      .update(staffPasswordResetsTable)
      .set({ status: "email_failed", emailError: msg })
      .where(eq(staffPasswordResetsTable.id, resetRow.id));
    return {
      staffId: args.staff.id,
      email: args.staff.email,
      displayName: args.staff.displayName,
      emailSent: false,
      emailStatus: "email_failed",
      resetUrl,
      emailError: msg,
    };
  }
}

/** GET /sis-sync/status — sync metadata for integrations visible to this school. */
router.get("/sis-sync/status", requireSisSyncAdmin(), async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;

  if (process.env.CLASSLINK_MOCK?.trim().toLowerCase() === "true") {
    await ensureParrottClasslinkIntegration();
  }

  const all = await listSisSyncIntegrations();
  const mine = all.filter((row) => row.resolvedSchoolId === schoolId);

  res.json({
    schoolId,
    mockMode: process.env.CLASSLINK_MOCK?.trim().toLowerCase() === "true",
    integrations: mine.length > 0 ? mine : all,
  });
});

/**
 * GET /sis-sync/district-dashboard — SuperUser / District Admin control panel.
 * Live PulseEDU counts + last sync status per ClassLink integration.
 */
router.get(
  "/sis-sync/district-dashboard",
  requireDistrictSisSyncAdmin(),
  async (_req, res) => {
    if (process.env.CLASSLINK_MOCK?.trim().toLowerCase() === "true") {
      await ensureParrottClasslinkIntegration();
    }
    const integrations = await getSisDistrictDashboard();
    res.json({
      emailEnabled: isEmailGloballyEnabled(),
      mockMode: process.env.CLASSLINK_MOCK?.trim().toLowerCase() === "true",
      integrations: integrations.map((row) => ({
        ...row,
        syncButtonLabel: `Sync ${shortSyncSchoolLabel(row.schoolName)}`,
      })),
    });
  },
);

/** POST /sis-sync/run — manual roster sync for the active school. */
router.post("/sis-sync/run", requireSisSyncAdmin(), async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;

  if (process.env.CLASSLINK_MOCK?.trim().toLowerCase() === "true") {
    await ensureParrottClasslinkIntegration();
  }

  const integrationIdRaw = req.body?.integrationId;
  if (integrationIdRaw != null) {
    const integrationId = Number(integrationIdRaw);
    if (!Number.isFinite(integrationId) || integrationId <= 0) {
      res.status(400).json({ error: "Invalid integrationId" });
      return;
    }
    const actor = (req as Request & { staff: StaffRow }).staff;
    const result = await runSisSyncForIntegration(integrationId);
    if (
      result.schoolId !== schoolId &&
      !actor.isSuperUser &&
      !actor.isDistrictAdmin
    ) {
      res.status(403).json({ error: "Integration is not for your active school." });
      return;
    }
    res.status(result.ok ? 200 : 500).json(result);
    return;
  }

  const result = await runSisSyncForSchool(schoolId);
  if (!result) {
    res.status(404).json({
      error:
        "No SIS integration configured for this school. Add a district_integrations row with sis_provider=classlink.",
    });
    return;
  }

  res.status(result.ok ? 200 : 500).json(result);
});

/**
 * POST /sis-sync/run/:integrationId — sync one school's ClassLink integration
 * (district console; does not require session school to match).
 */
router.post(
  "/sis-sync/run/:integrationId",
  requireDistrictSisSyncAdmin(),
  async (req, res) => {
    const integrationId = Number(req.params.integrationId);
    if (!Number.isFinite(integrationId) || integrationId <= 0) {
      res.status(400).json({ error: "Invalid integrationId" });
      return;
    }
    if (process.env.CLASSLINK_MOCK?.trim().toLowerCase() === "true") {
      await ensureParrottClasslinkIntegration();
    }
    const result = await runSisSyncForIntegration(integrationId);
    res.status(result.ok ? 200 : 500).json(result);
  },
);

/**
 * POST /sis-sync/run-all — sync every ClassLink integration (same loop as cron).
 */
router.post(
  "/sis-sync/run-all",
  requireDistrictSisSyncAdmin(),
  async (_req, res) => {
    if (process.env.CLASSLINK_MOCK?.trim().toLowerCase() === "true") {
      await ensureParrottClasslinkIntegration();
    }
    const results = await runScheduledSisRosterSyncs();
    const okCount = results.filter((r) => r.ok).length;
    res.json({
      ok: okCount === results.length,
      message: `Synced ${okCount} of ${results.length} school(s).`,
      results,
    });
  },
);

/**
 * GET /sis-sync/discover-schools — read-only diff of the live ClassLink org
 * feed against Pulse: which school orgs exist in ClassLink but have no Pulse
 * school/integration yet. The dry-run half of button-driven onboarding.
 */
router.get(
  "/sis-sync/discover-schools",
  requireDistrictSisSyncAdmin(),
  async (_req, res) => {
    try {
      const result = await discoverNewClasslinkSchools();
      res.json(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err }, "ClassLink school discovery failed");
      res
        .status(502)
        .json({ error: `Could not read the ClassLink org feed: ${msg}` });
    }
  },
);

/**
 * POST /sis-sync/onboard-schools — create school + integration rows for an
 * explicit selection of newly discovered orgs. Body: { sourcedIds: string[] }.
 * Only sourcedIds are trusted from the client; names/codes are re-read from
 * the feed. New schools land in the ACTOR'S district. Data arrives via the
 * school's own Sync button afterwards (kept out of this request on purpose —
 * inline multi-school syncs are what caused the run-all gateway timeouts).
 */
router.post(
  "/sis-sync/onboard-schools",
  requireDistrictSisSyncAdmin(),
  async (req, res) => {
    const actor = (req as Request & { staff: StaffRow }).staff;
    const raw = (req.body ?? {}) as { sourcedIds?: unknown };
    const sourcedIds = Array.isArray(raw.sourcedIds)
      ? raw.sourcedIds.filter(
          (s): s is string => typeof s === "string" && s.trim().length > 0,
        )
      : [];
    if (sourcedIds.length === 0) {
      res.status(400).json({ error: "sourcedIds must be a non-empty array." });
      return;
    }
    if (sourcedIds.length > 50) {
      res.status(400).json({ error: "Too many schools in one request (max 50)." });
      return;
    }

    const districtId = await getDistrictIdForSchool(actor.schoolId);
    if (districtId === null) {
      res
        .status(409)
        .json({ error: "Your account's school is not linked to a district." });
      return;
    }

    try {
      const result = await onboardClasslinkSchools({ sourcedIds, districtId });
      for (const o of result.onboarded) {
        await writeAuthAudit({
          action: "sis_school_onboarded",
          schoolId: o.schoolId,
          actorStaffId: actor.id,
          actorName: actor.displayName,
          ip: clientIp(req),
          payload: {
            schoolName: o.name,
            stateSchoolCode: o.stateCode,
            classlinkOrgSourcedId: o.sourcedId,
            integrationId: o.integrationId,
          },
        });
      }
      const added = result.onboarded.length;
      const rejectedNote =
        result.rejected.length > 0
          ? ` ${result.rejected.length} selection(s) skipped: ${result.rejected
              .map((r) => r.reason)
              .join(" · ")}`
          : "";
      res.json({
        ...result,
        message:
          added > 0
            ? `Added ${added} school(s). Use each school's Sync button to pull rosters.${rejectedNote}`
            : `No schools were added.${rejectedNote}`,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err }, "ClassLink school onboarding failed");
      res.status(500).json({ error: `School onboarding failed: ${msg}` });
    }
  },
);

/**
 * POST /sis-sync/invite-passwords
 * Body: { schoolId?: number, integrationId?: number, staffIds?: number[], onlyNeedingPassword?: boolean }
 * Creates set-password tokens; emails when EMAIL_ENABLED; always returns copy links.
 */
router.post(
  "/sis-sync/invite-passwords",
  requireDistrictSisSyncAdmin(),
  async (req, res) => {
    const body = (req.body ?? {}) as {
      schoolId?: unknown;
      integrationId?: unknown;
      staffIds?: unknown;
      onlyNeedingPassword?: unknown;
    };

    let schoolId: number | null = null;
    if (body.integrationId != null) {
      const integrationId = Number(body.integrationId);
      if (!Number.isFinite(integrationId) || integrationId <= 0) {
        res.status(400).json({ error: "Invalid integrationId" });
        return;
      }
      const dash = await getSisDistrictDashboard();
      const row = dash.find((d) => d.id === integrationId);
      if (!row?.resolvedSchoolId) {
        res.status(404).json({
          error: "Integration not found or school not mapped.",
        });
        return;
      }
      schoolId = row.resolvedSchoolId;
    } else if (body.schoolId != null) {
      schoolId = Number(body.schoolId);
      if (!Number.isFinite(schoolId) || schoolId <= 0) {
        res.status(400).json({ error: "Invalid schoolId" });
        return;
      }
    } else {
      res.status(400).json({ error: "schoolId or integrationId is required" });
      return;
    }

    const onlyNeeding =
      body.onlyNeedingPassword === undefined
        ? true
        : Boolean(body.onlyNeedingPassword);

    let staffIds: number[] | null = null;
    if (Array.isArray(body.staffIds)) {
      staffIds = body.staffIds
        .map((x) => Number(x))
        .filter((n) => Number.isFinite(n) && n > 0);
    }

    const conditions = [
      eq(staffTable.schoolId, schoolId),
      eq(staffTable.active, true),
    ];
    if (staffIds && staffIds.length > 0) {
      conditions.push(inArray(staffTable.id, staffIds));
    } else if (onlyNeeding) {
      conditions.push(eq(staffTable.mustSetPassword, true));
    }

    const targets = await db
      .select({
        id: staffTable.id,
        email: staffTable.email,
        displayName: staffTable.displayName,
        mustSetPassword: staffTable.mustSetPassword,
        active: staffTable.active,
      })
      .from(staffTable)
      .where(and(...conditions));

    if (targets.length === 0) {
      res.json({
        schoolId,
        emailEnabled: isEmailGloballyEnabled(),
        invited: 0,
        emailSent: 0,
        invites: [],
        message: onlyNeeding
          ? "No staff needing a password invite for this school."
          : "No active staff matched.",
      });
      return;
    }

    // Cap bulk invites to keep response + email volume sane.
    const MAX = 100;
    const batch = targets.slice(0, MAX);
    const invites: InviteResult[] = [];
    for (const s of batch) {
      invites.push(
        await issueSetPasswordInvite({
          staff: s,
          requestIp: clientIp(req),
          userAgent: userAgent(req),
        }),
      );
    }

    const emailSent = invites.filter((i) => i.emailSent).length;
    res.json({
      schoolId,
      emailEnabled: isEmailGloballyEnabled(),
      invited: invites.length,
      emailSent,
      truncated: targets.length > MAX,
      invites,
      message: `Created ${invites.length} invite(s); emailed ${emailSent}. Copy links are always included for admin handoff.`,
    });
  },
);

export default router;
