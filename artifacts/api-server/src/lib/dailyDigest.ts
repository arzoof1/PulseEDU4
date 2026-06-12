import {
  db,
  pulloutsTable,
  schoolSettingsTable,
  schoolsTable,
  staffTable,
  studentsTable,
} from "@workspace/db";
import { and, eq, gte, lt, or, isNull, inArray } from "drizzle-orm";
import { getUncachableResendClient } from "./resendClient";

export type DailyDigestResult = {
  schoolId: number;
  status: "sent" | "skipped" | "error";
  emailTo: string | null;
  errorMsg: string | null;
  windowStart: string;
  windowEnd: string;
  totals: {
    requested: number;
    pending: number;
    verified: number;
    arrived: number;
    returned: number;
    closed: number;
    rejected: number;
    unreviewedClosedBacklog: number;
  };
  topStudents: { studentId: string; localSisId: string | null; count: number }[];
  topReasons: { reason: string; count: number }[];
};

function dayWindow(d: Date): { startIso: string; endIso: string } {
  const start = new Date(d);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

function tally<T>(rows: T[], pick: (r: T) => string | null | undefined) {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = pick(r);
    if (!k) continue;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return Array.from(m.entries())
    .map(([k, count]) => ({ key: k, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Build the daily digest payload for a single school + calendar day.
 * Pure read — does not send. Useful for previews and tests.
 *
 * D5 follow-up: requires schoolId so school A's digest never includes
 * school B's pullouts or backlog.
 */
export async function buildDailyDigest(
  forDay: Date = new Date(),
  schoolId: number,
) {
  const { startIso, endIso } = dayWindow(forDay);

  // Pullouts requested today, scoped to this school.
  const todays = await db
    .select()
    .from(pulloutsTable)
    .where(
      and(
        eq(pulloutsTable.schoolId, schoolId),
        gte(pulloutsTable.requestedAt, startIso),
        lt(pulloutsTable.requestedAt, endIso),
      ),
    );

  // Unreviewed-closed backlog (any age), scoped to this school.
  const backlog = await db
    .select({ id: pulloutsTable.id })
    .from(pulloutsTable)
    .where(
      and(
        eq(pulloutsTable.schoolId, schoolId),
        eq(pulloutsTable.status, "closed"),
        isNull(pulloutsTable.reviewedAt),
      ),
    );

  const totals = {
    requested: todays.length,
    pending: todays.filter((p) => p.status === "pending").length,
    verified: todays.filter((p) => p.status === "verified").length,
    arrived: todays.filter((p) => p.status === "arrived").length,
    returned: todays.filter((p) => p.status === "returned").length,
    closed: todays.filter((p) => p.status === "closed").length,
    rejected: todays.filter((p) => p.status === "rejected").length,
    unreviewedClosedBacklog: backlog.length,
  };

  const topStudentTally = tally(todays, (p) => p.studentId).slice(0, 5);
  const topStudentIds = topStudentTally.map((x) => x.key);
  const localBySid = new Map<string, string | null>();
  if (topStudentIds.length > 0) {
    const stu = await db
      .select({
        studentId: studentsTable.studentId,
        localSisId: studentsTable.localSisId,
      })
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.schoolId, schoolId),
          inArray(studentsTable.studentId, topStudentIds),
        ),
      );
    for (const s of stu) localBySid.set(s.studentId, s.localSisId);
  }
  const topStudents = topStudentTally.map((x) => ({
    studentId: x.key,
    localSisId: localBySid.get(x.key) ?? null,
    count: x.count,
  }));
  const topReasons = tally(todays, (p) =>
    (p.editedReason ?? p.reason)?.trim().toLowerCase().slice(0, 60),
  )
    .slice(0, 5)
    .map((x) => ({ reason: x.key, count: x.count }));

  return { startIso, endIso, totals, topStudents, topReasons, todays };
}

/**
 * Send the daily pullout digest for a single school. Recipients are
 * active admin / dean / MTSS staff in THAT school. Branding (school
 * name, from-name) comes from that school's school_settings row.
 *
 * Returns one DailyDigestResult.
 */
export async function sendDailyDigestEmailForSchool(
  forDay: Date,
  schoolId: number,
): Promise<DailyDigestResult> {
  const digest = await buildDailyDigest(forDay, schoolId);
  const { startIso, endIso, totals, topStudents, topReasons } = digest;

  const staffRows = await db
    .select()
    .from(staffTable)
    .where(
      and(
        eq(staffTable.schoolId, schoolId),
        eq(staffTable.active, true),
        or(
          eq(staffTable.isAdmin, true),
          eq(staffTable.isDean, true),
          eq(staffTable.isMtssCoordinator, true),
        ),
      ),
    );
  const recipients = staffRows
    .map((s) => s.email?.trim())
    .filter((e): e is string => !!e);

  if (recipients.length === 0) {
    return {
      schoolId,
      status: "skipped",
      emailTo: null,
      errorMsg: "No digest recipients configured",
      windowStart: startIso,
      windowEnd: endIso,
      totals,
      topStudents,
      topReasons,
    };
  }

  const [settings] = await db
    .select()
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, schoolId));
  const schoolName = settings?.schoolName ?? "PulseED";
  const fromName = settings?.fromName ?? schoolName;

  const dayLabel = new Date(startIso).toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  const subject = `[${schoolName}] Daily pullout digest — ${dayLabel}`;
  const lines: string[] = [];
  lines.push(`Pullout activity for ${dayLabel}:`);
  lines.push("");
  lines.push(`  Requested today:        ${totals.requested}`);
  lines.push(`    pending verification: ${totals.pending}`);
  lines.push(`    verified:             ${totals.verified}`);
  lines.push(`    arrived in ISS:       ${totals.arrived}`);
  lines.push(`    returned to class:    ${totals.returned}`);
  lines.push(`    closed:               ${totals.closed}`);
  lines.push(`    rejected:             ${totals.rejected}`);
  lines.push("");
  lines.push(
    `Unreviewed-closed backlog (all time): ${totals.unreviewedClosedBacklog}`,
  );
  if (topStudents.length > 0) {
    lines.push("");
    lines.push("Top students today:");
    for (const s of topStudents) {
      lines.push(`  ${s.localSisId ?? "—"} — ${s.count}`);
    }
  }
  if (topReasons.length > 0) {
    lines.push("");
    lines.push("Top reasons today:");
    for (const r of topReasons) {
      lines.push(`  "${r.reason}" — ${r.count}`);
    }
  }
  lines.push("");
  lines.push(`Open PulseED → ISS Dashboard for live status.`);
  const body = lines.join("\n");

  const html =
    `<h2>Pullout activity for ${dayLabel}</h2>` +
    `<table cellpadding="4" style="border-collapse:collapse">` +
    `<tr><td>Requested today</td><td><strong>${totals.requested}</strong></td></tr>` +
    `<tr><td>&nbsp;&nbsp;pending verification</td><td>${totals.pending}</td></tr>` +
    `<tr><td>&nbsp;&nbsp;verified</td><td>${totals.verified}</td></tr>` +
    `<tr><td>&nbsp;&nbsp;arrived in ISS</td><td>${totals.arrived}</td></tr>` +
    `<tr><td>&nbsp;&nbsp;returned to class</td><td>${totals.returned}</td></tr>` +
    `<tr><td>&nbsp;&nbsp;closed</td><td>${totals.closed}</td></tr>` +
    `<tr><td>&nbsp;&nbsp;rejected</td><td>${totals.rejected}</td></tr>` +
    `<tr><td>Unreviewed-closed backlog</td><td><strong>${totals.unreviewedClosedBacklog}</strong></td></tr>` +
    `</table>` +
    (topStudents.length
      ? `<h3>Top students today</h3><ul>${topStudents
          .map((s) => `<li>${s.localSisId ?? "—"} — ${s.count}</li>`)
          .join("")}</ul>`
      : "") +
    (topReasons.length
      ? `<h3>Top reasons today</h3><ul>${topReasons
          .map((r) => `<li>"${r.reason}" — ${r.count}</li>`)
          .join("")}</ul>`
      : "") +
    `<p>Open PulseED → <em>ISS Dashboard</em> for live status.</p>`;

  const recipientStr = recipients.join(", ");
  try {
    const { client, fromEmail } = await getUncachableResendClient();
    const fromHeader = `${fromName} <${fromEmail}>`;
    const sendRes = await client.emails.send({
      from: fromHeader,
      to: recipients,
      subject,
      text: body,
      html,
    });
    if (sendRes.error) {
      throw new Error(sendRes.error.message ?? "Resend error");
    }
    return {
      schoolId,
      status: "sent",
      emailTo: recipientStr,
      errorMsg: null,
      windowStart: startIso,
      windowEnd: endIso,
      totals,
      topStudents,
      topReasons,
    };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    return {
      schoolId,
      status: "error",
      emailTo: recipientStr,
      errorMsg: errMsg,
      windowStart: startIso,
      windowEnd: endIso,
      totals,
      topStudents,
      topReasons,
    };
  }
}

