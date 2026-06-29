// Weekly HeartBEAT email sender. Picks every (parent, student) row where the
// parent has opted in (`parent_heartbeat_prefs.weekly_email_enabled = true`),
// the school still allows it (`school_heartbeat_settings.allow_weekly_email`),
// and the parent has an active account with an email. For each, builds the
// same snapshot the parent dashboard renders, generates a PDF via the shared
// renderer, and sends it through Resend as an attachment.
//
// Idempotency: `parent_heartbeat_prefs.last_weekly_email_at` is stamped on
// each successful send. The cron skips rows whose stamp is within
// DEDUP_WINDOW_DAYS so a re-run on the same day cannot double-mail. A failed
// send leaves the stamp untouched so the next cron pass retries.
//
// SINGLE-RUNNER ASSUMPTION: This helper has no DB-backed run lock. It is
// safe under the current single-instance deployment (one api-server, one
// cron registration, node-cron does not start a second invocation while the
// first is in-flight). Before scaling horizontally OR adding any manual
// "send now" trigger that could overlap with the cron, add an advisory
// lock (`SELECT pg_try_advisory_lock(<key>)`) at the top of this function
// or claim each row with `FOR UPDATE SKIP LOCKED` — otherwise concurrent
// runs will read the same candidate set before stamps are written and
// double-mail every row.

import {
  db,
  parentsTable,
  parentHeartbeatPrefsTable,
  schoolHeartbeatSettingsTable,
  schoolSettingsTable,
  schoolsTable,
  studentsTable,
} from "@workspace/db";
import { and, eq, isNull, isNotNull, lt, or } from "drizzle-orm";
import { getUncachableResendClient } from "./resendClient.js";
import { buildParentSnapshot } from "./parentSnapshot.js";
import { renderSnapshotPdf } from "./parentSnapshotPdf.js";
import { logger } from "./logger.js";

export type WeeklyEmailStatus =
  | "sent"
  | "skipped_school_disallowed"
  | "skipped_tenant_mismatch"
  | "failed";

export type WeeklyEmailResult = {
  parentId: number;
  studentId: number;
  email: string | null;
  status: WeeklyEmailStatus;
  providerId?: string;
  errorMsg?: string;
};

// 6 not 7 to absorb a half-day clock drift if the cron runs slightly early.
const DEDUP_WINDOW_DAYS = 6;
// Resend free tier is 2/sec, standard 10/sec. 200ms = 5/sec — safe for both.
const SEND_THROTTLE_MS = 200;

