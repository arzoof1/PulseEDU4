import { Router, type IRouter } from "express";
import crypto from "node:crypto";
import {
  db,
  parentInvitesTable,
  parentsTable,
  studentsTable,
  schoolSettingsTable,
  schoolsTable,
  staffTable,
} from "@workspace/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  buildAcceptInviteUrl,
  sendParentInviteEmail,
} from "../lib/parentInviteEmail.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

// All routes here require an admin (or SuperUser) on the active school.
async function requireAdmin(req: any, res: any): Promise<boolean> {
  const sid = req.staffId ?? null;
  if (!sid) {
    res.status(401).json({ error: "Sign-in required" });
    return false;
  }
  const [staff] = await db
    .select({
      isAdmin: staffTable.isAdmin,
      isSuperUser: staffTable.isSuperUser,
    })
    .from(staffTable)
    .where(eq(staffTable.id, sid));
  if (!staff || (!staff.isAdmin && !staff.isSuperUser)) {
    res.status(403).json({ error: "Admin access required" });
    return false;
  }
  return true;
}

const INVITE_TTL_DAYS = 14;

function newInviteToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function isValidEmail(s: string | null | undefined): s is string {
  if (!s) return false;
  const t = s.trim();
  if (!t.includes("@") || t.length < 5 || t.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t);
}

async function getSchoolContext(schoolId: number) {
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
  return {
    schoolName: settings?.schoolName || school?.name || "Your school",
    fromName: settings?.fromName || school?.name || "PulseEDU",
    emailSignature:
      settings?.emailSignature ||
      `Thank you,\n${settings?.schoolName || school?.name || "PulseEDU"}`,
  };
}

// -----------------------------------------------------------------------------
// GET /api/admin/parent-invites
// Returns one row per student in the active school, joined with their most
// recent invite (if any) so the admin UI can show: parent email, last status,
// when sent, accepted parent name. Used by the "Parent Access" page.
// -----------------------------------------------------------------------------
router.get("/admin/parent-invites", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const schoolId = req.schoolId;
  if (!schoolId) {
    res.status(400).json({ error: "No active school" });
    return;
  }

  const students = await db
    .select({
      id: studentsTable.id,
      studentId: studentsTable.studentId,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
      grade: studentsTable.grade,
      parentEmail: studentsTable.parentEmail,
      parentName: studentsTable.parentName,
    })
    .from(studentsTable)
    .where(eq(studentsTable.schoolId, schoolId));

  const studentIds = students.map((s) => s.id);
  type InviteJoin = {
    id: number;
    studentId: number;
    email: string;
    status: string;
    sentAt: Date;
    expiresAt: Date;
    acceptedAt: Date | null;
    resendCount: number;
    lastResentAt: Date | null;
    acceptedParentName: string | null;
  };
  let invitesByStudent = new Map<number, InviteJoin>();
  if (studentIds.length > 0) {
    // Fetch all invites for these students, then keep the most recent per
    // student in JS — simpler than a window function for the row count we
    // expect (a few hundred per school at most).
    const allInvites = await db
      .select({
        id: parentInvitesTable.id,
        studentId: parentInvitesTable.studentId,
        email: parentInvitesTable.email,
        status: parentInvitesTable.status,
        sentAt: parentInvitesTable.sentAt,
        expiresAt: parentInvitesTable.expiresAt,
        acceptedAt: parentInvitesTable.acceptedAt,
        resendCount: parentInvitesTable.resendCount,
        lastResentAt: parentInvitesTable.lastResentAt,
        acceptedParentName: parentsTable.displayName,
      })
      .from(parentInvitesTable)
      .leftJoin(
        parentsTable,
        eq(parentInvitesTable.acceptedParentId, parentsTable.id),
      )
      .where(inArray(parentInvitesTable.studentId, studentIds))
      .orderBy(desc(parentInvitesTable.sentAt));

    for (const inv of allInvites) {
      if (!invitesByStudent.has(inv.studentId)) {
        invitesByStudent.set(inv.studentId, inv as InviteJoin);
      }
    }
  }

  const now = Date.now();
  const rows = students
    .map((s) => {
      const inv = invitesByStudent.get(s.id);
      let status: string;
      if (!inv) {
        status = isValidEmail(s.parentEmail) ? "not_sent" : "no_email";
      } else if (inv.status === "pending" && inv.expiresAt.getTime() < now) {
        status = "expired";
      } else {
        status = inv.status;
      }
      return {
        student: {
          id: s.id,
          studentId: s.studentId,
          firstName: s.firstName,
          lastName: s.lastName,
          grade: s.grade,
          parentName: s.parentName,
          parentEmail: s.parentEmail,
        },
        invite: inv
          ? {
              id: inv.id,
              email: inv.email,
              status,
              sentAt: inv.sentAt,
              expiresAt: inv.expiresAt,
              acceptedAt: inv.acceptedAt,
              acceptedParentName: inv.acceptedParentName,
              resendCount: inv.resendCount,
              lastResentAt: inv.lastResentAt,
            }
          : null,
        canSend:
          (!inv || inv.status === "expired" || inv.status === "revoked") &&
          isValidEmail(s.parentEmail),
        canResend: !!inv && inv.status === "pending",
      };
    })
    .sort((a, b) =>
      `${a.student.lastName} ${a.student.firstName}`.localeCompare(
        `${b.student.lastName} ${b.student.firstName}`,
      ),
    );

  res.json({ rows });
});

