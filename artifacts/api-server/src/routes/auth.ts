import { Router, type IRouter, type Request } from "express";
import { db, pool, staffPasswordResetsTable, staffTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  bumpStaffAuthTokenVersion,
  issueStaffAuthTokenIfEnabled,
} from "../lib/staffBearerAuth.js";
import { ensureCsrfToken } from "../lib/csrf.js";
import {
  checkLoginAllowed,
  recordLoginFailure,
  recordLoginSuccess,
  sendLoginRateLimited,
} from "../lib/loginThrottle.js";
import {
  buildStaffPasswordResetUrl,
  sendStaffPasswordResetEmail,
} from "../lib/staffPasswordResetEmail.js";
import {
  hashStaffPasswordResetToken,
  issueStaffPasswordResetToken,
  staffPasswordResetExpiresAt,
  verifyStaffPasswordResetToken,
} from "../lib/staffPasswordResetToken.js";
import { logger } from "../lib/logger.js";
import { bcryptCompare, bcryptHash } from "../lib/bcrypt.js";

declare module "express-session" {
  interface SessionData {
    staffId?: number;
  }
}

const router: IRouter = Router();

const GENERIC_LOGIN_ERROR = "Invalid email or password";
const PASSWORD_POLICY_ERROR =
  "newPassword must be at least 8 characters and include uppercase, lowercase, number, and special character";
const FORGOT_PASSWORD_RESPONSE =
  "If an active staff account exists for that email, a password reset link has been sent.";
const RESET_LINK_EXPIRES_MINUTES = 30;

let passwordResetTableReady: Promise<void> | null = null;

function meetsStaffPasswordPolicy(password: string): boolean {
  return (
    password.length >= 8 &&
    /[A-Z]/.test(password) &&
    /[a-z]/.test(password) &&
    /\d/.test(password) &&
    /[^A-Za-z0-9]/.test(password)
  );
}

function clientIp(req: Request): string {
  return req.ip?.trim() || "unknown";
}

function userAgent(req: Request): string | null {
  const value = req.get("user-agent");
  return value && value.length > 0 ? value.slice(0, 500) : null;
}

function ensureStaffPasswordResetTable(): Promise<void> {
  if (!passwordResetTableReady) {
    passwordResetTableReady = pool
      .query(`
        CREATE TABLE IF NOT EXISTS staff_password_resets (
          id serial PRIMARY KEY,
          staff_id integer,
          email text NOT NULL,
          token_hash text UNIQUE,
          status text NOT NULL DEFAULT 'requested',
          requested_at timestamptz NOT NULL DEFAULT now(),
          expires_at timestamptz,
          used_at timestamptz,
          request_ip text,
          used_ip text,
          user_agent text,
          email_sent_at timestamptz,
          email_error text
        );
        CREATE INDEX IF NOT EXISTS staff_password_resets_staff_idx ON staff_password_resets(staff_id);
        CREATE INDEX IF NOT EXISTS staff_password_resets_email_idx ON staff_password_resets(email);
        CREATE INDEX IF NOT EXISTS staff_password_resets_expires_idx ON staff_password_resets(expires_at);
      `)
      .then(() => undefined)
      .catch((err: unknown) => {
        passwordResetTableReady = null;
        throw err;
      });
  }
  const ready = passwordResetTableReady;
  if (!ready) {
    throw new Error("staff password reset table initialization failed");
  }
  return ready;
}

