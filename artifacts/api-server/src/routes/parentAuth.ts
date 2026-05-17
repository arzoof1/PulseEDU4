import { Router, type IRouter, type Request } from "express";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
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
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
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
  return crypto.randomBytes(32).toString("base64url");
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

    // Atomic invalidate-then-insert under a per-parent row lock. Without
    // the lock, two concurrent reset requests for the same parent could
    // each invalidate the empty set of prior tokens and then each insert
    // a fresh row — leaving two live links. SELECT … FOR UPDATE on the
    // parent row serializes the two requests so the second one sees the
    // first's invalidate + insert before doing its own.
    const token = newResetToken();
    const tokenHash = hashResetToken(token);
    const expiresAt = new Date(Date.now() + RESET_TTL_MS);
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from ${parentsTable} where id = ${parent.id} for update`,
      );
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
    });

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

  // Atomically consume the token: only succeeds if it's unused + unexpired.
  // The RETURNING clause tells us the parent_id to update, with zero risk
  // of two concurrent reset clicks both succeeding. The DB column holds
  // a SHA-256 hash of the raw token, so we look up by the hash.
  const consumed = await db
    .update(parentPasswordResetsTable)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(parentPasswordResetsTable.token, hashResetToken(token.trim())),
        isNull(parentPasswordResetsTable.usedAt),
        sql`${parentPasswordResetsTable.expiresAt} > now()`,
      ),
    )
    .returning({ parentId: parentPasswordResetsTable.parentId });
  if (consumed.length === 0) {
    res.status(410).json({ error: GENERIC_RESET_ERROR });
    return;
  }
  const parentId = consumed[0].parentId;

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

export default router;