// -----------------------------------------------------------------------------
// POST /api/admin/parent-invites/send
// Body: { studentIds?: number[] }  — when omitted, sends to ALL eligible
// students (students.parent_email is set AND no live invite or accepted account
// exists). Returns per-student outcomes so the UI can surface failures.
// -----------------------------------------------------------------------------
router.post("/admin/parent-invites/send", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const schoolId = req.schoolId;
  if (!schoolId) {
    res.status(400).json({ error: "No active school" });
    return;
  }

  const requestedIds = Array.isArray((req.body as any)?.studentIds)
    ? ((req.body as any).studentIds as unknown[])
        .map((v) => Number(v))
        .filter((n) => Number.isInteger(n) && n > 0)
    : null;

  let students = await db
    .select({
      id: studentsTable.id,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
      parentEmail: studentsTable.parentEmail,
    })
    .from(studentsTable)
    .where(eq(studentsTable.schoolId, schoolId));
  if (requestedIds && requestedIds.length > 0) {
    const set = new Set(requestedIds);
    students = students.filter((s) => set.has(s.id));
  }

  const ctx = await getSchoolContext(schoolId);
  const now = new Date();
  const expires = new Date(now.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
  const results: Array<{
    studentId: number;
    status: "sent" | "skipped" | "failed";
    reason?: string;
  }> = [];

  for (const s of students) {
    if (!isValidEmail(s.parentEmail)) {
      results.push({
        studentId: s.id,
        status: "skipped",
        reason: "no_email",
      });
      continue;
    }
    const email = s.parentEmail.trim().toLowerCase();

    // Skip if there's already an accepted invite OR a live (pending,
    // not-yet-expired) invite for this exact email + student.
    const existing = await db
      .select({
        id: parentInvitesTable.id,
        status: parentInvitesTable.status,
        expiresAt: parentInvitesTable.expiresAt,
      })
      .from(parentInvitesTable)
      .where(
        and(
          eq(parentInvitesTable.studentId, s.id),
          eq(parentInvitesTable.email, email),
        ),
      );
    const live = existing.find(
      (e) =>
        e.status === "accepted" ||
        (e.status === "pending" && e.expiresAt.getTime() > Date.now()),
    );
    if (live) {
      results.push({
        studentId: s.id,
        status: "skipped",
        reason: live.status === "accepted" ? "already_accepted" : "already_pending",
      });
      continue;
    }

    const token = newInviteToken();
    const inserted = await db
      .insert(parentInvitesTable)
      .values({
        schoolId,
        studentId: s.id,
        email,
        token,
        status: "pending",
        sentAt: now,
        expiresAt: expires,
        sentByStaffId: req.staffId!,
      })
      .returning({ id: parentInvitesTable.id });

    try {
      await sendParentInviteEmail({
        to: email,
        studentFirstName: s.firstName,
        studentLastName: s.lastName,
        schoolName: ctx.schoolName,
        fromName: ctx.fromName,
        emailSignature: ctx.emailSignature,
        acceptUrl: buildAcceptInviteUrl(token),
        isResend: false,
      });
      results.push({ studentId: s.id, status: "sent" });
    } catch (err) {
      // Roll the invite back so the row count matches what actually went out.
      await db
        .delete(parentInvitesTable)
        .where(eq(parentInvitesTable.id, inserted[0].id));
      logger.warn(
        { err, studentId: s.id, email },
        "parent invite send failed",
      );
      results.push({
        studentId: s.id,
        status: "failed",
        reason: err instanceof Error ? err.message : "send_failed",
      });
    }
  }

  res.json({
    sent: results.filter((r) => r.status === "sent").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    failed: results.filter((r) => r.status === "failed").length,
    results,
  });
});

