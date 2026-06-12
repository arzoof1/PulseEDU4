import { Router, type IRouter, type Request } from "express";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { genUrlSafeToken } from "../lib/urlSafeToken.js";
import {
  db,
  parentsTable,
  parentStudentsTable,
  parentInvitesTable,
  parentPasswordResetsTable,
  studentsTable,
  schoolsTable,
  schoolSettingsTable,
} from "@workspace/db";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { authenticator } from "otplib";
import { encryptSecret, decryptSecret } from "../lib/secretCrypto.js";

// otplib defaults to a 1-step window. Bump to allow ±1 step (≈±30s) of clock
// skew on the parent's phone — same tolerance every major site uses.
authenticator.options = { window: 1 };

const TOTP_ISSUER = "PulseEDU";

function buildOtpauthUri(email: string, secret: string): string {
  return authenticator.keyuri(email, TOTP_ISSUER, secret);
}

function isValidTotpCode(secret: string, code: unknown): boolean {
  if (typeof code !== "string") return false;
  const trimmed = code.trim().replace(/\s+/g, "");
  if (!/^\d{6}$/.test(trimmed)) return false;
  try {
    return authenticator.check(trimmed, secret);
  } catch {
    return false;
  }
}

// Wrapper that decrypts an at-rest stored secret before verifying. Stored
// secrets land via `encryptSecret(...)` in /totp/confirm; callers should
// pass `parent.totpSecret` straight in.
function verifyStoredTotp(storedSecret: string, code: unknown): boolean {
  try {
    return isValidTotpCode(decryptSecret(storedSecret), code);
  } catch {
    return false;
  }
}
import {
  buildResetPasswordUrl,
  sendParentPasswordResetEmail,
} from "../lib/parentResetEmail.js";
import { logger } from "../lib/logger.js";

// Feature-licensing backstop for the invite endpoints. The router-level
// `requireFeature("parentPortal")` middleware in routes/index.ts only
// covers staff-facing routes (it needs req.schoolId which parent
// sessions don't have). Invite acceptance is parent-side but resolves
// schoolId from the invite row itself, so we can enforce here directly.
// Returns true when the school's parentPortal license is on. We read
// superFeatureParentPortal — that's the runtime boolean plans + override
// reapply write through to.
async function isParentPortalLicensedForSchool(
  schoolId: number,
): Promise<boolean> {
  const [s] = await db
    .select({ on: schoolSettingsTable.superFeatureParentPortal })
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, schoolId))
    .limit(1);
  return Boolean(s?.on);
}
import {
  issueParentAuthToken,
  verifyParentAuthToken,
} from "../lib/authToken.js";
import { loadBrandingForSchool } from "./schoolBranding.js";

declare module "express-session" {
  interface SessionData {
    parentId?: number;
  }
}

const router: IRouter = Router();

const GENERIC_LOGIN_ERROR = "Invalid email or password";
const GENERIC_INVITE_ERROR =
  "This invite link is no longer valid. Ask your school to resend it.";

function publicParent(row: typeof parentsTable.$inferSelect) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    schoolId: row.schoolId,
    active: row.active,
    hasPassword: row.passwordHash !== null,
  };
}

// -----------------------------------------------------------------------------
// Resolve parent identity per request — runs as a router-level middleware so
// downstream routes can read req.parentId from EITHER the session cookie or
// the parent bearer token. Same pattern as the staff middleware in app.ts.
// -----------------------------------------------------------------------------
router.use(async (req, _res, next) => {
  let pid: number | null = req.session.parentId ?? null;
  if (!pid) {
    const auth = req.headers.authorization;
    if (typeof auth === "string" && auth.startsWith("Bearer ")) {
      pid = verifyParentAuthToken(auth.slice(7).trim());
    }
  }
  req.parentId = pid;
  next();
});