function publicStaff(row: typeof staffTable.$inferSelect) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    schoolId: row.schoolId,
    isSuperUser: row.isSuperUser,
    isDistrictAdmin: row.isDistrictAdmin,
    isAdmin: row.isAdmin,
    isEseCoordinator: row.isEseCoordinator,
    isPbisCoordinator: row.isPbisCoordinator,
    isBehaviorSpecialist: row.isBehaviorSpecialist,
    isIssTeacher: row.isIssTeacher,
    isDean: row.isDean,
    isMtssCoordinator: row.isMtssCoordinator,
    isCounselor: row.isCounselor,
    isSocialWorker: row.isSocialWorker,
    isSchoolPsychologist: row.isSchoolPsychologist,
    isGuidanceCounselor: row.isGuidanceCounselor,
    isAthleticDirector: row.isAthleticDirector,
    capStaffRoles: row.capStaffRoles,
    capManageRoles: row.capManageRoles,
    capManageDisplays: row.capManageDisplays,
    capCarRiderMonitor: row.capCarRiderMonitor,
    capManageDismissal: row.capManageDismissal,
    capTourNotify: row.capTourNotify,
    capTourGuide: row.capTourGuide,
    capManageEsign: row.capManageEsign,
    capManageContactInfo: row.capManageContactInfo,
    capImportGrades: row.capImportGrades,
    capImportAttendance: row.capImportAttendance,
    capImportFast: row.capImportFast,
    capImportIready: row.capImportIready,
    capViewFastHistory: row.capViewFastHistory,
    canApproveAst: row.canApproveAst,
    canApproveCompTime: row.canApproveCompTime,
    exemptStatus: row.exemptStatus,
    isNonExemptRole: row.isNonExemptRole,
    isFrontOffice: row.isFrontOffice,
    isSro: row.isSro,
    isGuardian: row.isGuardian,
    isCoreTeam: row.isCoreTeam,
    isConfidentialSecretary: row.isConfidentialSecretary,
    defaultRoom: row.defaultRoom,
    // Per-teacher opt-in: the Classroom Store is hidden by default and a
    // teacher reveals it from a toggle. Stored in ui_prefs (no migration);
    // surfaced here so the client can gate the nav item + hub view in one
    // place off authUser without a second fetch.
    classroomStoreEnabled: !!(
      row.uiPrefs &&
      typeof row.uiPrefs === "object" &&
      (row.uiPrefs as Record<string, unknown>).classroomStoreEnabled === true
    ),
  };
}

router.post("/auth/forgot-password", async (req: Request, res) => {
  const { email } = (req.body ?? {}) as { email?: unknown };
  if (typeof email !== "string" || !email.trim() || !email.includes("@")) {
    res.status(400).json({ error: "email is required" });
    return;
  }

  await ensureStaffPasswordResetTable();
  const normalizedEmail = email.trim().toLowerCase();
  const [staff] = await db
    .select({
      id: staffTable.id,
      email: staffTable.email,
      displayName: staffTable.displayName,
      active: staffTable.active,
    })
    .from(staffTable)
    .where(eq(staffTable.email, normalizedEmail));

  if (!staff || !staff.active) {
    await db.insert(staffPasswordResetsTable).values({
      email: normalizedEmail,
      status: "no_active_account",
      requestIp: clientIp(req),
      userAgent: userAgent(req),
    });
    res.json({ message: FORGOT_PASSWORD_RESPONSE });
    return;
  }

  const expiresAt = staffPasswordResetExpiresAt();
  const [resetRow] = await db
    .insert(staffPasswordResetsTable)
    .values({
      staffId: staff.id,
      email: normalizedEmail,
      status: "requested",
      expiresAt,
      requestIp: clientIp(req),
      userAgent: userAgent(req),
    })
    .returning({ id: staffPasswordResetsTable.id });

  const resetId = resetRow.id;
  const token = issueStaffPasswordResetToken({
    resetId,
    staffId: staff.id,
    expiresAt,
  });
  const tokenHash = hashStaffPasswordResetToken(token);
  await db
    .update(staffPasswordResetsTable)
    .set({ tokenHash })
    .where(eq(staffPasswordResetsTable.id, resetId));

  const resetUrl = buildStaffPasswordResetUrl(token);
  try {
    await sendStaffPasswordResetEmail({
      to: staff.email,
      displayName: staff.displayName,
      resetUrl,
      expiresMinutes: RESET_LINK_EXPIRES_MINUTES,
    });
    await db
      .update(staffPasswordResetsTable)
      .set({ status: "email_sent", emailSentAt: new Date() })
      .where(eq(staffPasswordResetsTable.id, resetId));
  } catch (err) {
    logger.warn({ err, staffId: staff.id }, "staff password reset email failed");
    await db
      .update(staffPasswordResetsTable)
      .set({
        status: "email_failed",
        emailError: err instanceof Error ? err.message : String(err),
      })
      .where(eq(staffPasswordResetsTable.id, resetId));
  }

  res.json({ message: FORGOT_PASSWORD_RESPONSE });
});