// -----------------------------------------------------------------------------
// POST /api/admin/parent-invites/:id/resend
// Re-issues the email for an existing invite and bumps the resend counter.
// If the invite was already accepted, returns 409 (no email; nothing to do).
// If it expired, generates a fresh token and a new 14-day window.
// -----------------------------------------------------------------------------
router.post("/admin/parent-invites/:id/resend", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const schoolId = req.schoolId;
  if (!schoolId) {
    res.status(400).json({ error: "No active school" });
    return;
  }
  const inviteId = Number(req.params.id);
  if (!Number.isInteger(inviteId) || inviteId <= 0) {
    res.status(400).json({ error: "Invalid invite id" });
    return;
  }

  const [invite] = await db
    .select()
    .from(parentInvitesTable)
    .where(
      and(
        eq(parentInvitesTable.id, inviteId),
        eq(parentInvitesTable.schoolId, schoolId),
      ),
    );
  if (!invite) {
    res.status(404).json({ error: "Invite not found" });
    return;
  }
  if (invite.status === "accepted") {
    res.status(409).json({ error: "This parent has already accepted." });
    return;
  }
  if (invite.status === "revoked") {
    res.status(409).json({ error: "This invite was revoked." });
    return;
  }

  const [student] = await db
    .select({
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
    })
    .from(studentsTable)
    .where(eq(studentsTable.id, invite.studentId));
  if (!student) {
    res.status(410).json({ error: "Student no longer exists" });
    return;
  }

  // Fresh token + window if expired so the email link actually works.
  const isExpired = invite.expiresAt.getTime() < Date.now();
  const newToken = isExpired ? newInviteToken() : invite.token;
  const newExpires = isExpired
    ? new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000)
    : invite.expiresAt;

  const ctx = await getSchoolContext(schoolId);
  const now = new Date();

  await db
    .update(parentInvitesTable)
    .set({
      token: newToken,
      expiresAt: newExpires,
      status: "pending",
      resendCount: invite.resendCount + 1,
      lastResentAt: now,
      sentByStaffId: req.staffId!,
    })
    .where(eq(parentInvitesTable.id, invite.id));

  try {
    await sendParentInviteEmail({
      to: invite.email,
      studentFirstName: student.firstName,
      studentLastName: student.lastName,
      schoolName: ctx.schoolName,
      fromName: ctx.fromName,
      emailSignature: ctx.emailSignature,
      acceptUrl: buildAcceptInviteUrl(newToken),
      isResend: true,
    });
  } catch (err) {
    logger.warn({ err, inviteId }, "parent invite resend failed");
    res.status(502).json({
      error: err instanceof Error ? err.message : "Email send failed",
    });
    return;
  }

  res.json({ ok: true });
});

// -----------------------------------------------------------------------------
// POST /api/admin/parent-invites/:id/revoke
// Lets an admin kill a live invite (e.g., wrong email, parent left).
// -----------------------------------------------------------------------------
router.post("/admin/parent-invites/:id/revoke", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const schoolId = req.schoolId;
  if (!schoolId) {
    res.status(400).json({ error: "No active school" });
    return;
  }
  const inviteId = Number(req.params.id);
  if (!Number.isInteger(inviteId) || inviteId <= 0) {
    res.status(400).json({ error: "Invalid invite id" });
    return;
  }
  await db
    .update(parentInvitesTable)
    .set({ status: "revoked" })
    .where(
      and(
        eq(parentInvitesTable.id, inviteId),
        eq(parentInvitesTable.schoolId, schoolId),
      ),
    );
  res.json({ ok: true });
});

export default router;