router.post("/parent-auth/login", async (req: Request, res) => {
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
  // Pull every parent row matching this email — there can be one per school
  // (rare, but possible if a family moves districts). Try them in turn so the
  // user doesn't have to know which school the row was created under.
  const candidates = await db
    .select()
    .from(parentsTable)
    .where(eq(parentsTable.email, normalizedEmail));

  for (const parent of candidates) {
    if (!parent.active || !parent.passwordHash) continue;
    const ok = await bcrypt.compare(password, parent.passwordHash);
    if (!ok) continue;

    // TOTP second factor — only enforced when the parent has opted in
    // (totpSecret is non-null). Returning a distinct shape lets the
    // client render a 6-digit code step instead of a generic error.
    if (parent.totpSecret) {
      const { code } = (req.body ?? {}) as { code?: unknown };
      if (typeof code !== "string" || !code.trim()) {
        res.status(401).json({
          requiresOtp: true,
          error: "Enter the 6-digit code from your authenticator app.",
        });
        return;
      }
      if (!verifyStoredTotp(parent.totpSecret, code)) {
        res.status(401).json({
          requiresOtp: true,
          error: "That 6-digit code didn't match. Try again.",
        });
        return;
      }
    }

    await db
      .update(parentsTable)
      .set({ lastLoginAt: new Date() })
      .where(eq(parentsTable.id, parent.id));

    req.session.regenerate((err) => {
      if (err) {
        res.status(500).json({ error: "Could not start session" });
        return;
      }
      req.session.parentId = parent.id;
      // Make sure we never carry over a staff session if someone weirdly
      // logged in twice in the same browser.
      delete req.session.staffId;
      delete req.session.activeSchoolId;
      req.session.save((saveErr) => {
        if (saveErr) {
          res.status(500).json({ error: "Could not save session" });
          return;
        }
        res.json({
          ...publicParent(parent),
          authToken: issueParentAuthToken(parent.id),
        });
      });
    });
    return;
  }

  res.status(401).json({ error: GENERIC_LOGIN_ERROR });
});

router.post("/parent-auth/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      res.status(500).json({ error: "Could not log out" });
      return;
    }
    res.clearCookie("pulseed.sid");
    res.status(204).end();
  });
});

router.get("/parent-auth/me", async (req, res) => {
  const pid = req.parentId;
  if (!pid) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const [parent] = await db
    .select()
    .from(parentsTable)
    .where(eq(parentsTable.id, pid));
  if (!parent || !parent.active) {
    req.session.destroy(() => {
      res.status(401).json({ error: "Not authenticated" });
    });
    return;
  }
  // Pull the linked students so the client knows immediately who the sibling
  // switcher should offer (and so the dashboard can land on a default kid).
  const links = await db
    .select({
      studentTableId: parentStudentsTable.studentId,
      studentRowId: studentsTable.id,
      studentId: studentsTable.studentId,
      localSisId: studentsTable.localSisId,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
      grade: studentsTable.grade,
    })
    .from(parentStudentsTable)
    .innerJoin(studentsTable, eq(parentStudentsTable.studentId, studentsTable.id))
    .where(eq(parentStudentsTable.parentId, pid));

  res.json({
    ...publicParent(parent),
    authToken: issueParentAuthToken(parent.id),
    students: links.map((s) => ({
      id: s.studentRowId,
      studentId: s.studentId,
      localSisId: s.localSisId ?? null,
      firstName: s.firstName,
      lastName: s.lastName,
      grade: s.grade,
    })),
  });
});

// -----------------------------------------------------------------------------
// Branding for the parent portal — resolves the school from the parent's first
// linked student so the HeartBEAT snapshot can be tinted in the school's
// colors. Returns the same shape as the staff /api/school-branding endpoint.
// -----------------------------------------------------------------------------
router.get("/parent-auth/branding", async (req, res) => {
  const pid = req.parentId;
  if (!pid) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const [link] = await db
    .select({ schoolId: studentsTable.schoolId })
    .from(parentStudentsTable)
    .innerJoin(
      studentsTable,
      eq(parentStudentsTable.studentId, studentsTable.id),
    )
    .where(eq(parentStudentsTable.parentId, pid))
    .limit(1);
  if (!link) {
    res.status(404).json({ error: "No linked students" });
    return;
  }
  res.json(await loadBrandingForSchool(link.schoolId));
});

