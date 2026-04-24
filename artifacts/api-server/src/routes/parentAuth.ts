import { Router, type IRouter, type Request } from "express";
import bcrypt from "bcryptjs";
import {
  db,
  parentsTable,
  parentStudentsTable,
  parentInvitesTable,
  studentsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
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
