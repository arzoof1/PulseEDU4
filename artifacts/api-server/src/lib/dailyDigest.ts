import {
  db,
  pulloutsTable,
  schoolSettingsTable,
  staffTable,
} from "@workspace/db";
import { and, eq, gte, lt, or, isNull } from "drizzle-orm";
import { getUncachableResendClient } from "./resendClient";

export type DailyDigestResult = {
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
  topStudents: { studentId: string; count: number }[];
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
 * Build the daily digest payload for the given calendar day. Pure read —
 * does not send. Useful for previews and tests.
 */
export async function buildDailyDigest(forDay: Date = new Date()) {
  const { startIso, endIso } = dayWindow(forDay);

  // Pullouts requested today.
  const todays = await db
    .select()
    .from(pulloutsTable)
    .where(
      and(
        gte(pulloutsTable.requestedAt, startIso),
        lt(pulloutsTable.requestedAt, endIso),
      ),
    );

  // Unreviewed-closed backlog (any age).
  const backlog = await db
    .select({ id: pulloutsTable.id })
    .from(pulloutsTable)
    .where(
      and(eq(pulloutsTable.status, "closed"), isNull(pulloutsTable.reviewedAt)),
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

  const topStudents = tally(todays, (p) => p.studentId)
    .slice(0, 5)
    .map((x) => ({ studentId: x.key, count: x.count }));
  const topReasons = tally(todays, (p) =>
    (p.editedReason ?? p.reason)?.trim().toLowerCase().slice(0, 60),
  )
    .slice(0, 5)
    .map((x) => ({ reason: x.key, count: x.count }));

  return { startIso, endIso, totals, topStudents, topReasons, todays };
}

/**
 * Send the daily pullout digest to all active dispatcher staff
 * (admin / dean / MTSS). Returns an audit record.
 */
export async function sendDailyDigestEmail(
  forDay: Date = new Date(),
): Promise<DailyDigestResult> {
  const digest = await buildDailyDigest(forDay);
  const { startIso, endIso, totals, topStudents, topReasons } = digest;

  const staffRows = await db
    .select()
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
  const recipients = staffRows
    .map((s) => s.email?.trim())
    .filter((e): e is string => !!e);

  if (recipients.length === 0) {
    return {
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

  const [settings] = await db.select().from(schoolSettingsTable);
  const schoolName = settings?.schoolName ?? "PulseEDU";
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
      lines.push(`  ${s.studentId} — ${s.count}`);
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
  lines.push(`Open PulseEDU → ISS Dashboard for live status.`);
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
          .map((s) => `<li>${s.studentId} — ${s.count}</li>`)
          .join("")}</ul>`
      : "") +
    (topReasons.length
      ? `<h3>Top reasons today</h3><ul>${topReasons
          .map((r) => `<li>"${r.reason}" — ${r.count}</li>`)
          .join("")}</ul>`
      : "") +
    `<p>Open PulseEDU → <em>ISS Dashboard</em> for live status.</p>`;

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