// -----------------------------------------------------------------------------
// Look up an invite by token (used by the accept-invite page on first load to
// show the parent which student they're being invited for). Does NOT consume
// the invite; that happens in /parent-auth/accept-invite.
// -----------------------------------------------------------------------------
router.get("/parent-auth/invite/:token", async (req, res) => {
  const token = String(req.params.token || "").trim();
  if (!token) {
    res.status(400).json({ error: GENERIC_INVITE_ERROR });
    return;
  }
  const [invite] = await db
    .select()
    .from(parentInvitesTable)
    .where(eq(parentInvitesTable.token, token));
  if (!invite) {
    res.status(404).json({ error: GENERIC_INVITE_ERROR });
    return;
  }
  // Feature-license backstop — if the school's parentPortal license
  // was turned off after this invite was issued, refuse the token.
  if (!(await isParentPortalLicensedForSchool(invite.schoolId))) {
    res.status(410).json({ error: GENERIC_INVITE_ERROR });
    return;
  }
  if (invite.status === "revoked") {
    res.status(410).json({ error: GENERIC_INVITE_ERROR });
    return;
  }
  if (invite.expiresAt.getTime() < Date.now() && invite.status !== "accepted") {
    // Mark expired so admin UI shows the right state without waiting for a
    // background job. (Idempotent — only flips pending → expired.)
    if (invite.status === "pending") {
      await db
        .update(parentInvitesTable)
        .set({ status: "expired" })
        .where(eq(parentInvitesTable.id, invite.id));
    }
    res.status(410).json({ error: GENERIC_INVITE_ERROR });
    return;
  }

  const [student] = await db
    .select({
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
      grade: studentsTable.grade,
    })
    .from(studentsTable)
    .where(eq(studentsTable.id, invite.studentId));
  if (!student) {
    res.status(410).json({ error: GENERIC_INVITE_ERROR });
    return;
  }

  // Tell the client whether this email already has a parent account at this
  // school. If yes, the accept page can show "sign in to link this student"
  // instead of "create a password".
  const [existing] = await db
    .select({ id: parentsTable.id, hasPassword: parentsTable.passwordHash })
    .from(parentsTable)
    .where(
      and(
        eq(parentsTable.email, invite.email.toLowerCase()),
        eq(parentsTable.schoolId, invite.schoolId),
      ),
    );

  res.json({
    studentFirstName: student.firstName,
    studentLastName: student.lastName,
    studentGrade: student.grade,
    email: invite.email,
    alreadyHasAccount: !!existing && existing.hasPassword !== null,
    alreadyAccepted: invite.status === "accepted",
  });
});

