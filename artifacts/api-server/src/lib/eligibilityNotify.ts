import {
  db,
  schoolsTable,
  staffTable,
  eligibilityActivityCoachesTable,
  eligibilityNotificationsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { getUncachableResendClient } from "./resendClient.js";
import { logger } from "./logger.js";
import { isParentNotifyEnabled } from "./parentNotify.js";
import {
  loadEligibilitySettings,
  loadActiveMembers,
  buildEligibilityMap,
  type EligibilitySettings,
  type EligibilityStatus,
} from "./eligibility.js";

// =============================================================================
// Eligibility Hub — notifications.
//
//   notifyEligibilityUpload  fires after each daily attendance upload. Per the
//     locked spec it re-notifies EVERY student currently in the warning or
//     ineligible zone (which also covers the "on threshold crossing" case).
//     One combined parent message per student lists all of that student's
//     activities + status. Recipients: parents, the coaches of each activity,
//     the principal (warning+), and — when districtAdNotify is on — the
//     district Athletic Director(s).
//
//   sendEligibilityWeeklyDigest  per-school weekly roll-up to managers / AD.
//
// SMS is stubbed: we record a notification row with channel='sms',
// status='stubbed' and log it, so the wiring is in place for a real provider.
// Every send (or stub/failure) is recorded in eligibility_notifications for
// auditability.
// =============================================================================

const SMS_ENABLED = false; // Real SMS provider not wired yet — stub only.

function emailFrom(fromEmail: string): string {
  return `PulseEDU Eligibility <${fromEmail}>`;
}

async function recordNotification(opts: {
  schoolId: number;
  studentId: string;
  semesterLabel: string;
  kind: "warning" | "ineligible" | "digest";
  channel: "email" | "sms";
  audience: "parent" | "coach" | "principal" | "district_ad";
  recipient: string | null;
  status: "sent" | "stubbed" | "failed" | "skipped";
  countedAbsences: number | null;
}): Promise<void> {
  await db.insert(eligibilityNotificationsTable).values(opts);
}

// Send one email and record the outcome. Never throws.
async function sendEmail(
  to: string,
  subject: string,
  html: string,
  audit: {
    schoolId: number;
    studentId: string;
    semesterLabel: string;
    kind: "warning" | "ineligible" | "digest";
    audience: "parent" | "coach" | "principal" | "district_ad";
    countedAbsences: number | null;
  },
): Promise<boolean> {
  try {
    const { client, fromEmail } = await getUncachableResendClient();
    await client.emails.send({
      from: emailFrom(fromEmail),
      to,
      subject,
      html,
    });
    await recordNotification({
      ...audit,
      channel: "email",
      recipient: to,
      status: "sent",
    });
    return true;
  } catch (err) {
    logger.error({ err, to }, "Eligibility email send failed");
    await recordNotification({
      ...audit,
      channel: "email",
      recipient: to,
      status: "failed",
    });
    return false;
  }
}

// Stub: log + audit only. No real SMS provider yet.
async function stubSms(
  phone: string,
  audit: {
    schoolId: number;
    studentId: string;
    semesterLabel: string;
    kind: "warning" | "ineligible";
    audience: "parent";
    countedAbsences: number | null;
  },
): Promise<void> {
  logger.info(
    { phone, kind: audit.kind, studentId: audit.studentId },
    "Eligibility SMS (stubbed — no provider wired)",
  );
  await recordNotification({
    ...audit,
    channel: "sms",
    recipient: phone,
    status: SMS_ENABLED ? "sent" : "stubbed",
  });
}

function statusLabel(s: EligibilityStatus): string {
  return s === "ineligible" ? "Ineligible" : "At risk (warning)";
}

interface PerStudentNotice {
  studentId: string;
  name: string;
  parentName: string | null;
  parentEmail: string | null;
  status: EligibilityStatus;
  countedAbsences: number;
  notesLeft: number;
  activities: { activityId: number; activityName: string }[];
}

// Build per-student notices for everyone currently at risk in a school.
async function buildNotices(
  schoolId: number,
  settings: EligibilitySettings,
): Promise<PerStudentNotice[]> {
  const members = await loadActiveMembers(schoolId);
  const map = await buildEligibilityMap(
    schoolId,
    settings.semesterLabel,
    members.map((m) => m.studentId),
    settings,
  );
  const byStudent = new Map<string, PerStudentNotice>();
  for (const m of members) {
    const e = map.get(m.studentId);
    if (!e || e.status === "ok") continue;
    const existing = byStudent.get(m.studentId);
    if (existing) {
      existing.activities.push({
        activityId: m.activityId,
        activityName: m.activityName,
      });
    } else {
      byStudent.set(m.studentId, {
        studentId: m.studentId,
        name: `${e.firstName} ${e.lastName}`.trim(),
        parentName: e.parentName,
        parentEmail: e.parentEmail,
        status: e.status,
        countedAbsences: e.countedAbsences,
        notesLeft: e.notesLeft,
        activities: [
          { activityId: m.activityId, activityName: m.activityName },
        ],
      });
    }
  }
  return Array.from(byStudent.values());
}

export async function notifyEligibilityUpload(
  schoolId: number,
  _uploadId: number,
): Promise<number> {
  const settings = await loadEligibilitySettings(schoolId);
  const notices = await buildNotices(schoolId, settings);
  if (notices.length === 0) return 0;

  // Parent Notifications panel — master switch for parent-facing eligibility
  // emails. Coach/principal/AD copies and the staff weekly digest are NOT
  // gated by this (it is a PARENT toggle).
  const parentNotifyOn = await isParentNotifyEnabled(
    schoolId,
    "notifyParentEligibility",
  );

  // Coaches per activity.
  const coachRows = await db
    .select({
      activityId: eligibilityActivityCoachesTable.activityId,
      email: staffTable.email,
      name: staffTable.displayName,
    })
    .from(eligibilityActivityCoachesTable)
    .innerJoin(
      staffTable,
      eq(eligibilityActivityCoachesTable.staffId, staffTable.id),
    )
    .where(eq(eligibilityActivityCoachesTable.schoolId, schoolId));
  const coachesByActivity = new Map<number, { email: string; name: string }[]>();
  for (const c of coachRows) {
    const list = coachesByActivity.get(c.activityId) ?? [];
    if (c.email) list.push({ email: c.email, name: c.name });
    coachesByActivity.set(c.activityId, list);
  }

  // Principals (admins) at this school.
  const principals = await db
    .select({ email: staffTable.email })
    .from(staffTable)
    .where(
      and(
        eq(staffTable.schoolId, schoolId),
        eq(staffTable.isAdmin, true),
        eq(staffTable.active, true),
      ),
    );

  // District ADs (optional).
  let districtAdEmails: string[] = [];
  if (settings.districtAdNotify) {
    const ads = await db
      .select({ email: staffTable.email })
      .from(staffTable)
      .where(
        and(
          // School-scoped: never email another tenant's Athletic Director.
          eq(staffTable.schoolId, schoolId),
          eq(staffTable.isAthleticDirector, true),
          eq(staffTable.active, true),
        ),
      );
    districtAdEmails = ads.map((a) => a.email).filter(Boolean);
  }

  let sent = 0;
  for (const n of notices) {
    const kind = n.status === "ineligible" ? "ineligible" : "warning";
    const activityNames = n.activities.map((a) => a.activityName).join(", ");
    const html = `
      <div style="font-family:system-ui,sans-serif;color:#111827">
        <h2 style="color:${n.status === "ineligible" ? "#b91c1c" : "#b45309"}">
          Participation Eligibility Notice — ${statusLabel(n.status)}
        </h2>
        <p>Dear ${n.parentName ?? "Parent/Guardian"},</p>
        <p>
          This is an attendance-based eligibility update for
          <strong>${n.name}</strong>, who participates in:
          <strong>${activityNames}</strong>.
        </p>
        <ul>
          <li>Counted absences this semester (${settings.semesterLabel}):
            <strong>${n.countedAbsences}</strong></li>
          <li>Ineligibility threshold: <strong>${settings.threshold}</strong></li>
          <li>Status: <strong>${statusLabel(n.status)}</strong></li>
        </ul>
        <p>
          If any of these absences should be excused, please contact the front
          office. Excused (parent-note) absences reduce the counted total, up
          to ${settings.parentNoteCap} per semester.
        </p>
        <p style="color:#6b7280;font-size:12px">
          Sent automatically by PulseEDU Eligibility Hub.
        </p>
      </div>`;

    // Parent (one combined message).
    if (n.parentEmail && parentNotifyOn) {
      const ok = await sendEmail(
        n.parentEmail,
        `Eligibility ${statusLabel(n.status)}: ${n.name}`,
        html,
        {
          schoolId,
          studentId: n.studentId,
          semesterLabel: settings.semesterLabel,
          kind,
          audience: "parent",
          countedAbsences: n.countedAbsences,
        },
      );
      if (ok) sent += 1;
    }

    // Coaches of each activity the student is on.
    const coachEmails = new Set<string>();
    for (const a of n.activities) {
      for (const c of coachesByActivity.get(a.activityId) ?? []) {
        coachEmails.add(c.email);
      }
    }
    for (const ce of coachEmails) {
      await sendEmail(
        ce,
        `Eligibility ${statusLabel(n.status)}: ${n.name} (${activityNames})`,
        html,
        {
          schoolId,
          studentId: n.studentId,
          semesterLabel: settings.semesterLabel,
          kind,
          audience: "coach",
          countedAbsences: n.countedAbsences,
        },
      );
    }

    // Principal — warning+ (i.e. every at-risk notice).
    for (const p of principals) {
      if (!p.email) continue;
      await sendEmail(
        p.email,
        `Eligibility ${statusLabel(n.status)}: ${n.name}`,
        html,
        {
          schoolId,
          studentId: n.studentId,
          semesterLabel: settings.semesterLabel,
          kind,
          audience: "principal",
          countedAbsences: n.countedAbsences,
        },
      );
    }

    // District AD (optional).
    for (const ad of districtAdEmails) {
      await sendEmail(
        ad,
        `Eligibility ${statusLabel(n.status)}: ${n.name}`,
        html,
        {
          schoolId,
          studentId: n.studentId,
          semesterLabel: settings.semesterLabel,
          kind,
          audience: "district_ad",
          countedAbsences: n.countedAbsences,
        },
      );
    }

    // Parent SMS (stubbed).
    if (n.parentEmail === null && false) {
      // placeholder — no phone path yet
    }
    const parentPhone = null as string | null;
    if (parentPhone) {
      await stubSms(parentPhone, {
        schoolId,
        studentId: n.studentId,
        semesterLabel: settings.semesterLabel,
        kind,
        audience: "parent",
        countedAbsences: n.countedAbsences,
      });
    }
  }
  return sent;
}

export interface WeeklyDigestResult {
  schoolId: number;
  status: "sent" | "skipped" | "error";
  recipients: number;
  atRiskCount: number;
  errorMsg: string | null;
}

export async function sendEligibilityWeeklyDigest(
  _now: Date = new Date(),
): Promise<WeeklyDigestResult[]> {
  const schools = await db.select({ id: schoolsTable.id }).from(schoolsTable);
  const results: WeeklyDigestResult[] = [];
  for (const school of schools) {
    try {
      const settings = await loadEligibilitySettings(school.id);
      const notices = await buildNotices(school.id, settings);
      // Recipients: admins + athletic directors at this school.
      const managers = await db
        .select({
          email: staffTable.email,
          isAdmin: staffTable.isAdmin,
          isAd: staffTable.isAthleticDirector,
        })
        .from(staffTable)
        .where(
          and(
            eq(staffTable.schoolId, school.id),
            eq(staffTable.active, true),
          ),
        );
      const to = managers
        .filter((m) => m.isAdmin || m.isAd)
        .map((m) => m.email)
        .filter(Boolean);
      if (to.length === 0 || notices.length === 0) {
        results.push({
          schoolId: school.id,
          status: "skipped",
          recipients: to.length,
          atRiskCount: notices.length,
          errorMsg: null,
        });
        continue;
      }
      const rows = notices
        .sort((a, b) => b.countedAbsences - a.countedAbsences)
        .map(
          (n) =>
            `<tr>
              <td style="padding:4px 8px">${n.name}</td>
              <td style="padding:4px 8px">${n.activities.map((a) => a.activityName).join(", ")}</td>
              <td style="padding:4px 8px;text-align:center">${n.countedAbsences}</td>
              <td style="padding:4px 8px">${statusLabel(n.status)}</td>
            </tr>`,
        )
        .join("");
      const html = `
        <div style="font-family:system-ui,sans-serif;color:#111827">
          <h2>Weekly Eligibility Digest — ${settings.semesterLabel}</h2>
          <p>${notices.length} student(s) are currently at risk
            (threshold ${settings.threshold}).</p>
          <table style="border-collapse:collapse;font-size:14px">
            <thead><tr style="background:#f3f4f6">
              <th style="padding:4px 8px;text-align:left">Student</th>
              <th style="padding:4px 8px;text-align:left">Activities</th>
              <th style="padding:4px 8px">Days Absent</th>
              <th style="padding:4px 8px;text-align:left">Status</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
      const { client, fromEmail } = await getUncachableResendClient();
      await client.emails.send({
        from: emailFrom(fromEmail),
        to,
        subject: `Weekly Eligibility Digest — ${notices.length} at risk`,
        html,
      });
      for (const n of notices) {
        await recordNotification({
          schoolId: school.id,
          studentId: n.studentId,
          semesterLabel: settings.semesterLabel,
          kind: "digest",
          channel: "email",
          audience: "principal",
          recipient: to.join(","),
          status: "sent",
          countedAbsences: n.countedAbsences,
        });
      }
      results.push({
        schoolId: school.id,
        status: "sent",
        recipients: to.length,
        atRiskCount: notices.length,
        errorMsg: null,
      });
    } catch (err) {
      logger.error({ err, schoolId: school.id }, "Eligibility digest failed");
      results.push({
        schoolId: school.id,
        status: "error",
        recipients: 0,
        atRiskCount: 0,
        errorMsg: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}