router.post("/auth/reset-password", async (req: Request, res) => {
  const { token, newPassword } = (req.body ?? {}) as {
    token?: unknown;
    newPassword?: unknown;
  };
  if (typeof token !== "string" || !token) {
    res.status(400).json({ error: "Reset link is invalid or expired." });
    return;
  }
  if (typeof newPassword !== "string" || !meetsStaffPasswordPolicy(newPassword)) {
    res.status(400).json({ error: PASSWORD_POLICY_ERROR });
    return;
  }

  const parsed = verifyStaffPasswordResetToken(token);
  if (!parsed) {
    res.status(400).json({ error: "Reset link is invalid or expired." });
    return;
  }

  await ensureStaffPasswordResetTable();
  const tokenHash = hashStaffPasswordResetToken(token);
  const [resetRow] = await db
    .select()
    .from(staffPasswordResetsTable)
    .where(
      and(
        eq(staffPasswordResetsTable.id, parsed.resetId),
        eq(staffPasswordResetsTable.staffId, parsed.staffId),
        eq(staffPasswordResetsTable.tokenHash, tokenHash),
      ),
    );

  if (!resetRow || resetRow.usedAt || !resetRow.expiresAt) {
    res.status(400).json({ error: "Reset link is invalid or expired." });
    return;
  }
  if (resetRow.expiresAt.getTime() < Date.now()) {
    await db
      .update(staffPasswordResetsTable)
      .set({ status: "expired" })
      .where(eq(staffPasswordResetsTable.id, resetRow.id));
    res.status(400).json({ error: "Reset link is invalid or expired." });
    return;
  }

  const [staff] = await db
    .select({ id: staffTable.id, active: staffTable.active })
    .from(staffTable)
    .where(eq(staffTable.id, parsed.staffId));
  if (!staff || !staff.active) {
    await db
      .update(staffPasswordResetsTable)
      .set({ status: "inactive_account" })
      .where(eq(staffPasswordResetsTable.id, resetRow.id));
    res.status(400).json({ error: "Reset link is invalid or expired." });
    return;
  }

  const passwordHash = await bcryptHash(newPassword, 10);
  await db
    .update(staffTable)
    .set({ passwordHash })
    .where(eq(staffTable.id, staff.id));

  await bumpStaffAuthTokenVersion(staff.id);
  await db
    .update(staffPasswordResetsTable)
    .set({ status: "used", usedAt: new Date(), usedIp: clientIp(req) })
    .where(eq(staffPasswordResetsTable.id, resetRow.id));

  res.json({ ok: true });
});

router.post("/auth/login", async (req: Request, res) => {
  const { email, password } = req.body ?? {};

  if (
    typeof email !== "string" ||
    typeof password !== "string" ||
    !email.trim() ||
    !password
  ) {
    res.status(400).json({ error: "email and password are required" });
    return;
  }

  const normalizedEmail = email.trim().toLowerCase();

  const blocked = await checkLoginAllowed(req, "staff", normalizedEmail);
  if (blocked) {
    sendLoginRateLimited(res, blocked);
    return;
  }

  const [staff] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.email, normalizedEmail));

  if (!staff || !staff.active) {
    await recordLoginFailure(req, "staff", normalizedEmail);
    res.status(401).json({ error: GENERIC_LOGIN_ERROR });
    return;
  }

  const ok = await bcryptCompare(password, staff.passwordHash);
  if (!ok) {
    await recordLoginFailure(req, "staff", normalizedEmail);
    res.status(401).json({ error: GENERIC_LOGIN_ERROR });
    return;
  }

  await recordLoginSuccess(req, "staff", normalizedEmail);

  if (staff.activeSchoolOverride !== null) {
    await db
      .update(staffTable)
      .set({ activeSchoolOverride: null })
      .where(eq(staffTable.id, staff.id));
    staff.activeSchoolOverride = null;
  }
  if (staff.previewTargetStaffId !== null) {
    await db
      .update(staffTable)
      .set({ previewTargetStaffId: null })
      .where(eq(staffTable.id, staff.id));
    staff.previewTargetStaffId = null;
  }

  req.session.regenerate((err) => {
    if (err) {
      res.status(500).json({ error: "Could not start session" });
      return;
    }
    req.session.staffId = staff.id;
    const csrfToken = ensureCsrfToken(req.session);
    req.session.save(async (saveErr) => {
      if (saveErr) {
        res.status(500).json({ error: "Could not save session" });
        return;
      }
      const authToken = await issueStaffAuthTokenIfEnabled(staff.id);
      res.json({
        ...publicStaff(staff),
        csrfToken,
        ...(authToken ? { authToken } : {}),
      });
    });
  });
});

router.post("/auth/logout", async (req, res) => {
  const staffId = req.session.staffId ?? req.staffId ?? null;
  if (staffId) {
    await bumpStaffAuthTokenVersion(staffId);
  }

  req.session.destroy((err) => {
    if (err) {
      res.status(500).json({ error: "Could not log out" });
      return;
    }
    res.clearCookie("pulseed.sid");
    res.status(204).end();
  });
});

