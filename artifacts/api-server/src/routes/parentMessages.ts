// Family Messages — admin/Core-Team → parent broadcast announcements.
//
// A Core Team member composes one message (subject + body + optional .png/.pdf
// attachment), targets an audience (whole school, by grade, by house/team, or
// specific students via CSV of local SIS IDs), and the server fans it out into
// per-family rows. Each family with a Parent Portal account sees the message in
// their inbox with a "Got it" button; an optional Resend email nudge links back
// to the portal.
//
// Counters are REAL, not estimates: every targeted family gets one
// parent_message_recipients row, so "Reached" and "Got it" are COUNT()s over
// that table — never a guess.
//
// Module talks to the client via authFetch (no OpenAPI codegen — repo
// convention for feature routes).
//
// Tenancy: school_id stamped on every row; every read/write is school-scoped.
// Staff routes read req.schoolId (staff-auth middleware). Parent routes read
// req.parentId (parent session / Bearer token) and resolve school from the
// parent row.
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
  schoolsTable,
  studentsTable,
  parentsTable,
  parentStudentsTable,
  parentMessagesTable,
  parentMessageRecipientsTable,
  pulseDnaVideosTable,
} from "@workspace/db";
import { and, eq, inArray, desc, sql, isNotNull } from "drizzle-orm";
import { isCoreTeam } from "../lib/coreTeam.js";
import { verifyParentAuthToken } from "../lib/authToken.js";
import {
  bindObjectToSchool,
  streamObjectToResponse,
} from "./storage.js";
import { getUncachableResendClient } from "../lib/resendClient.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

type StaffRow = typeof staffTable.$inferSelect;

// Power Reader: a family that consistently acknowledges. Earned when a parent
// has been sent at least MIN messages and has acknowledged at least RATIO of
// them. Purely derived from acknowledgment history — no PBIS-points change.
const POWER_READER_MIN_MESSAGES = 3;
const POWER_READER_RATIO = 0.8;

function isPowerReader(total: number, acknowledged: number): boolean {
  return (
    total >= POWER_READER_MIN_MESSAGES &&
    acknowledged / total >= POWER_READER_RATIO
  );
}

const ALLOWED_ATTACHMENT_TYPES = new Set(["image/png", "application/pdf"]);

// Resolve the absolute origin for parent-facing portal links. Families open
// these OUTSIDE the workspace, so prefer the published prod host over the dev
// domain. Mirrors publicAppOrigin() in routes/tours.ts.
function publicAppOrigin(req?: Request): string {
  const explicit = process.env.PUBLIC_APP_URL;
  if (explicit && explicit.length > 0) return explicit.replace(/\/+$/, "");
  const replitDomains = (process.env.REPLIT_DOMAINS ?? "").trim();
  if (replitDomains) {
    const first = replitDomains.split(",")[0]?.trim();
    if (first) return `https://${first}`;
  }
  if (req) {
    const rawProto = (req.headers["x-forwarded-proto"] as string | undefined)
      ?.split(",")[0]
      ?.trim()
      .toLowerCase();
    const proto =
      rawProto === "http" || rawProto === "https" ? rawProto : "https";
    const rawHost = (req.headers["x-forwarded-host"] ?? req.headers.host) as
      | string
      | undefined;
    const host = rawHost?.split(",")[0]?.trim();
    if (host) return `${proto}://${host}`;
  }
  const replit = process.env.REPLIT_DEV_DOMAIN;
  if (replit && replit.length > 0) return `https://${replit}`;
  return "http://localhost:5000";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// =============================================================================
// Staff side — Core Team composes + monitors
// =============================================================================

async function requireStaff(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const staffId = req.staffId;
  if (!staffId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const [staff] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, staffId));
  if (!staff || !staff.active) {
    res.status(401).json({ error: "Staff not found or inactive" });
    return;
  }
  (req as Request & { staff: StaffRow }).staff = staff;
  next();
}

function staffOf(req: Request): StaffRow {
  return (req as Request & { staff: StaffRow }).staff;
}

function requireFamilyMessenger(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!isCoreTeam(staffOf(req))) {
    res
      .status(403)
      .json({ error: "Not authorized to send Family Messages" });
    return;
  }
  next();
}