// -----------------------------------------------------------------------------
// Accept an invite. Two paths:
//   - First-time: create the parent row with password, link to the student.
//   - Sibling: parent already exists at this school — verify their existing
//     password, then add the new student link. (We don't auto-link without a
//     password to prevent someone with just a fresh invite link from
//     piggy-backing onto another parent's account.)
// -----------------------------------------------------------------------------
router.post("/parent-auth/accept-invite", async (req, res) => {
  const { token, password, displayName } = (req.body ?? {}) as {
    token?: unknown;
    password?: unknown;
    displayName?: unknown;
  };
  if (typeof token !== "string" || !token.trim()) {
    res.status(400).json({ error: GENERIC_INVITE_ERROR });
    return;
  }
  if (typeof password !== "string" || password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }

  const [invite] = await db
    .select()
    .from(parentInvitesTable)
    .where(eq(parentInvitesTable.token, token.trim()));
  if (!invite || invite.status === "revoked") {
    res.status(404).json({ error: GENERIC_INVITE_ERROR });
    return;
  }
  // Feature-license backstop — see GET /parent-auth/invite/:token.
  if (!(await isParentPortalLicensedForSchool(invite.schoolId))) {
    res.status(410).json({ error: GENERIC_INVITE_ERROR });
    return;
  }
  if (invite.expiresAt.getTime() < Date.now() && invite.status !== "accepted") {
    res.status(410).json({ error: GENERIC_INVITE_ERROR });
    return;
  }

  const normalizedEmail = invite.email.toLowerCase();
  const [existing] = await db
    .select()
    .from(parentsTable)
    .where(
      and(
        eq(parentsTable.email, normalizedEmail),
        eq(parentsTable.schoolId, invite.schoolId),
      ),
    );

  let parentId: number;
  if (existing && existing.passwordHash) {
    // Sibling case — verify the existing password rather than overwriting.
    const ok = await bcrypt.compare(password, existing.passwordHash);
    if (!ok) {
      res.status(401).json({
        error:
          "An account with this email already exists at this school. Enter your existing password to add this student.",
      });
      return;
    }
    parentId = existing.id;
  } else {
    const hash = await bcrypt.hash(password, 10);
    const fallbackName =
      typeof displayName === "string" && displayName.trim().length > 0
        ? displayName.trim()
        : invite.email.split("@")[0];
    if (existing) {
      // Row exists but no password yet (someone restarted their invite).
      // Fill it in.
      await db
        .update(parentsTable)
        .set({ passwordHash: hash, displayName: fallbackName, active: true })
        .where(eq(parentsTable.id, existing.id));
      parentId = existing.id;
    } else {
      const inserted = await db
        .insert(parentsTable)
        .values({
          schoolId: invite.schoolId,
          email: normalizedEmail,
          passwordHash: hash,
          displayName: fallbackName,
        })
        .returning({ id: parentsTable.id });
      parentId = inserted[0].id;
    }
  }

  // Link the student (idempotent — unique index on (parent_id, student_id)).
  const [alreadyLinked] = await db
    .select({ id: parentStudentsTable.id })
    .from(parentStudentsTable)
    .where(
      and(
        eq(parentStudentsTable.parentId, parentId),
        eq(parentStudentsTable.studentId, invite.studentId),
      ),
    );
  if (!alreadyLinked) {
    await db
      .insert(parentStudentsTable)
      .values({ parentId, studentId: invite.studentId });
  }

  await db
    .update(parentInvitesTable)
    .set({
      status: "accepted",
      acceptedAt: new Date(),
      acceptedParentId: parentId,
    })
    .where(eq(parentInvitesTable.id, invite.id));

  // Auto-sign-in so the parent lands on their dashboard immediately.
  const [parent] = await db
    .select()
    .from(parentsTable)
    .where(eq(parentsTable.id, parentId));
  req.session.regenerate((err) => {
    if (err) {
      res.status(500).json({ error: "Could not start session" });
      return;
    }
    req.session.parentId = parentId;
    delete req.session.staffId;
    delete req.session.activeSchoolId;
    req.session.save((saveErr) => {
      if (saveErr) {
        res.status(500).json({ error: "Could not save session" });
        return;
      }
      res.json({
        ...publicParent(parent!),
        authToken: issueParentAuthToken(parentId),
      });
    });
  });
});

// -----------------------------------------------------------------------------
// Password reset — two-step email-mediated flow.
//
//   1. POST /parent-auth/request-reset { email }
//      Always returns 200 (no account enumeration). If a matching active
//      parent row exists AND their school's parentPortal feature is
//      licensed AND they have a password set, we generate a fresh token
//      (1h TTL) and email a reset link. Throttled at one live token per
//      parent — sending again invalidates the previous link.
//
//   2. GET /parent-auth/reset/:token
//      Validates the token (exists, not expired, not used, parent active,
//      school still licensed). Returns the parent's email so the reset
//      page can render context.
//
//   3. POST /parent-auth/reset { token, newPassword }
//      Re-validates, hashes + writes the new password, marks token used,
//      auto-signs the parent in.
//
// The email-link itself is the second factor: it proves the user controls
// the inbox the school has on file. No SMS / TOTP — see thread for FERPA
// rationale.
// -----------------------------------------------------------------------------
const GENERIC_RESET_ERROR =
  "This reset link is no longer valid. Request a new one from the sign-in page.";
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

