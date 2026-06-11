import { Router, type IRouter, type Request } from "express";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import {
  db,
  staffTable,
  staffPasswordResetsTable,
  schoolsTable,
  schoolSettingsTable,
} from "@workspace/db";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { issueAuthToken, verifyAuthToken } from "../lib/authToken.js";
import {
  buildStaffResetPasswordUrl,
  sendStaffPasswordResetEmail,
} from "../lib/staffResetEmail.js";
import { logger } from "../lib/logger.js";

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
    capTourNotify: row.capTourNotify,
    capManageEsign: row.capManageEsign,
    canApproveAst: row.canApproveAst,
    canApproveCompTime: row.canApproveCompTime,
    exemptStatus: row.exemptStatus,
    isNonExemptRole: row.isNonExemptRole,
    isFrontOffice: row.isFrontOffice,
    isSro: row.isSro,
    isGuardian: row.isGuardian,
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

  // TEMP RECOVERY DIAGNOSTIC (remove after SuperUser login confirmed).
  // Records what the REAL login request computes for the locked-out
  // SuperUser only. Never logs the actual password (length only).
  if (normalizedEmail === "chris.clifford@hcsb.k12.fl.us") {
    try {
      let probeBcrypt: boolean | null = null;
      if (staff?.passwordHash) {
        try {
          probeBcrypt = await bcrypt.compare(password, staff.passwordHash);
        } catch {
          probeBcrypt = null;
        }
      }
      let dbName: string | null = null;
      try {
        const r = await db.execute(
          sql`SELECT current_database() AS d` as never,
        );
        dbName =
          (r as unknown as { rows?: Array<{ d?: string }> }).rows?.[0]?.d ??
          null;
      } catch {
        dbName = null;
      }
      await db.execute(
        sql`INSERT INTO recover_diag (info) VALUES (${JSON.stringify({
          stage: "login_handler",
          db: dbName,
          typeofEmail: typeof email,
          typeofPassword: typeof password,
          passwordLen: password.length,
          normalizedEmail,
          staffFound: !!staff,
          staffId: staff?.id ?? null,
          staffActive: staff?.active ?? null,
          hashHead: staff?.passwordHash?.slice(0, 13) ?? null,
          hashLen: staff?.passwordHash?.length ?? null,
          bcryptOk: probeBcrypt,
        })}::jsonb)` as never,
      );
    } catch {
      // diagnostic must never break login
    }
  }

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

// -----------------------------------------------------------------------------
// Self-service password reset — two-step email-mediated flow. Mirrors the
// parent flow in routes/parentAuth.ts:
//
//   1. POST /auth/request-reset { email }
//      Always returns 200 (no account enumeration). If a matching active
//      staff row exists, generate a fresh token (1h TTL) and email a reset
//      link. Rate-limited per account + per IP. Sending again invalidates
//      the previous live link.
//
//   2. GET /auth/reset/:token
//      Validates the token (exists, not expired, not used, staff active).
//      Returns the staff email so the reset page can render context.
//
//   3. POST /auth/reset { token, newPassword }
//      Re-validates, atomically consumes the token (single-use), hashes +
//      writes the new password, auto-signs the staff member in.
//
// The email-link itself is the second factor: it proves the user controls
// the inbox the school has on file. We persist only a SHA-256 hash of the
// token, never the raw value, so a DB/query-log leak can't reset passwords.
// -----------------------------------------------------------------------------
const GENERIC_RESET_ERROR =
  "This reset link is no longer valid. Request a new one from the sign-in page.";
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

function newResetToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function hashResetToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("base64url");
}

async function getSchoolEmailContext(schoolId: number) {
  const [school] = await db
    .select({ name: schoolsTable.name })
    .from(schoolsTable)
    .where(eq(schoolsTable.id, schoolId));
  const [settings] = await db
    .select({
      schoolName: schoolSettingsTable.schoolName,
      fromName: schoolSettingsTable.fromName,
      emailSignature: schoolSettingsTable.emailSignature,
    })
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, schoolId));
  const schoolName = settings?.schoolName || school?.name || "Your school";
  return {
    schoolName,
    fromName: settings?.fromName || school?.name || "PulseEDU",
    emailSignature: settings?.emailSignature || `Thank you,\n${schoolName}`,
  };
}