router.post("/auth/change-password", async (req: Request, res) => {
  const staffId = req.staffId ?? null;
  if (!staffId) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }

  const { currentPassword, newPassword } = (req.body ?? {}) as {
    currentPassword?: unknown;
    newPassword?: unknown;
  };
  if (
    typeof currentPassword !== "string" ||
    typeof newPassword !== "string" ||
    !currentPassword ||
    !meetsStaffPasswordPolicy(newPassword)
  ) {
    res.status(400).json({
      error: PASSWORD_POLICY_ERROR,
    });
    return;
  }

  const [staff] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, staffId));
  if (!staff || !staff.active) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }

  const ok = await bcryptCompare(currentPassword, staff.passwordHash);
  if (!ok) {
    res.status(401).json({ error: "Current password is incorrect" });
    return;
  }

  const passwordHash = await bcryptHash(newPassword, 10);
  await db
    .update(staffTable)
    .set({ passwordHash })
    .where(eq(staffTable.id, staffId));

  await bumpStaffAuthTokenVersion(staffId);

  res.json({ ok: true });
});

const STAFF_RESET_LINK_ERROR =
  "This reset link is no longer valid. Request a new one from the sign-in page.";

// Legacy route aliases for StaffForgotPassword / StaffResetPassword (Replit UI).
router.post("/auth/request-reset", async (req: Request, res) => {
  const { email } = (req.body ?? {}) as { email?: unknown };
  if (typeof email !== "string" || !email.trim() || !email.includes("@")) {
    res.json({ ok: true });
    return;
  }

  await ensureStaffPasswordResetTable();
  const normalizedEmail = email.trim().toLowerCase();
  const [staff] = await db
    .select({
      id: staffTable.id,
      email: staffTable.email,
      displayName: staffTable.displayName,
      active: staffTable.active,
    })
    .from(staffTable)
    .where(eq(staffTable.email, normalizedEmail));

  if (!staff || !staff.active) {
    res.json({ ok: true });
    return;
  }

  const expiresAt = staffPasswordResetExpiresAt();
  const [resetRow] = await db
    .insert(staffPasswordResetsTable)
    .values({
      staffId: staff.id,
      email: normalizedEmail,
      status: "requested",
      expiresAt,
      requestIp: clientIp(req),
      userAgent: userAgent(req),
    })
    .returning({ id: staffPasswordResetsTable.id });

  const resetId = resetRow.id;
  const token = issueStaffPasswordResetToken({
    resetId,
    staffId: staff.id,
    expiresAt,
  });
  const tokenHash = hashStaffPasswordResetToken(token);
  await db
    .update(staffPasswordResetsTable)
    .set({ tokenHash })
    .where(eq(staffPasswordResetsTable.id, resetId));

  try {
    await sendStaffPasswordResetEmail({
      to: staff.email,
      displayName: staff.displayName,
      resetUrl: buildStaffPasswordResetUrl(token),
      expiresMinutes: RESET_LINK_EXPIRES_MINUTES,
    });
    await db
      .update(staffPasswordResetsTable)
      .set({ status: "sent", emailSentAt: new Date() })
      .where(eq(staffPasswordResetsTable.id, resetId));
  } catch (err) {
    logger.warn({ err, staffId: staff.id }, "staff reset email send failed");
    await db
      .update(staffPasswordResetsTable)
      .set({
        status: "send_failed",
        emailError: err instanceof Error ? err.message : String(err),
      })
      .where(eq(staffPasswordResetsTable.id, resetId));
  }

  res.json({ ok: true });
});