/**
 * Cron entry point: send a per-school digest to every school that has at
 * least one configured digest recipient. Schools with no admin/dean/MTSS
 * staff are skipped silently (was: iterated and returned "skipped" for
 * every empty school, which created 96 wasted iterations once Pasco was
 * onboarded with no staff). Returns one result per school iterated.
 */
export async function sendDailyDigestEmail(
  forDay: Date = new Date(),
): Promise<DailyDigestResult[]> {
  // Distinct schoolIds that have at least one active admin/dean/MTSS
  // staff with a non-empty email. Anything else can't receive a digest.
  const recipientSchoolRows = await db
    .selectDistinct({ id: staffTable.schoolId })
    .from(staffTable)
    .where(
      and(
        eq(staffTable.active, true),
        or(
          eq(staffTable.isAdmin, true),
          eq(staffTable.isDean, true),
          eq(staffTable.isMtssCoordinator, true),
        ),
      ),
    );
  const schoolIds = recipientSchoolRows
    .map((r) => r.id)
    .filter((id): id is number => typeof id === "number");
  // Order matches the prior behavior (ascending school id) for log
  // readability.
  schoolIds.sort((a, b) => a - b);

  const results: DailyDigestResult[] = [];
  for (const sid of schoolIds) {
    const s = { id: sid };
    try {
      const r = await sendDailyDigestEmailForSchool(forDay, s.id);
      results.push(r);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      const { startIso, endIso } = dayWindow(forDay);
      results.push({
        schoolId: s.id,
        status: "error",
        emailTo: null,
        errorMsg: errMsg,
        windowStart: startIso,
        windowEnd: endIso,
        totals: {
          requested: 0,
          pending: 0,
          verified: 0,
          arrived: 0,
          returned: 0,
          closed: 0,
          rejected: 0,
          unreviewedClosedBacklog: 0,
        },
        topStudents: [],
        topReasons: [],
      });
    }
  }
  return results;
}
