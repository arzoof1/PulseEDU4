// Email templates + send helpers for the dormant Tier 2 / Tier 3
// reminder system. All sends route through a thin `maybeSend` wrapper
// that respects EMAIL_REMINDERS_ENABLED so that until the
// hcsb.k12.fl.us sender domain is verified the system runs purely as a
// preview / dry-run system.
//
// Anatomy of a reminder:
//   1. Morning-after Tier 2 digest (per teacher)   — daily 7am
//   2. Tier 3 weekly load digest    (per teacher)  — Monday 7am
//   3. Core-Team weekly summary                    — Friday 2pm
//
// All templates render to plain HTML strings so that the
// /admin/email-preview/<type> debug route can serve them inline. Real
// payloads (lists of owed students, plan counts, etc.) are pulled by
// the scheduler in lib/scheduler.ts before invoking these templates.
import type { Resend } from "resend";
import { logger } from "../logger.js";

export type EmailReminderType =
  | "tier2-morning"
  | "tier3-weekly-load"
  | "core-team-friday";

export interface OwedStudentSnapshot {
  studentName: string;
  tier: 2 | 3;
  reason: string;
}

export interface CoreTeamRowSnapshot {
  studentName: string;
  tier: 2 | 3;
  completed: number;
  expected: number;
  teacherCount: number;
}

export interface TemplateContext {
  recipientName: string;
  schoolName: string;
  asOfDate: string; // ISO YYYY-MM-DD
}

/* ------------------------------------------------------------------ */
/*  Templates                                                          */
/* ------------------------------------------------------------------ */

function shell(title: string, body: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"/><title>${escape(title)}</title></head>
<body style="font-family: system-ui, sans-serif; color: #1e293b;">
  ${body}
  <hr style="margin: 1.5rem 0; border: none; border-top: 1px solid #e2e8f0;"/>
  <p style="font-size: 12px; color: #64748b;">
    PulseEDU · automated reminder. To unsubscribe, contact your school's MTSS coordinator.
  </p>
</body></html>`;
}
function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderTier2Morning(
  ctx: TemplateContext,
  owed: OwedStudentSnapshot[],
): { subject: string; html: string } {
  const tier2 = owed.filter((o) => o.tier === 2);
  const subject = `[${ctx.schoolName}] You have ${tier2.length} Tier 2 log${tier2.length === 1 ? "" : "s"} owed today`;
  const list = tier2.length
    ? `<ul>${tier2
        .map(
          (o) =>
            `<li><strong>${escape(o.studentName)}</strong> — ${escape(o.reason)}</li>`,
        )
        .join("")}</ul>`
    : `<p>You're caught up — no Tier 2 logs are owed today.</p>`;
  return {
    subject,
    html: shell(
      subject,
      `<h2>Good morning, ${escape(ctx.recipientName)}</h2>
       <p>Here's your Tier 2 reminder for ${escape(ctx.asOfDate)}:</p>
       ${list}`,
    ),
  };
}

export function renderTier3WeeklyLoad(
  ctx: TemplateContext,
  owed: OwedStudentSnapshot[],
): { subject: string; html: string } {
  const tier3 = owed.filter((o) => o.tier === 3);
  const subject = `[${ctx.schoolName}] Your Tier 3 weekly tracking load`;
  const list = tier3.length
    ? `<ul>${tier3
        .map(
          (o) => `<li><strong>${escape(o.studentName)}</strong></li>`,
        )
        .join("")}</ul>`
    : `<p>You have no Tier 3 students assigned for tracking this week.</p>`;
  return {
    subject,
    html: shell(
      subject,
      `<h2>Tier 3 weekly tracking — week of ${escape(ctx.asOfDate)}</h2>
       <p>${escape(ctx.recipientName)}, you are responsible for the following Tier 3 weekly tracking sheets:</p>
       ${list}
       <p>Remember to score each day Mon–Fri and add an end-of-week comment.</p>`,
    ),
  };
}

export function renderCoreTeamFriday(
  ctx: TemplateContext,
  rows: CoreTeamRowSnapshot[],
): { subject: string; html: string } {
  const subject = `[${ctx.schoolName}] Friday intervention completion summary`;
  const t2 = rows.filter((r) => r.tier === 2);
  const t3 = rows.filter((r) => r.tier === 3);
  const renderRows = (rs: CoreTeamRowSnapshot[]): string =>
    rs.length
      ? rs
          .map(
            (r) =>
              `<tr><td>${escape(r.studentName)}</td><td>${r.completed}/${r.expected}</td><td>${r.teacherCount}</td></tr>`,
          )
          .join("")
      : "<tr><td colspan='3'>No active plans.</td></tr>";
  const tableHead =
    "<tr><th align='left'>Student</th><th align='left'>Completed</th><th align='left'>Teachers</th></tr>";
  return {
    subject,
    html: shell(
      subject,
      `<h2>Weekly intervention summary — week ending ${escape(ctx.asOfDate)}</h2>
       <h3>Tier 2 (${t2.length})</h3>
       <table cellpadding="4" style="border-collapse: collapse;">${tableHead}${renderRows(t2)}</table>
       <h3 style="margin-top:1rem">Tier 3 (${t3.length})</h3>
       <table cellpadding="4" style="border-collapse: collapse;">${tableHead}${renderRows(t3)}</table>`,
    ),
  };
}

/* ------------------------------------------------------------------ */
/*  Send wrapper                                                      */
/* ------------------------------------------------------------------ */

// True only when both the env flag is on AND a verified sender exists.
// All sends from this module funnel through this so flipping
// EMAIL_REMINDERS_ENABLED=true is a single deploy-toggle.
export function emailRemindersEnabled(): boolean {
  return process.env.EMAIL_REMINDERS_ENABLED === "true";
}

export interface SendInput {
  to: string;
  subject: string;
  html: string;
  client: Resend;
  fromEmail: string;
}

export async function maybeSend(input: SendInput): Promise<{
  sent: boolean;
  reason?: string;
  id?: string;
}> {
  if (!emailRemindersEnabled()) {
    logger.info(
      { to: input.to, subject: input.subject },
      "interventionReminders.maybeSend skipped (EMAIL_REMINDERS_ENABLED!=true)",
    );
    return { sent: false, reason: "disabled" };
  }
  try {
    const result = await input.client.emails.send({
      from: input.fromEmail,
      to: input.to,
      subject: input.subject,
      html: input.html,
    });
    return { sent: true, id: result.data?.id };
  } catch (err) {
    logger.error(
      {
        err: err instanceof Error ? err.message : String(err),
        to: input.to,
        subject: input.subject,
      },
      "interventionReminders.maybeSend failed",
    );
    return {
      sent: false,
      reason: err instanceof Error ? err.message : "send failed",
    };
  }
}