router.get("/auth/reset/:token", async (req: Request, res) => {
  const token = String(req.params.token || "").trim();
  const parsed = verifyStaffPasswordResetToken(token);
  if (!parsed) {
    res.status(410).json({ error: STAFF_RESET_LINK_ERROR });
    return;
  }

  await ensureStaffPasswordResetTable();
  const tokenHash = hashStaffPasswordResetToken(token);
  const [resetRow] = await db
    .select()
    .from(staffPasswordResetsTable)
    .where(
      and(
        eq(staffPasswordResetsTable.id, parsed.resetId),
        eq(staffPasswordResetsTable.staffId, parsed.staffId),
        eq(staffPasswordResetsTable.tokenHash, tokenHash),
      ),
    );

  if (!resetRow || resetRow.usedAt || !resetRow.expiresAt) {
    res.status(410).json({ error: STAFF_RESET_LINK_ERROR });
    return;
  }
  if (resetRow.expiresAt.getTime() < Date.now()) {
    res.status(410).json({ error: STAFF_RESET_LINK_ERROR });
    return;
  }

  const [staff] = await db
    .select({
      email: staffTable.email,
      displayName: staffTable.displayName,
      active: staffTable.active,
    })
    .from(staffTable)
    .where(eq(staffTable.id, parsed.staffId));

  if (!staff || !staff.active) {
    res.status(410).json({ error: STAFF_RESET_LINK_ERROR });
    return;
  }

  res.json({ email: staff.email, displayName: staff.displayName });
});

router.post("/auth/reset", async (req: Request, res) => {
  const { token, newPassword } = (req.body ?? {}) as {
    token?: unknown;
    newPassword?: unknown;
  };
  if (typeof token !== "string" || !token.trim()) {
    res.status(400).json({ error: STAFF_RESET_LINK_ERROR });
    return;
  }
  if (typeof newPassword !== "string" || newPassword.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }

  const parsed = verifyStaffPasswordResetToken(token.trim());
  if (!parsed) {
    res.status(410).json({ error: STAFF_RESET_LINK_ERROR });
    return;
  }

  await ensureStaffPasswordResetTable();
  const tokenHash = hashStaffPasswordResetToken(token.trim());
  const [resetRow] = await db
    .select()
    .from(staffPasswordResetsTable)
    .where(
      and(
        eq(staffPasswordResetsTable.id, parsed.resetId),
        eq(staffPasswordResetsTable.staffId, parsed.staffId),
        eq(staffPasswordResetsTable.tokenHash, tokenHash),
      ),
    );

  if (!resetRow || resetRow.usedAt || !resetRow.expiresAt) {
    res.status(410).json({ error: STAFF_RESET_LINK_ERROR });
    return;
  }
  if (resetRow.expiresAt.getTime() < Date.now()) {
    res.status(410).json({ error: STAFF_RESET_LINK_ERROR });
    return;
  }

  const [staff] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, parsed.staffId));
  if (!staff || !staff.active) {
    res.status(410).json({ error: STAFF_RESET_LINK_ERROR });
    return;
  }

  const passwordHash = await bcryptHash(newPassword, 10);
  await db
    .update(staffTable)
    .set({ passwordHash })
    .where(eq(staffTable.id, staff.id));

  await bumpStaffAuthTokenVersion(staff.id);
  await db
    .update(staffPasswordResetsTable)
    .set({ status: "used", usedAt: new Date(), usedIp: clientIp(req) })
    .where(eq(staffPasswordResetsTable.id, resetRow.id));

  req.session.regenerate((err) => {
    if (err) {
      res.status(500).json({ error: "Could not start session" });
      return;
    }
    req.session.staffId = staff.id;
    delete req.session.parentId;
    delete req.session.activeSchoolId;
    const csrfToken = ensureCsrfToken(req.session);
    req.session.save(async (saveErr) => {
      if (saveErr) {
        res.status(500).json({ error: "Could not save session" });
        return;
      }
      const authToken = await issueStaffAuthTokenIfEnabled(staff.id);
      res.json({
        ...publicStaff({ ...staff, passwordHash }),
        csrfToken,
        ...(authToken ? { authToken } : {}),
      });
    });
  });
});

router.get("/auth/me", async (req, res) => {
  const staffId = req.staffId;
  if (!staffId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const [staff] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, staffId));
  if (!staff || !staff.active) {
    req.session.destroy(() => {
      res.status(401).json({ error: "Not authenticated" });
    });
    return;
  }

  const tokenSubject = req.impersonatorStaffId ?? staff.id;
  const authToken = await issueStaffAuthTokenIfEnabled(tokenSubject);

  const csrfToken = ensureCsrfToken(req.session);

  res.json({
    ...publicStaff(staff),
    csrfToken,
    ...(authToken ? { authToken } : {}),
    activeSchoolId: req.schoolId ?? staff.schoolId,
    homeSchoolId: req.homeSchoolId ?? staff.schoolId,
    isSchoolSwitched: !!req.isSchoolSwitched,
    impersonatorStaffId: req.impersonatorStaffId ?? null,
    impersonatorDisplayName: req.impersonatorDisplayName ?? null,
  });
});

export default router;