function formatFromHeader(fromName: string, fromEmail: string): string {
  if (!fromName) return fromEmail;
  if (fromEmail.includes("<")) return fromEmail;
  const safeName = fromName.replace(/"/g, "'");
  return `${safeName} <${fromEmail}>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

type ResendClientBundle = Awaited<ReturnType<typeof getUncachableResendClient>>;

export async function sendWeeklyHeartbeatEmails(
  now: Date = new Date(),
): Promise<WeeklyEmailResult[]> {
  const cutoff = new Date(
    now.getTime() - DEDUP_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );

  // One query to pull every eligible (parent, student) tuple. Filters here
  // are the cheap ones (column-level boolean / null checks); per-school
  // allowance and per-row visibility are checked inside the loop.
  const candidates = await db
    .select({
      parentId: parentHeartbeatPrefsTable.parentId,
      studentIntId: parentHeartbeatPrefsTable.studentId,
      parentEmail: parentsTable.email,
      parentDisplayName: parentsTable.displayName,
      parentSchoolId: parentsTable.schoolId,
    })
    .from(parentHeartbeatPrefsTable)
    .innerJoin(
      parentsTable,
      eq(parentsTable.id, parentHeartbeatPrefsTable.parentId),
    )
    .where(
      and(
        eq(parentHeartbeatPrefsTable.weeklyEmailEnabled, true),
        eq(parentsTable.active, true),
        // Only parents who actually accepted their invite (set a password).
        isNotNull(parentsTable.passwordHash),
        or(
          isNull(parentHeartbeatPrefsTable.lastWeeklyEmailAt),
          lt(parentHeartbeatPrefsTable.lastWeeklyEmailAt, cutoff),
        ),
      ),
    );

  if (candidates.length === 0) return [];

  // Cache school-level lookups so we don't re-hit the DB once per parent.
  const schoolAllowCache = new Map<number, boolean>();
  const schoolBrandCache = new Map<
    number,
    { name: string; fromName: string }
  >();

  async function getSchoolAllow(schoolId: number): Promise<boolean> {
    const cached = schoolAllowCache.get(schoolId);
    if (cached !== undefined) return cached;
    const [row] = await db
      .select({ allow: schoolHeartbeatSettingsTable.allowWeeklyEmail })
      .from(schoolHeartbeatSettingsTable)
      .where(eq(schoolHeartbeatSettingsTable.schoolId, schoolId));
    // Default mirrors the schema default (true) for schools that haven't
    // had their heartbeat settings row materialized yet.
    const v = row?.allow ?? true;
    schoolAllowCache.set(schoolId, v);
    return v;
  }

  async function getSchoolBrand(
    schoolId: number,
  ): Promise<{ name: string; fromName: string }> {
    const cached = schoolBrandCache.get(schoolId);
    if (cached) return cached;
    const [school] = await db
      .select({ name: schoolsTable.name })
      .from(schoolsTable)
      .where(eq(schoolsTable.id, schoolId));
    const [settings] = await db
      .select({ fromName: schoolSettingsTable.fromName })
      .from(schoolSettingsTable)
      .where(eq(schoolSettingsTable.schoolId, schoolId));
    const out = {
      name: school?.name ?? "PulseEDU",
      fromName: (settings?.fromName ?? "").trim(),
    };
    schoolBrandCache.set(schoolId, out);
    return out;
  }

  // Initialize the Resend client once. If it throws (no API key, etc.) we
  // still produce per-row "failed" results so the cron log explains why
  // every row was skipped, rather than silently erroring out.
  let resend: ResendClientBundle | null = null;
  let resendInitError: string | null = null;
  try {
    resend = await getUncachableResendClient();
  } catch (e) {
    resendInitError = e instanceof Error ? e.message : String(e);
  }

  const results: WeeklyEmailResult[] = [];

  for (const c of candidates) {
    // Outer per-row try/catch is the last line of defense: any thrown
    // exception we forgot to catch inline (DB blip, OOM during render,
    // etc.) becomes a `failed` result for THIS row instead of aborting
    // the entire batch.
    try {
      const allow = await getSchoolAllow(c.parentSchoolId);
      if (!allow) {
        results.push({
          parentId: c.parentId,
          studentId: c.studentIntId,
          email: c.parentEmail,
          status: "skipped_school_disallowed",
        });
        continue;
      }

      if (!resend) {
        results.push({
          parentId: c.parentId,
          studentId: c.studentIntId,
          email: c.parentEmail,
          status: "failed",
          errorMsg: resendInitError ?? "Resend client unavailable",
        });
        continue;
      }

      // Tenant invariant: the parent's school must equal the student's
      // school. `parents.school_id` and `students.school_id` are both
      // tenant columns; if a bad cross-school link exists (data
      // corruption, bad import), we'd otherwise email school A's
      // branding around school B's data. Catching it here also stops
      // the snapshot build from leaking school B's content out to a
      // school A parent. Architect-flagged HIGH issue.
      const [studentRow] = await db
        .select({ schoolId: studentsTable.schoolId })
        .from(studentsTable)
        .where(eq(studentsTable.id, c.studentIntId));
      if (!studentRow) {
        results.push({
          parentId: c.parentId,
          studentId: c.studentIntId,
          email: c.parentEmail,
          status: "failed",
          errorMsg: "student row not found",
        });
        continue;
      }
      if (studentRow.schoolId !== c.parentSchoolId) {
        // Loud log — this is data corruption, not a normal skip.
        logger.error(
          {
            parentId: c.parentId,
            studentId: c.studentIntId,
            parentSchoolId: c.parentSchoolId,
            studentSchoolId: studentRow.schoolId,
          },
          "Weekly HeartBEAT email tenant mismatch — refusing to send",
        );
        results.push({
          parentId: c.parentId,
          studentId: c.studentIntId,
          email: c.parentEmail,
          status: "skipped_tenant_mismatch",
          errorMsg: `parent school ${c.parentSchoolId} != student school ${studentRow.schoolId}`,
        });
        continue;
      }

      // Build the snapshot. If it errors (e.g. the parent_students
      // link was removed since they opted in), record the failure
      // and move on.
      const snap = await buildParentSnapshot(c.parentId, c.studentIntId);
      if (!snap.ok) {
        results.push({
          parentId: c.parentId,
          studentId: c.studentIntId,
          email: c.parentEmail,
          status: "failed",
          errorMsg: `snapshot ${snap.status}: ${snap.error}`,
        });
        continue;
      }

      const brand = await getSchoolBrand(c.parentSchoolId);

      let pdf: Buffer;
      try {
        pdf = await renderSnapshotPdf(snap.data, { schoolName: brand.name });
      } catch (e) {
        results.push({
          parentId: c.parentId,
          studentId: c.studentIntId,
          email: c.parentEmail,
          status: "failed",
          errorMsg: `pdf render: ${e instanceof Error ? e.message : String(e)}`,
        });
        continue;
      }

      const studentFirst = snap.data.student.firstName;
      const studentLast = snap.data.student.lastName;
      const today = now.toISOString().slice(0, 10);
      const safeName =
        `${studentFirst}-${studentLast}`
          .replace(/[^A-Za-z0-9._-]+/g, "_")
          .slice(0, 80) || "snapshot";
      const filename = `HeartBEAT-${safeName}-${today}.pdf`;

      const subject = `Your weekly HeartBEAT update for ${studentFirst}`;
      const greetingName = c.parentDisplayName?.trim() || "";
      const greeting = greetingName ? `Hi ${greetingName},` : "Hi,";

      // Staff-authored, parent-facing note for this week (from the Student
      // Snapshot page). Surfaced inline above the PDF pointer when present.
      const heartbeatNote = (snap.data.student.heartbeatNote ?? "").trim();

      const textBody =
        `${greeting}\n\n` +
        `Here is this week's HeartBEAT update for ${studentFirst} ${studentLast} from ${brand.name}.\n\n` +
        (heartbeatNote
          ? `A message from your child's school:\n${heartbeatNote}\n\n`
          : "") +
        `The full report is attached as a PDF.\n\n` +
        `To stop these weekly emails, sign in to the parent portal and turn off "Weekly email" under "What I see".\n\n` +
        `— ${brand.name}\n`;

      const htmlBody =
        `<p>${escapeHtml(greeting)}</p>` +
        `<p>Here is this week's HeartBEAT update for <strong>${escapeHtml(
          `${studentFirst} ${studentLast}`,
        )}</strong> from ${escapeHtml(brand.name)}.</p>` +
        (heartbeatNote
          ? `<div style="margin:12px 0;padding:12px 16px;border-left:3px solid #6366f1;background:#f5f5ff;border-radius:6px;">` +
            `<div style="font-size:12px;font-weight:600;color:#6366f1;margin-bottom:4px;">A message from your child's school</div>` +
            `<div style="color:#222;white-space:pre-wrap;">${escapeHtml(heartbeatNote)}</div>` +
            `</div>`
          : "") +
        `<p>The full report is attached as a PDF.</p>` +
        `<p style="color:#666;font-size:12px;">To stop these weekly emails, sign in to the parent portal and turn off <em>Weekly email</em> under <em>What I see</em>.</p>` +
        `<p>— ${escapeHtml(brand.name)}</p>`;

      let providerId: string | undefined;
      let sendError: string | null = null;
      try {
        const result = await resend.client.emails.send({
          from: formatFromHeader(brand.fromName, resend.fromEmail),
          to: c.parentEmail,
          subject,
          text: textBody,
          html: htmlBody,
          attachments: [{ filename, content: pdf }],
        });
        if (result.error) {
          sendError = result.error.message ?? "Resend rejected the request.";
        } else {
          providerId = result.data?.id;
        }
      } catch (e) {
        sendError = e instanceof Error ? e.message : String(e);
      }

      if (sendError) {
        results.push({
          parentId: c.parentId,
          studentId: c.studentIntId,
          email: c.parentEmail,
          status: "failed",
          errorMsg: sendError,
        });
      } else {
        // Stamp the dedup window. The stamp itself is part of the
        // success contract — if we report `sent` without a durable
        // stamp, the next cron run will re-mail. Architect-flagged
        // HIGH issue. So a stamp failure flips the row to `failed`
        // with an explicit "EMAIL SENT but stamp failed" errorMsg
        // an operator can grep for and manually fix
        // (`UPDATE parent_heartbeat_prefs SET last_weekly_email_at
        // = NOW() WHERE parent_id=… AND student_id=…`).
        let stampError: string | null = null;
        try {
          await db
            .update(parentHeartbeatPrefsTable)
            .set({ lastWeeklyEmailAt: now })
            .where(
              and(
                eq(parentHeartbeatPrefsTable.parentId, c.parentId),
                eq(parentHeartbeatPrefsTable.studentId, c.studentIntId),
              ),
            );
        } catch (stampErr) {
          stampError =
            stampErr instanceof Error
              ? stampErr.message
              : String(stampErr);
          logger.error(
            {
              parentId: c.parentId,
              studentId: c.studentIntId,
              providerId,
              err: stampErr,
            },
            "Weekly HeartBEAT email SENT but stamp UPDATE failed — risk of duplicate next run",
          );
        }
        if (stampError) {
          results.push({
            parentId: c.parentId,
            studentId: c.studentIntId,
            email: c.parentEmail,
            status: "failed",
            providerId,
            errorMsg: `EMAIL SENT but stamp failed: ${stampError}`,
          });
        } else {
          results.push({
            parentId: c.parentId,
            studentId: c.studentIntId,
            email: c.parentEmail,
            status: "sent",
            providerId,
          });
        }
      }
    } catch (rowErr) {
      // Unexpected throw from anywhere in the row body. Log and
      // record a failure so the batch keeps going. Architect-flagged
      // medium follow-up.
      logger.error(
        {
          parentId: c.parentId,
          studentId: c.studentIntId,
          err: rowErr,
        },
        "Weekly HeartBEAT email row threw unexpectedly",
      );
      results.push({
        parentId: c.parentId,
        studentId: c.studentIntId,
        email: c.parentEmail,
        status: "failed",
        errorMsg:
          rowErr instanceof Error ? rowErr.message : String(rowErr),
      });
    }

    // Throttle between iterations regardless of outcome. We don't
    // want a burst of 5xxs to retry-storm the provider either.
    await new Promise((r) => setTimeout(r, SEND_THROTTLE_MS));
  }

  return results;
}