function newResetToken(): string {
  // base62, not base64url: this raw token rides in the reset-email URL, where a
  // trailing '-'/'_' would be stripped by linkifiers. See lib/urlSafeToken.
  return genUrlSafeToken(43); // ~256 bits, parity with randomBytes(32)
}

// We persist only a SHA-256 hash of the reset token, never the raw value.
// The raw token is sent once in the email URL; everything that hits the DB
// (issuance, lookup, atomic consumption) goes through this hash. If the DB
// or query logs ever leak, the leaked column can't be used to reset anyone's
// password — same defense-in-depth pattern web frameworks use for session
// IDs and password-reset tokens.
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
    emailSignature:
      settings?.emailSignature || `Thank you,\n${schoolName}`,
  };
}

router.post("/parent-auth/request-reset", async (req, res) => {
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
    const candidates = await db
      .select()
      .from(parentsTable)
      .where(eq(parentsTable.email, normalized));
    // Pick the first active parent with a password set. If a family is at
    // two schools, we reset the first one — the other school's account
    // would need its own reset (rare edge case; both rows share the same
    // email so they'd both get reset eventually via repeated requests).
    const parent = candidates.find(
      (p) => p.active && p.passwordHash !== null,
    );
    if (!parent) {
      res.json(okResponse);
      return;
    }

    // Feature-license backstop — if the school's parentPortal license is
    // off, no reset (matches the invite-acceptance guard).
    if (!(await isParentPortalLicensedForSchool(parent.schoolId))) {
      res.json(okResponse);
      return;
    }

    // Abuse rate limit + atomic issuance, all inside one transaction so
    // the count → check → insert sequence can't be raced by concurrent
    // requests. Two locks serialize the relevant scopes:
    //   - SELECT … FOR UPDATE on the parent row  → per-parent serialization
    //     (also serializes the invalidate+insert below).
    //   - pg_advisory_xact_lock(hashtext(ip))    → per-IP serialization.
    // Caps:
    //   - 5/hour per parent (attacker who knows the email can't spam inbox)
    //   - 20/hour per IP   (attacker can't enumerate a wide list)
    // Both still return the no-enumeration 200; the breach just skips
    // the issuance + email. Logged at warn so ops can spot abuse.
    const token = newResetToken();
    const tokenHash = hashResetToken(token);
    const expiresAt = new Date(Date.now() + RESET_TTL_MS);
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    type IssuanceOutcome = "issued" | "rate-parent" | "rate-ip";
    const outcome: IssuanceOutcome = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from ${parentsTable} where id = ${parent.id} for update`,
      );
      if (req.ip) {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${req.ip}))`,
        );
      }
      const [byParent] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(parentPasswordResetsTable)
        .where(
          and(
            eq(parentPasswordResetsTable.parentId, parent.id),
            gt(parentPasswordResetsTable.createdAt, oneHourAgo),
          ),
        );
      if ((byParent?.n ?? 0) >= 5) return "rate-parent";
      if (req.ip) {
        const [byIp] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(parentPasswordResetsTable)
          .where(
            and(
              eq(parentPasswordResetsTable.requestedIp, req.ip),
              gt(parentPasswordResetsTable.createdAt, oneHourAgo),
            ),
          );
        if ((byIp?.n ?? 0) >= 20) return "rate-ip";
      }
      await tx
        .update(parentPasswordResetsTable)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(parentPasswordResetsTable.parentId, parent.id),
            isNull(parentPasswordResetsTable.usedAt),
          ),
        );
      await tx.insert(parentPasswordResetsTable).values({
        parentId: parent.id,
        token: tokenHash,
        expiresAt,
        requestedIp: req.ip ?? null,
      });
      return "issued";
    });
    if (outcome === "rate-parent") {
      logger.warn(
        { parentId: parent.id, ip: req.ip ?? null },
        "parent reset rate-limited per-parent",
      );
      res.json(okResponse);
      return;
    }
    if (outcome === "rate-ip") {
      logger.warn({ ip: req.ip }, "parent reset rate-limited per-ip");
      res.json(okResponse);
      return;
    }

    const ctx = await getSchoolEmailContext(parent.schoolId);
    try {
      await sendParentPasswordResetEmail({
        to: parent.email,
        parentDisplayName: parent.displayName,
        schoolName: ctx.schoolName,
        fromName: ctx.fromName,
        emailSignature: ctx.emailSignature,
        resetUrl: buildResetPasswordUrl(token),
      });
    } catch (err) {
      // Don't surface the send failure — same 200/ok response. Logged
      // for ops. The parent can request another reset.
      logger.warn(
        { err, parentId: parent.id },
        "parent reset email send failed",
      );
    }
  } catch (err) {
    logger.warn({ err, email: normalized }, "parent reset request failed");
  }

  res.json(okResponse);
});