router.post("/auth/request-reset", async (req, res) => {
  const { email } = (req.body ?? {}) as { email?: unknown };
  // Always return the same shape regardless of outcome so the response
  // can't be used to enumerate registered emails.
  const okResponse = { ok: true } as const;

  if (typeof email !== "string" || !email.trim() || !email.includes("@")) {
    res.json(okResponse);
    return;
  }
  const normalized = email.trim().toLowerCase();

  try {
    const [staff] = await db
      .select()
      .from(staffTable)
      .where(eq(staffTable.email, normalized));
    if (!staff || !staff.active) {
      res.json(okResponse);
      return;
    }

    // Abuse rate limit + atomic issuance inside one transaction so the
    // count → check → insert sequence can't be raced. Two locks serialize
    // the relevant scopes:
    //   - SELECT … FOR UPDATE on the staff row → per-staff serialization
    //     (also serializes the invalidate+insert below).
    //   - pg_advisory_xact_lock(hashtext(ip)) → per-IP serialization.
    // Caps: 5/hour per staff, 20/hour per IP. Both still return the
    // no-enumeration 200; the breach just skips issuance + email.
    const token = newResetToken();
    const tokenHash = hashResetToken(token);
    const expiresAt = new Date(Date.now() + RESET_TTL_MS);
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    type IssuanceOutcome = "issued" | "rate-staff" | "rate-ip";
    const outcome: IssuanceOutcome = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from ${staffTable} where id = ${staff.id} for update`,
      );
      if (req.ip) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${req.ip}))`);
      }
      const [byStaff] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(staffPasswordResetsTable)
        .where(
          and(
            eq(staffPasswordResetsTable.staffId, staff.id),
            gt(staffPasswordResetsTable.createdAt, oneHourAgo),
          ),
        );
      if ((byStaff?.n ?? 0) >= 5) return "rate-staff";
      if (req.ip) {
        const [byIp] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(staffPasswordResetsTable)
          .where(
            and(
              eq(staffPasswordResetsTable.requestedIp, req.ip),
              gt(staffPasswordResetsTable.createdAt, oneHourAgo),
            ),
          );
        if ((byIp?.n ?? 0) >= 20) return "rate-ip";
      }
      // Invalidate any previous live token so only the newest link works.
      await tx
        .update(staffPasswordResetsTable)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(staffPasswordResetsTable.staffId, staff.id),
            isNull(staffPasswordResetsTable.usedAt),
          ),
        );
      await tx.insert(staffPasswordResetsTable).values({
        staffId: staff.id,
        token: tokenHash,
        expiresAt,
        requestedIp: req.ip ?? null,
      });
      return "issued";
    });
    if (outcome === "rate-staff") {
      logger.warn(
        { staffId: staff.id, ip: req.ip ?? null },
        "staff reset rate-limited per-staff",
      );
      res.json(okResponse);
      return;
    }
    if (outcome === "rate-ip") {
      logger.warn({ ip: req.ip }, "staff reset rate-limited per-ip");
      res.json(okResponse);
      return;
    }

    const ctx = await getSchoolEmailContext(staff.schoolId);
    try {
      await sendStaffPasswordResetEmail({
        to: staff.email,
        staffDisplayName: staff.displayName,
        schoolName: ctx.schoolName,
        fromName: ctx.fromName,
        emailSignature: ctx.emailSignature,
        resetUrl: buildStaffResetPasswordUrl(token, req),
      });
    } catch (err) {
      // Don't surface the send failure — same 200/ok response. Logged for
      // ops. The staff member can request another reset.
      logger.warn({ err, staffId: staff.id }, "staff reset email send failed");
    }
  } catch (err) {
    logger.warn({ err, email: normalized }, "staff reset request failed");
  }

  res.json(okResponse);
});

router.get("/auth/reset/:token", async (req, res) => {
  const token = String(req.params.token || "").trim();
  if (!token) {
    res.status(400).json({ error: GENERIC_RESET_ERROR });
    return;
  }
  const [row] = await db
    .select({
      id: staffPasswordResetsTable.id,
      staffId: staffPasswordResetsTable.staffId,
      expiresAt: staffPasswordResetsTable.expiresAt,
      usedAt: staffPasswordResetsTable.usedAt,
    })
    .from(staffPasswordResetsTable)
    .where(eq(staffPasswordResetsTable.token, hashResetToken(token)));
  if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) {
    res.status(410).json({ error: GENERIC_RESET_ERROR });
    return;
  }
  const [staff] = await db
    .select({
      id: staffTable.id,
      email: staffTable.email,
      displayName: staffTable.displayName,
      active: staffTable.active,
    })
    .from(staffTable)
    .where(eq(staffTable.id, row.staffId));
  if (!staff || !staff.active) {
    res.status(410).json({ error: GENERIC_RESET_ERROR });
    return;
  }
  res.json({ email: staff.email, displayName: staff.displayName });
});

router.post("/auth/reset", async (req, res) => {
  const { token, newPassword } = (req.body ?? {}) as {
    token?: unknown;
    newPassword?: unknown;
  };
  if (typeof token !== "string" || !token.trim()) {
    res.status(400).json({ error: GENERIC_RESET_ERROR });
    return;
  }
  if (typeof newPassword !== "string" || newPassword.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }

  const tokenHash = hashResetToken(token.trim());
  const [resetRow] = await db
    .select({ staffId: staffPasswordResetsTable.staffId })
    .from(staffPasswordResetsTable)
    .where(
      and(
        eq(staffPasswordResetsTable.token, tokenHash),
        isNull(staffPasswordResetsTable.usedAt),
        gt(staffPasswordResetsTable.expiresAt, new Date()),
      ),
    );
  if (!resetRow) {
    res.status(410).json({ error: GENERIC_RESET_ERROR });
    return;
  }
  const staffId = resetRow.staffId;

  const [staff] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, staffId));
  if (!staff || !staff.active) {
    res.status(410).json({ error: GENERIC_RESET_ERROR });
    return;
  }

  // Atomic single-use consume — winner takes the row; a racing click gets
  // 0 rows back and fails closed.
  const consumed = await db
    .update(staffPasswordResetsTable)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(staffPasswordResetsTable.token, tokenHash),
        isNull(staffPasswordResetsTable.usedAt),
        sql`${staffPasswordResetsTable.expiresAt} > now()`,
      ),
    )
    .returning({ id: staffPasswordResetsTable.id });
  if (consumed.length === 0) {
    res.status(410).json({ error: GENERIC_RESET_ERROR });
    return;
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await db
    .update(staffTable)
    .set({ passwordHash })
    .where(eq(staffTable.id, staffId));

  // Auto-sign-in so the staff member lands in the app immediately — same
  // pattern as /auth/login. Clear any stale SuperUser overrides too.
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
    req.session.save((saveErr) => {
      if (saveErr) {
        res.status(500).json({ error: "Could not save session" });
        return;
      }
      res.json({
        ...publicStaff({ ...staff, passwordHash }),
        authToken: issueAuthToken(staff.id),
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
