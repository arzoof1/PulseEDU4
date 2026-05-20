import { Router, type IRouter, type Request } from "express";
import bcrypt from "bcryptjs";
import { db, staffTable } from "@workspace/db";
import { eq } from "drizzle-orm";
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

declare module "express-session" {
  interface SessionData {
    staffId?: number;
  }
}

const router: IRouter = Router();

const GENERIC_LOGIN_ERROR = "Invalid email or password";

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
    capStaffRoles: row.capStaffRoles,
    capManageRoles: row.capManageRoles,
    capManageDisplays: row.capManageDisplays,
    defaultRoom: row.defaultRoom,
  };
}

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

  const ok = await bcrypt.compare(password, staff.passwordHash);
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
    newPassword.length < 8
  ) {
    res.status(400).json({
      error: "currentPassword and newPassword (min 8 chars) are required",
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

  const ok = await bcrypt.compare(currentPassword, staff.passwordHash);
  if (!ok) {
    res.status(401).json({ error: "Current password is incorrect" });
    return;
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await db
    .update(staffTable)
    .set({ passwordHash })
    .where(eq(staffTable.id, staffId));

  await bumpStaffAuthTokenVersion(staffId);

  res.json({ ok: true });
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