router.get("/parent-auth/reset/:token", async (req, res) => {
  const token = String(req.params.token || "").trim();
  if (!token) {
    res.status(400).json({ error: GENERIC_RESET_ERROR });
    return;
  }
  const [row] = await db
    .select({
      id: parentPasswordResetsTable.id,
      parentId: parentPasswordResetsTable.parentId,
      expiresAt: parentPasswordResetsTable.expiresAt,
      usedAt: parentPasswordResetsTable.usedAt,
    })
    .from(parentPasswordResetsTable)
    .where(eq(parentPasswordResetsTable.token, hashResetToken(token)));
  if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) {
    res.status(410).json({ error: GENERIC_RESET_ERROR });
    return;
  }
  const [parent] = await db
    .select({
      id: parentsTable.id,
      email: parentsTable.email,
      displayName: parentsTable.displayName,
      schoolId: parentsTable.schoolId,
      active: parentsTable.active,
    })
    .from(parentsTable)
    .where(eq(parentsTable.id, row.parentId));
  if (!parent || !parent.active) {
    res.status(410).json({ error: GENERIC_RESET_ERROR });
    return;
  }
  if (!(await isParentPortalLicensedForSchool(parent.schoolId))) {
    res.status(410).json({ error: GENERIC_RESET_ERROR });
    return;
  }
  res.json({
    email: parent.email,
    displayName: parent.displayName,
  });
});