// Resolve the set of target students.id values for an audience selection,
// scoped to the school. Returns null on an invalid selector so the caller can
// 400.
async function resolveAudienceStudentIds(
  schoolId: number,
  audienceType: string,
  opts: {
    grades?: string[];
    houseIds?: number[];
    localSisIds?: string[];
  },
): Promise<{ studentIds: number[]; unmatchedSisIds: string[] } | null> {
  if (audienceType === "school") {
    const rows = await db
      .select({ id: studentsTable.id })
      .from(studentsTable)
      .where(eq(studentsTable.schoolId, schoolId));
    return { studentIds: rows.map((r) => r.id), unmatchedSisIds: [] };
  }
  if (audienceType === "grade") {
    const grades = (opts.grades ?? [])
      .map((g) => Number(g))
      .filter((g) => Number.isFinite(g));
    if (grades.length === 0) return null;
    const rows = await db
      .select({ id: studentsTable.id })
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.schoolId, schoolId),
          inArray(studentsTable.grade, grades),
        ),
      );
    return { studentIds: rows.map((r) => r.id), unmatchedSisIds: [] };
  }
  if (audienceType === "house") {
    const houseIds = (opts.houseIds ?? [])
      .map((h) => Number(h))
      .filter((h) => Number.isFinite(h));
    if (houseIds.length === 0) return null;
    const rows = await db
      .select({ id: studentsTable.id })
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.schoolId, schoolId),
          inArray(studentsTable.houseId, houseIds),
        ),
      );
    return { studentIds: rows.map((r) => r.id), unmatchedSisIds: [] };
  }
  if (audienceType === "students") {
    const sisIds = Array.from(
      new Set(
        (opts.localSisIds ?? [])
          .map((s) => String(s ?? "").trim())
          .filter((s) => s.length > 0),
      ),
    );
    if (sisIds.length === 0) return null;
    const rows = await db
      .select({ id: studentsTable.id, localSisId: studentsTable.localSisId })
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.schoolId, schoolId),
          inArray(studentsTable.localSisId, sisIds),
        ),
      );
    const matched = new Set(
      rows.map((r) => (r.localSisId ?? "").trim()).filter(Boolean),
    );
    const unmatchedSisIds = sisIds.filter((s) => !matched.has(s));
    return { studentIds: rows.map((r) => r.id), unmatchedSisIds };
  }
  return null;
}

// Build the per-family recipient set for a target student list.
//   - Families WITH a portal account → recipientKey "p:<parentId>",
//     deliveredPortal true; nudged at parents.email.
//   - Families with only an on-file email (students.parent_email) NOT already
//     covered by an account → recipientKey "e:<email>", deliveredEmail only.
type ResolvedRecipient = {
  recipientKey: string;
  parentId: number | null;
  email: string | null;
  studentIds: number[];
  deliveredPortal: boolean;
};

async function buildRecipients(
  schoolId: number,
  studentIds: number[],
): Promise<ResolvedRecipient[]> {
  if (studentIds.length === 0) return [];

  const byKey = new Map<string, ResolvedRecipient>();

  // 1) Portal-account families via parent_students → parents.
  const accountRows = await db
    .select({
      parentId: parentsTable.id,
      email: parentsTable.email,
      studentId: parentStudentsTable.studentId,
    })
    .from(parentStudentsTable)
    .innerJoin(parentsTable, eq(parentStudentsTable.parentId, parentsTable.id))
    .where(
      and(
        eq(parentsTable.schoolId, schoolId),
        eq(parentsTable.active, true),
        inArray(parentStudentsTable.studentId, studentIds),
      ),
    );

  const accountEmails = new Set<string>();
  for (const row of accountRows) {
    const key = `p:${row.parentId}`;
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.studentIds.includes(row.studentId)) {
        existing.studentIds.push(row.studentId);
      }
    } else {
      byKey.set(key, {
        recipientKey: key,
        parentId: row.parentId,
        email: row.email ?? null,
        studentIds: [row.studentId],
        deliveredPortal: true,
      });
    }
    if (row.email) accountEmails.add(row.email.trim().toLowerCase());
  }

  // 2) Email-only families — student.parent_email not covered by an account.
  const targetStudents = await db
    .select({ id: studentsTable.id, parentEmail: studentsTable.parentEmail })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.schoolId, schoolId),
        inArray(studentsTable.id, studentIds),
      ),
    );

  for (const s of targetStudents) {
    const email = (s.parentEmail ?? "").trim();
    if (!email) continue;
    const lower = email.toLowerCase();
    if (accountEmails.has(lower)) continue; // already reachable via portal
    const key = `e:${lower}`;
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.studentIds.includes(s.id)) existing.studentIds.push(s.id);
    } else {
      byKey.set(key, {
        recipientKey: key,
        parentId: null,
        email,
        studentIds: [s.id],
        deliveredPortal: false,
      });
    }
  }

  return Array.from(byKey.values());
}

