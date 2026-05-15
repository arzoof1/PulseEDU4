import { Router, type IRouter, type Request } from "express";
import bcrypt from "bcryptjs";
import { db, staffTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { issueAuthToken, verifyAuthToken } from "../lib/authToken.js";

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
    capCarRiderMonitor: row.capCarRiderMonitor,
    capManageDismissal: row.capManageDismissal,
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

  const [staff] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.email, normalizedEmail));

  if (!staff || !staff.active) {
    res.status(401).json({ error: GENERIC_LOGIN_ERROR });
    return;
  }

  const ok = await bcrypt.compare(password, staff.passwordHash);
  if (!ok) {
    res.status(401).json({ error: GENERIC_LOGIN_ERROR });
    return;
  }

  // Safety net: clear any stale SuperUser "act as another school" override on
  // every fresh login. Without this, an expired session/token in the middle
  // of a switch can leave a SuperUser stranded acting-as another school with
  // no way to call /tenancy/switch-school. A re-login always lands at home.
  if (staff.activeSchoolOverride !== null) {
    await db
      .update(staffTable)
      .set({ activeSchoolOverride: null })
      .where(eq(staffTable.id, staff.id));
    staff.activeSchoolOverride = null;
  }
  // Same safety net for the "Preview as another staff" pointer. A fresh
  // login always lands on the real account; impersonation should never
  // silently carry over from a previous session/device, mirroring the
  // session-scoped semantics the previous design had.
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
    req.session.save((saveErr) => {
      if (saveErr) {
        res.status(500).json({ error: "Could not save session" });
        return;
      }
      res.json({
        ...publicStaff(staff),
        // Signed bearer token used as a fallback when the browser blocks
        // the session cookie (e.g. inside the Replit preview iframe).
        authToken: issueAuthToken(staff.id),
      });
    });
  });
});

router.post("/auth/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      res.status(500).json({ error: "Could not log out" });
      return;
    }
    res.clearCookie("pulseed.sid");
    res.status(204).end();
  });
});

// Change the caller's own password. Requires current password to prove it's
// really them (so a stolen session/bearer token can't silently reset it).
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
  // If the global middleware swapped this request to a "Preview as X"
  // identity (see /admin/staff-preview), it stamped req.impersonatorStaffId
  // and req.impersonatorDisplayName from the staff row's preview pointer.
  // Surface those so the client can render a "Previewing as X — return
  // to my account" banner.
  // CRITICAL: when previewing, the bearer token we mint here MUST be for
  // the impersonator (the real signed-in user), NOT for the swapped target
  // identity in `staff`. The client's authFetch silently rotates its
  // stored bearer from any response carrying a fresh `authToken`, so
  // issuing `staff.id` (= target) during preview would permanently bind
  // the client's bearer to the previewed user. Then "Exit preview" would
  // appear to succeed (the server-side preview pointer would clear) but
  // the very next /auth/me request, authenticated by the now-target's
  // bearer, would resolve directly to the target with no impersonation —
  // stranding the user inside the previewed account. Always re-anchor the
  // token to the impersonator's row when one is present.
  const tokenSubject = req.impersonatorStaffId ?? staff.id;
  res.json({
    ...publicStaff(staff),
    authToken: issueAuthToken(tokenSubject),
    activeSchoolId: req.schoolId ?? staff.schoolId,
    homeSchoolId: req.homeSchoolId ?? staff.schoolId,
    isSchoolSwitched: !!req.isSchoolSwitched,
    impersonatorStaffId: req.impersonatorStaffId ?? null,
    impersonatorDisplayName: req.impersonatorDisplayName ?? null,
  });
});

export default router;