router.post("/parent-auth/reset", async (req, res) => {
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

  // Two-phase consume so we can enforce TOTP before burning the token.
  // Phase 1: look up the still-live reset row by hash and the parent it
  // points at. Phase 2 (below): atomic UPDATE…WHERE…unused that's the
  // actual single-use guarantee. The window between them is small and
  // the worst case (a concurrent click also succeeds) is still single-
  // use because the atomic phase has exactly one winner.
  const tokenHash = hashResetToken(token.trim());
  const [resetRow] = await db
    .select({
      parentId: parentPasswordResetsTable.parentId,
    })
    .from(parentPasswordResetsTable)
    .where(
      and(
        eq(parentPasswordResetsTable.token, tokenHash),
        isNull(parentPasswordResetsTable.usedAt),
        gt(parentPasswordResetsTable.expiresAt, new Date()),
      ),
    );
  if (!resetRow) {
    res.status(410).json({ error: GENERIC_RESET_ERROR });
    return;
  }
  const parentId = resetRow.parentId;

  const [parent] = await db
    .select()
    .from(parentsTable)
    .where(eq(parentsTable.id, parentId));
  if (!parent || !parent.active) {
    res.status(410).json({ error: GENERIC_RESET_ERROR });
    return;
  }
  if (!(await isParentPortalLicensedForSchool(parent.schoolId))) {
    res.status(410).json({ error: GENERIC_RESET_ERROR });
    return;
  }

  // TOTP enforcement at reset. If the parent enrolled, the email link
  // alone isn't enough — possession of the inbox AND the authenticator
  // must both be true. (If they lost the authenticator, they should
  // ask the school admin to clear it; we don't expose a self-serve
  // bypass for that on purpose.)
  if (parent.totpSecret) {
    const { code } = (req.body ?? {}) as { code?: unknown };
    if (typeof code !== "string" || !code.trim()) {
      res.status(401).json({
        requiresOtp: true,
        error: "Enter the 6-digit code from your authenticator app.",
      });
      return;
    }
    if (!verifyStoredTotp(parent.totpSecret, code)) {
      res.status(401).json({
        requiresOtp: true,
        error: "That 6-digit code didn't match. Try again.",
      });
      return;
    }
  }

  // Atomic single-use consume — winner takes the row; a racing click
  // gets 0 rows back and fails closed.
  const consumed = await db
    .update(parentPasswordResetsTable)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(parentPasswordResetsTable.token, tokenHash),
        isNull(parentPasswordResetsTable.usedAt),
        sql`${parentPasswordResetsTable.expiresAt} > now()`,
      ),
    )
    .returning({ parentId: parentPasswordResetsTable.parentId });
  if (consumed.length === 0) {
    res.status(410).json({ error: GENERIC_RESET_ERROR });
    return;
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await db
    .update(parentsTable)
    .set({ passwordHash, lastLoginAt: new Date() })
    .where(eq(parentsTable.id, parentId));

  // Auto-sign-in so the parent lands on their dashboard — same pattern
  // as accept-invite. Clear any pre-existing staff session bits.
  req.session.regenerate((err) => {
    if (err) {
      res.status(500).json({ error: "Could not start session" });
      return;
    }
    req.session.parentId = parentId;
    delete req.session.staffId;
    delete req.session.activeSchoolId;
    req.session.save((saveErr) => {
      if (saveErr) {
        res.status(500).json({ error: "Could not save session" });
        return;
      }
      res.json({
        ...publicParent({ ...parent, passwordHash }),
        authToken: issueParentAuthToken(parentId),
      });
    });
  });
});

router.post("/parent-auth/change-password", async (req, res) => {
  const pid = req.parentId;
  if (!pid) {
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
    res
      .status(400)
      .json({ error: "currentPassword and newPassword (min 8) are required" });
    return;
  }
  const [parent] = await db
    .select()
    .from(parentsTable)
    .where(eq(parentsTable.id, pid));
  if (!parent || !parent.active || !parent.passwordHash) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const ok = await bcrypt.compare(currentPassword, parent.passwordHash);
  if (!ok) {
    res.status(401).json({ error: "Current password is incorrect" });
    return;
  }
  const passwordHash = await bcrypt.hash(newPassword, 10);
  await db
    .update(parentsTable)
    .set({ passwordHash })
    .where(eq(parentsTable.id, pid));
  res.json({ ok: true });
});

// =============================================================================
// TOTP (Time-based One-Time Password) — optional second factor.
//
// Opt-in, per-parent. Setup is a two-step dance so we never persist a secret
// the parent hasn't actually scanned + confirmed:
//   1) POST /totp/setup    — auth + current password. Generates a fresh
//      base32 secret and returns it + otpauth URI. We DON'T persist yet.
//   2) POST /totp/confirm  — auth. Body carries back the secret from step 1
//      plus the first 6-digit code from the authenticator app. If the code
//      verifies, we persist `totp_secret` + `totp_enabled_at`.
// Disable requires both password and a current code (you can't disable just
// by knowing the password, in case the password was phished but the
// authenticator is still on the real owner's phone).
// =============================================================================
function requireParent(
  req: Request,
): { ok: true; pid: number } | { ok: false; status: number; error: string } {
  const pid = req.parentId;
  if (!pid) return { ok: false, status: 401, error: "Sign-in required" };
  return { ok: true, pid };
}