// Load a school-scoped lookup of attachable video metadata for a set of
// (possibly null/duplicate) videoIds. Returns only display-safe fields; the
// media itself streams through the dedicated file routes.
type VideoMeta = {
  id: number;
  status: string;
  durationSec: number | null;
  hasMp4: boolean;
  hasAudio: boolean;
  purged: boolean;
};
async function loadVideoMeta(
  schoolId: number,
  ids: Array<number | null>,
): Promise<Map<number, VideoMeta>> {
  const wanted = Array.from(
    new Set(ids.filter((v): v is number => v != null)),
  );
  const map = new Map<number, VideoMeta>();
  if (wanted.length === 0) return map;
  const rows = await db
    .select()
    .from(pulseDnaVideosTable)
    .where(
      and(
        eq(pulseDnaVideosTable.schoolId, schoolId),
        inArray(pulseDnaVideosTable.id, wanted),
      ),
    );
  for (const r of rows) {
    map.set(r.id, {
      id: r.id,
      status: r.status,
      durationSec: r.durationSec,
      hasMp4: r.mp4ObjectKey != null,
      hasAudio: r.audioObjectKey != null,
      purged: r.status === "purged",
    });
  }
  return map;
}

// POST /family-messages — compose + send.
router.post(
  "/family-messages",
  requireStaff,
  requireFamilyMessenger,
  async (req: Request, res: Response) => {
    const schoolId = req.schoolId;
    const staff = staffOf(req);
    if (!schoolId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const subject = String(req.body?.subject ?? "").trim();
    const body = String(req.body?.body ?? "").trim();
    if (!subject) {
      res.status(400).json({ error: "Subject is required" });
      return;
    }
    if (!body) {
      res.status(400).json({ error: "Message body is required" });
      return;
    }
    if (subject.length > 200) {
      res.status(400).json({ error: "Subject is too long (max 200)" });
      return;
    }

    const audienceType = String(req.body?.audienceType ?? "school");
    if (!["school", "grade", "house", "students"].includes(audienceType)) {
      res.status(400).json({ error: "Invalid audience" });
      return;
    }
    const grades = Array.isArray(req.body?.audienceGrades)
      ? req.body.audienceGrades.map((g: unknown) => String(g))
      : [];
    const houseIds = Array.isArray(req.body?.audienceHouseIds)
      ? req.body.audienceHouseIds.map((h: unknown) => Number(h))
      : [];
    const localSisIds = Array.isArray(req.body?.audienceLocalSisIds)
      ? req.body.audienceLocalSisIds.map((s: unknown) => String(s))
      : [];
    const emailNudge = req.body?.emailNudge !== false;

    // Optional attachment (png/pdf only). Bind it to the school so the
    // attachment read path can authorize it.
    const attachmentObjectKey = req.body?.attachmentObjectKey
      ? String(req.body.attachmentObjectKey)
      : null;
    const attachmentName = req.body?.attachmentName
      ? String(req.body.attachmentName)
      : null;
    const attachmentType = req.body?.attachmentType
      ? String(req.body.attachmentType)
      : null;
    if (attachmentObjectKey) {
      if (!attachmentType || !ALLOWED_ATTACHMENT_TYPES.has(attachmentType)) {
        res
          .status(400)
          .json({ error: "Attachment must be a PNG image or a PDF" });
        return;
      }
      const bound = await bindObjectToSchool(attachmentObjectKey, schoolId);
      if (!bound) {
        res.status(403).json({ error: "Attachment could not be attached" });
        return;
      }
    }

    // Optional PulseDNA video attachment. Must be a "ready" video belonging to
    // this school. Attaching it to a sent message flips it to school-year
    // retention (sentAt stamped after the message row is created).
    const videoId =
      req.body?.videoId != null ? Number(req.body.videoId) : null;
    let videoRow: typeof pulseDnaVideosTable.$inferSelect | null = null;
    if (videoId != null) {
      if (!Number.isInteger(videoId)) {
        res.status(400).json({ error: "Invalid video selection" });
        return;
      }
      const [v] = await db
        .select()
        .from(pulseDnaVideosTable)
        .where(
          and(
            eq(pulseDnaVideosTable.id, videoId),
            eq(pulseDnaVideosTable.schoolId, schoolId),
          ),
        );
      if (!v || v.status !== "ready") {
        res
          .status(400)
          .json({ error: "Selected video is not ready to attach" });
        return;
      }
      videoRow = v;
    }

    const resolved = await resolveAudienceStudentIds(schoolId, audienceType, {
      grades,
      houseIds,
      localSisIds,
    });
    if (!resolved) {
      res.status(400).json({ error: "Audience selection is incomplete" });
      return;
    }
    if (resolved.studentIds.length === 0) {
      res
        .status(400)
        .json({ error: "No students matched the selected audience" });
      return;
    }

    const recipients = await buildRecipients(schoolId, resolved.studentIds);
    if (recipients.length === 0) {
      res.status(400).json({
        error:
          "No families to reach — none of the targeted students have a portal account or an email on file",
      });
      return;
    }

    // Reached = families we can deliver to via any channel. Portal accounts are
    // always reached (inbox); email-only families are reached when a nudge is
    // sent and an address exists.
    const reachedCount = recipients.filter(
      (r) => r.deliveredPortal || (emailNudge && !!r.email),
    ).length;

    const [message] = await db
      .insert(parentMessagesTable)
      .values({
        schoolId,
        createdByStaffId: staff.id,
        subject,
        body,
        attachmentObjectKey,
        attachmentName,
        attachmentType,
        audienceType,
        audienceGrades: audienceType === "grade" ? grades : null,
        audienceHouseIds: audienceType === "house" ? houseIds : null,
        audienceStudentIds:
          audienceType === "students" ? resolved.studentIds : null,
        emailNudge,
        videoId: videoRow ? videoRow.id : null,
        totalRecipients: recipients.length,
        reachedRecipients: reachedCount,
      })
      .returning();

    // Attaching the video to a sent message flips it to school-year retention
    // (purged at rollover, not after the 14-day library window). Idempotent —
    // only stamps sentAt the first time it's attached.
    if (videoRow && videoRow.sentAt == null) {
      await db
        .update(pulseDnaVideosTable)
        .set({ sentAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(pulseDnaVideosTable.id, videoRow.id),
            eq(pulseDnaVideosTable.schoolId, schoolId),
          ),
        );
    }

    // Fan out recipient rows.
    await db.insert(parentMessageRecipientsTable).values(
      recipients.map((r) => ({
        messageId: message.id,
        schoolId,
        recipientKey: r.recipientKey,
        parentId: r.parentId,
        email: r.email,
        studentIds: r.studentIds,
        deliveredPortal: r.deliveredPortal,
        deliveredEmail: emailNudge && !!r.email,
      })),
    );

    // Fire the email nudge (best-effort; one bad address must not abort).
    let emailsSent = 0;
    if (emailNudge) {
      const [school] = await db
        .select({ name: schoolsTable.name })
        .from(schoolsTable)
        .where(eq(schoolsTable.id, schoolId));
      const schoolName = school?.name ?? "Your school";
      const portalUrl = `${publicAppOrigin(req)}/parent`;
      const targets = recipients.filter((r) => !!r.email);
      try {
        const { client, fromEmail } = await getUncachableResendClient();
        for (const r of targets) {
          try {
            const result = await client.emails.send({
              from: fromEmail,
              to: r.email as string,
              subject: `${schoolName}: ${subject}`,
              text: [
                `${schoolName} sent a new Family Message:`,
                ``,
                subject,
                ``,
                `Sign in to your HeartBEAT Parent Portal to read it${
                  r.parentId ? ` and tap "Got it"` : ""
                }:`,
                portalUrl,
              ].join("\n"),
              html: `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f5f7fa;padding:24px;margin:0;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e6ebf1;">
    <tr><td style="background:linear-gradient(135deg,#0ea5a4 0%,#2563eb 100%);padding:22px 28px;">
      <div style="color:#fff;font-size:13px;letter-spacing:1.5px;text-transform:uppercase;opacity:.85;">PulseEDU · HeartBEAT</div>
      <div style="color:#fff;font-size:20px;font-weight:700;margin-top:6px;">New Family Message</div>
    </td></tr>
    <tr><td style="padding:24px 28px;color:#1f2937;font-size:15px;line-height:1.55;">
      <p style="margin:0 0 12px 0;"><strong>${escapeHtml(schoolName)}</strong> sent a new Family Message:</p>
      <p style="margin:0 0 18px 0;font-size:17px;font-weight:600;">${escapeHtml(subject)}</p>
      <p style="margin:0 0 22px 0;text-align:center;">
        <a href="${portalUrl}" style="display:inline-block;background:#0ea5a4;color:#fff;text-decoration:none;padding:12px 24px;border-radius:10px;font-weight:600;font-size:15px;">Open Parent Portal</a>
      </p>
      <p style="margin:0 0 6px 0;color:#6b7280;font-size:13px;">Or paste this link into your browser:</p>
      <p style="margin:0;word-break:break-all;color:#2563eb;font-size:13px;">${portalUrl}</p>
    </td></tr>
  </table>
</body></html>`,
            });
            if (!result.error) emailsSent += 1;
          } catch (err) {
            logger.warn(
              { err, messageId: message.id },
              "family message nudge send failed for one recipient",
            );
          }
        }
      } catch (err) {
        logger.warn(
          { err, messageId: message.id },
          "family message email nudge unavailable",
        );
      }
    }

    res.status(201).json({
      id: message.id,
      totalRecipients: recipients.length,
      reachedRecipients: reachedCount,
      emailsSent,
      unmatchedSisIds: resolved.unmatchedSisIds,
    });
  },
);

// GET /family-messages — list sent messages with live counters.
router.get(
  "/family-messages",
  requireStaff,
  requireFamilyMessenger,
  async (req: Request, res: Response) => {
    const schoolId = req.schoolId;
    if (!schoolId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const messages = await db
      .select()
      .from(parentMessagesTable)
      .where(eq(parentMessagesTable.schoolId, schoolId))
      .orderBy(desc(parentMessagesTable.createdAt));

    if (messages.length === 0) {
      res.json([]);
      return;
    }

    // Live "Got it" counts per message.
    const ackRows = await db
      .select({
        messageId: parentMessageRecipientsTable.messageId,
        acknowledged: sql<number>`count(*) filter (where ${parentMessageRecipientsTable.acknowledgedAt} is not null)`,
      })
      .from(parentMessageRecipientsTable)
      .where(eq(parentMessageRecipientsTable.schoolId, schoolId))
      .groupBy(parentMessageRecipientsTable.messageId);
    const ackByMessage = new Map<number, number>();
    for (const r of ackRows) ackByMessage.set(r.messageId, Number(r.acknowledged));

    const senderIds = Array.from(
      new Set(messages.map((m) => m.createdByStaffId)),
    );
    const senders = senderIds.length
      ? await db
          .select({ id: staffTable.id, displayName: staffTable.displayName })
          .from(staffTable)
          .where(inArray(staffTable.id, senderIds))
      : [];
    const senderById = new Map(senders.map((s) => [s.id, s.displayName]));

    const videoMeta = await loadVideoMeta(
      schoolId,
      messages.map((m) => m.videoId),
    );

    res.json(
      messages.map((m) => ({
        id: m.id,
        subject: m.subject,
        body: m.body,
        audienceType: m.audienceType,
        audienceGrades: m.audienceGrades ?? [],
        audienceHouseIds: m.audienceHouseIds ?? [],
        hasAttachment: !!m.attachmentObjectKey,
        attachmentName: m.attachmentName,
        attachmentType: m.attachmentType,
        emailNudge: m.emailNudge,
        videoId: m.videoId,
        video: m.videoId != null ? videoMeta.get(m.videoId) ?? null : null,
        totalRecipients: m.totalRecipients,
        reachedRecipients: m.reachedRecipients,
        acknowledgedRecipients: ackByMessage.get(m.id) ?? 0,
        senderName: senderById.get(m.createdByStaffId) ?? "Staff",
        createdAt: m.createdAt,
      })),
    );
  },
);

// GET /family-messages/:id — detail with the recipient table + Power Reader.
router.get(
  "/family-messages/:id",
  requireStaff,
  requireFamilyMessenger,
  async (req: Request, res: Response) => {
    const schoolId = req.schoolId;
    if (!schoolId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid message id" });
      return;
    }
    const [message] = await db
      .select()
      .from(parentMessagesTable)
      .where(
        and(
          eq(parentMessagesTable.id, id),
          eq(parentMessagesTable.schoolId, schoolId),
        ),
      );
    if (!message) {
      res.status(404).json({ error: "Message not found" });
      return;
    }

    const recipients = await db
      .select()
      .from(parentMessageRecipientsTable)
      .where(
        and(
          eq(parentMessageRecipientsTable.messageId, id),
          eq(parentMessageRecipientsTable.schoolId, schoolId),
        ),
      );

    // Display names for portal-account families.
    const parentIds = recipients
      .map((r) => r.parentId)
      .filter((p): p is number => p != null);
    const parents = parentIds.length
      ? await db
          .select({ id: parentsTable.id, displayName: parentsTable.displayName })
          .from(parentsTable)
          .where(inArray(parentsTable.id, parentIds))
      : [];
    const parentNameById = new Map(parents.map((p) => [p.id, p.displayName]));

    // Power Reader: compute each portal parent's lifetime ack ratio in one
    // grouped query, school-scoped.
    const powerStats = parentIds.length
      ? await db
          .select({
            parentId: parentMessageRecipientsTable.parentId,
            total: sql<number>`count(*)`,
            acknowledged: sql<number>`count(*) filter (where ${parentMessageRecipientsTable.acknowledgedAt} is not null)`,
          })
          .from(parentMessageRecipientsTable)
          .where(
            and(
              eq(parentMessageRecipientsTable.schoolId, schoolId),
              isNotNull(parentMessageRecipientsTable.parentId),
            ),
          )
          .groupBy(parentMessageRecipientsTable.parentId)
      : [];
    const powerByParent = new Map<number, boolean>();
    for (const s of powerStats) {
      if (s.parentId == null) continue;
      powerByParent.set(
        s.parentId,
        isPowerReader(Number(s.total), Number(s.acknowledged)),
      );
    }

    const acknowledgedRecipients = recipients.filter(
      (r) => r.acknowledgedAt != null,
    ).length;

    res.json({
      id: message.id,
      subject: message.subject,
      body: message.body,
      audienceType: message.audienceType,
      audienceGrades: message.audienceGrades ?? [],
      audienceHouseIds: message.audienceHouseIds ?? [],
      hasAttachment: !!message.attachmentObjectKey,
      attachmentName: message.attachmentName,
      attachmentType: message.attachmentType,
      emailNudge: message.emailNudge,
      videoId: message.videoId,
      video:
        message.videoId != null
          ? (await loadVideoMeta(schoolId, [message.videoId])).get(
              message.videoId,
            ) ?? null
          : null,
      totalRecipients: message.totalRecipients,
      reachedRecipients: message.reachedRecipients,
      acknowledgedRecipients,
      createdAt: message.createdAt,
      recipients: recipients.map((r) => ({
        id: r.id,
        name:
          r.parentId != null
            ? parentNameById.get(r.parentId) ?? "Parent"
            : r.email ?? "Family",
        hasAccount: r.parentId != null,
        email: r.email,
        deliveredPortal: r.deliveredPortal,
        deliveredEmail: r.deliveredEmail,
        acknowledgedAt: r.acknowledgedAt,
        isPowerReader:
          r.parentId != null
            ? powerByParent.get(r.parentId) ?? false
            : false,
        studentCount: r.studentIds.length,
      })),
    });
  },
);

// Shared: stream a message's attachment after the caller has been authorized.
async function streamMessageAttachment(
  message: typeof parentMessagesTable.$inferSelect,
  res: Response,
): Promise<void> {
  if (!message.attachmentObjectKey) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (message.attachmentType) {
    res.setHeader("Content-Type", message.attachmentType);
  }
  const ok = await streamObjectToResponse(message.attachmentObjectKey, res);
  if (!ok) res.status(404).json({ error: "Not found" });
}

// GET /family-messages/:id/attachment — staff in the owning school.
router.get(
  "/family-messages/:id/attachment",
  requireStaff,
  requireFamilyMessenger,
  async (req: Request, res: Response) => {
    const schoolId = req.schoolId;
    const id = Number(req.params.id);
    if (!schoolId || !Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }
    const [message] = await db
      .select()
      .from(parentMessagesTable)
      .where(
        and(
          eq(parentMessagesTable.id, id),
          eq(parentMessagesTable.schoolId, schoolId),
        ),
      );
    if (!message) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    await streamMessageAttachment(message, res);
  },
);

// =============================================================================
// Parent side — inbox, acknowledge, badge
// =============================================================================

// Resolve req.parentId from session or Bearer token (parent app sends a
// Bearer token because the iframe blocks the session cookie).
function resolveParentId(req: Request): number | null {
  let pid: number | null = req.session?.parentId ?? null;
  if (!pid) {
    const auth = req.headers.authorization;
    if (typeof auth === "string" && auth.startsWith("Bearer ")) {
      pid = verifyParentAuthToken(auth.slice(7).trim());
    }
  }
  return pid;
}

// Parents are school-scoped (parents.school_id). Resolve the authenticated
// parent's id AND their school so every parent read/write can carry an
// explicit school_id predicate — tenant isolation must not rely on parentId
// being globally unique. Returns null if the parent row is missing/inactive.
async function resolveParentContext(
  req: Request,
): Promise<{ pid: number; schoolId: number } | null> {
  const pid = resolveParentId(req);
  if (!pid) return null;
  const [row] = await db
    .select({ schoolId: parentsTable.schoolId })
    .from(parentsTable)
    .where(and(eq(parentsTable.id, pid), eq(parentsTable.active, true)));
  if (!row) return null;
  return { pid, schoolId: row.schoolId };
}

// GET /parent/messages — this parent's inbox + their Power Reader status.
router.get("/parent/messages", async (req: Request, res: Response) => {
  const ctx = await resolveParentContext(req);
  if (!ctx) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const { pid, schoolId } = ctx;

  const rows = await db
    .select({
      recipientId: parentMessageRecipientsTable.id,
      acknowledgedAt: parentMessageRecipientsTable.acknowledgedAt,
      messageId: parentMessagesTable.id,
      subject: parentMessagesTable.subject,
      body: parentMessagesTable.body,
      attachmentObjectKey: parentMessagesTable.attachmentObjectKey,
      attachmentName: parentMessagesTable.attachmentName,
      attachmentType: parentMessagesTable.attachmentType,
      videoId: parentMessagesTable.videoId,
      createdByStaffId: parentMessagesTable.createdByStaffId,
      createdAt: parentMessagesTable.createdAt,
    })
    .from(parentMessageRecipientsTable)
    .innerJoin(
      parentMessagesTable,
      eq(parentMessageRecipientsTable.messageId, parentMessagesTable.id),
    )
    .where(
      and(
        eq(parentMessageRecipientsTable.parentId, pid),
        eq(parentMessageRecipientsTable.schoolId, schoolId),
      ),
    )
    .orderBy(desc(parentMessagesTable.createdAt));

  const senderIds = Array.from(new Set(rows.map((r) => r.createdByStaffId)));
  const senders = senderIds.length
    ? await db
        .select({ id: staffTable.id, displayName: staffTable.displayName })
        .from(staffTable)
        .where(inArray(staffTable.id, senderIds))
    : [];
  const senderById = new Map(senders.map((s) => [s.id, s.displayName]));

  const total = rows.length;
  const acknowledged = rows.filter((r) => r.acknowledgedAt != null).length;

  const videoMeta = await loadVideoMeta(
    schoolId,
    rows.map((r) => r.videoId),
  );

  res.json({
    powerReader: isPowerReader(total, acknowledged),
    unreadCount: total - acknowledged,
    messages: rows.map((r) => ({
      id: r.messageId,
      subject: r.subject,
      body: r.body,
      hasAttachment: !!r.attachmentObjectKey,
      attachmentName: r.attachmentName,
      attachmentType: r.attachmentType,
      videoId: r.videoId,
      video:
        r.videoId != null && videoMeta.get(r.videoId)?.purged === false
          ? videoMeta.get(r.videoId) ?? null
          : null,
      senderName: senderById.get(r.createdByStaffId) ?? "School",
      acknowledgedAt: r.acknowledgedAt,
      createdAt: r.createdAt,
    })),
  });
});

// POST /parent/messages/:id/ack — explicit "Got it" tap. Idempotent.
router.post(
  "/parent/messages/:id/ack",
  async (req: Request, res: Response) => {
    const ctx = await resolveParentContext(req);
    if (!ctx) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    const { pid, schoolId } = ctx;
    const messageId = Number(req.params.id);
    if (!Number.isFinite(messageId)) {
      res.status(400).json({ error: "Invalid message id" });
      return;
    }
    const [row] = await db
      .select()
      .from(parentMessageRecipientsTable)
      .where(
        and(
          eq(parentMessageRecipientsTable.messageId, messageId),
          eq(parentMessageRecipientsTable.parentId, pid),
          eq(parentMessageRecipientsTable.schoolId, schoolId),
        ),
      );
    if (!row) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    // Idempotent: only stamp the first time so the timestamp is stable.
    if (!row.acknowledgedAt) {
      await db
        .update(parentMessageRecipientsTable)
        .set({ acknowledgedAt: new Date() })
        .where(eq(parentMessageRecipientsTable.id, row.id));
    }
    res.json({ ok: true, acknowledgedAt: row.acknowledgedAt ?? new Date() });
  },
);

// GET /parent/messages/:id/attachment — attachment for a parent recipient.
router.get(
  "/parent/messages/:id/attachment",
  async (req: Request, res: Response) => {
    const ctx = await resolveParentContext(req);
    if (!ctx) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    const { pid, schoolId } = ctx;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid message id" });
      return;
    }
    const [row] = await db
      .select({ id: parentMessageRecipientsTable.id })
      .from(parentMessageRecipientsTable)
      .where(
        and(
          eq(parentMessageRecipientsTable.messageId, id),
          eq(parentMessageRecipientsTable.parentId, pid),
          eq(parentMessageRecipientsTable.schoolId, schoolId),
        ),
      );
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const [message] = await db
      .select()
      .from(parentMessagesTable)
      .where(
        and(
          eq(parentMessagesTable.id, id),
          eq(parentMessagesTable.schoolId, schoolId),
        ),
      );
    if (!message) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    await streamMessageAttachment(message, res);
  },
);

// GET /parent/messages/:id/video?kind=mp4|audio — stream the attached PulseDNA
// video (or its audio-only track) for a parent recipient of this message.
router.get(
  "/parent/messages/:id/video",
  async (req: Request, res: Response) => {
    const ctx = await resolveParentContext(req);
    if (!ctx) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    const { pid, schoolId } = ctx;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid message id" });
      return;
    }
    const kind = req.query.kind === "audio" ? "audio" : "mp4";
    const [row] = await db
      .select({ id: parentMessageRecipientsTable.id })
      .from(parentMessageRecipientsTable)
      .where(
        and(
          eq(parentMessageRecipientsTable.messageId, id),
          eq(parentMessageRecipientsTable.parentId, pid),
          eq(parentMessageRecipientsTable.schoolId, schoolId),
        ),
      );
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const [message] = await db
      .select({ videoId: parentMessagesTable.videoId })
      .from(parentMessagesTable)
      .where(
        and(
          eq(parentMessagesTable.id, id),
          eq(parentMessagesTable.schoolId, schoolId),
        ),
      );
    if (!message || message.videoId == null) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const [video] = await db
      .select()
      .from(pulseDnaVideosTable)
      .where(
        and(
          eq(pulseDnaVideosTable.id, message.videoId),
          eq(pulseDnaVideosTable.schoolId, schoolId),
        ),
      );
    if (!video || video.status === "purged") {
      res.status(404).json({ error: "Video is no longer available" });
      return;
    }
    const objectKey =
      kind === "audio" ? video.audioObjectKey : video.mp4ObjectKey;
    if (!objectKey) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.setHeader("Content-Type", kind === "audio" ? "audio/mpeg" : "video/mp4");
    const ok = await streamObjectToResponse(objectKey, res);
    if (!ok) res.status(404).json({ error: "Not found" });
  },
);

export default router;