router.get("/parent-auth/totp/status", async (req, res) => {
  const auth = requireParent(req);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }
  const [p] = await db
    .select({ enabledAt: parentsTable.totpEnabledAt })
    .from(parentsTable)
    .where(eq(parentsTable.id, auth.pid));
  res.json({ enabled: Boolean(p?.enabledAt), enabledAt: p?.enabledAt ?? null });
});

router.post("/parent-auth/totp/setup", async (req, res) => {
  const auth = requireParent(req);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }
  const { currentPassword } = (req.body ?? {}) as { currentPassword?: unknown };
  if (typeof currentPassword !== "string" || !currentPassword) {
    res.status(400).json({ error: "Current password is required" });
    return;
  }
  const [parent] = await db
    .select()
    .from(parentsTable)
    .where(eq(parentsTable.id, auth.pid));
  if (!parent || !parent.active || !parent.passwordHash) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const ok = await bcrypt.compare(currentPassword, parent.passwordHash);
  if (!ok) {
    res.status(401).json({ error: "Current password is incorrect" });
    return;
  }
  // Fresh secret each call so an aborted setup doesn't leave a half-known
  // secret pinned to the account. The client must echo it back to /confirm.
  const secret = authenticator.generateSecret();
  res.json({
    secret,
    otpauthUri: buildOtpauthUri(parent.email, secret),
    issuer: TOTP_ISSUER,
  });
});

router.post("/parent-auth/totp/confirm", async (req, res) => {
  const auth = requireParent(req);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }
  const { secret, code } = (req.body ?? {}) as {
    secret?: unknown;
    code?: unknown;
  };
  if (typeof secret !== "string" || !secret.trim()) {
    res.status(400).json({ error: "Setup expired — start again." });
    return;
  }
  if (!isValidTotpCode(secret, code)) {
    res.status(400).json({
      error: "That code didn't match. Try the next code your app shows.",
    });
    return;
  }
  await db
    .update(parentsTable)
    .set({
      // Encrypted at rest with an app-key derivative; the raw secret only
      // ever lives in this request handler + the parent's authenticator app.
      totpSecret: encryptSecret(secret),
      totpEnabledAt: new Date(),
    })
    .where(eq(parentsTable.id, auth.pid));
  res.json({ ok: true, enabled: true });
});

router.post("/parent-auth/totp/disable", async (req, res) => {
  const auth = requireParent(req);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }
  const { currentPassword, code } = (req.body ?? {}) as {
    currentPassword?: unknown;
    code?: unknown;
  };
  if (typeof currentPassword !== "string" || !currentPassword) {
    res.status(400).json({ error: "Current password is required" });
    return;
  }
  const [parent] = await db
    .select()
    .from(parentsTable)
    .where(eq(parentsTable.id, auth.pid));
  if (!parent || !parent.active || !parent.passwordHash) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const ok = await bcrypt.compare(currentPassword, parent.passwordHash);
  if (!ok) {
    res.status(401).json({ error: "Current password is incorrect" });
    return;
  }
  if (!parent.totpSecret) {
    res.json({ ok: true, enabled: false });
    return;
  }
  if (!verifyStoredTotp(parent.totpSecret, code)) {
    res.status(400).json({
      error:
        "Enter the 6-digit code from your authenticator app to turn off two-step verification.",
    });
    return;
  }
  await db
    .update(parentsTable)
    .set({ totpSecret: null, totpEnabledAt: null })
    .where(eq(parentsTable.id, auth.pid));
  res.json({ ok: true, enabled: false });
});

export default router;
