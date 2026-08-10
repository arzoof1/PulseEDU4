import { getUncachableResendClient } from "./resendClient.js";
import { formatFromHeader } from "./emailFrom.js";
import { logger } from "./logger.js";

// Email side of the School Tours notify flow. Two messages:
//   1. New-lead alert to the school's notify group (staff).
//   2. Warm auto-acknowledgment to the family the instant they submit.
//
// Both are best-effort: failures are logged and swallowed so a flaky inbox
// never blocks lead creation. Sending is gated on EMAIL_REMINDERS_ENABLED so
// dev environments without email configured stay quiet.

function emailEnabled(): boolean {
  return process.env.EMAIL_REMINDERS_ENABLED === "true";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function shell(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html>
  <body style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; background:#f5f7fa; padding:24px; margin:0;">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px; margin:0 auto; background:#ffffff; border-radius:14px; overflow:hidden; border:1px solid #e6ebf1;">
      <tr>
        <td style="background:linear-gradient(135deg,#0ea5a4 0%,#2563eb 100%); padding:24px 28px;">
          <div style="color:#ffffff; font-size:13px; letter-spacing:1.5px; text-transform:uppercase; opacity:0.85;">PulseEDU · School Tours</div>
          <div style="color:#ffffff; font-size:22px; font-weight:700; margin-top:6px;">${escapeHtml(title)}</div>
        </td>
      </tr>
      <tr>
        <td style="padding:24px 28px; color:#1f2937; font-size:15px; line-height:1.55;">
          ${bodyHtml}
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export interface NewLeadEmailArgs {
  to: string[];
  schoolName: string;
  familyName: string;
  phone: string;
  childrenSummary: string;
  interests: string;
  source: string | null;
  pipelineUrl: string;
}

// Alert the staff notify group that a new tour request landed.
export async function sendNewLeadNotifyEmail(
  args: NewLeadEmailArgs,
): Promise<boolean> {
  if (!emailEnabled() || args.to.length === 0) return false;
  try {
    const { client, fromEmail } = await getUncachableResendClient();
    const rows = [
      ["Family", args.familyName],
      ["Phone", args.phone],
      ["Student(s)", args.childrenSummary],
      ["Interested in", args.interests || "—"],
      ["Source", args.source || "—"],
    ]
      .map(
        ([k, v]) =>
          `<tr><td style="padding:4px 10px 4px 0; color:#6b7280; font-size:13px; vertical-align:top;">${escapeHtml(
            k,
          )}</td><td style="padding:4px 0; font-size:14px;"><strong>${escapeHtml(
            v,
          )}</strong></td></tr>`,
      )
      .join("");
    const body = `
      <p style="margin:0 0 14px 0;">A family just requested a tour of <strong>${escapeHtml(
        args.schoolName,
      )}</strong>. Reach out within one school day to keep the lead warm.</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px 0;">${rows}</table>
      <p style="margin:0 0 22px 0; text-align:center;">
        <a href="${args.pipelineUrl}" style="display:inline-block; background:#0ea5a4; color:#ffffff; text-decoration:none; padding:12px 24px; border-radius:10px; font-weight:600; font-size:15px;">Open the lead pipeline</a>
      </p>`;
    const result = await client.emails.send({
      from: fromEmail,
      to: args.to,
      subject: `New tour request: ${args.familyName} — ${args.schoolName}`,
      html: shell("New tour request", body),
      text: `New tour request for ${args.schoolName}\n\nFamily: ${args.familyName}\nPhone: ${args.phone}\nStudent(s): ${args.childrenSummary}\nInterested in: ${args.interests || "—"}\nSource: ${args.source || "—"}\n\nOpen the pipeline: ${args.pipelineUrl}`,
    });
    if (result.error) throw new Error(result.error.message);
    return true;
  } catch (err) {
    logger.warn({ err }, "tour new-lead notify email failed");
    return false;
  }
}

export interface LeadAssignedEmailArgs {
  to: string;
  cc: string[];
  schoolName: string;
  familyName: string;
  phone: string;
  childrenSummary: string;
  assigneeName: string;
  assignedByName: string;
  pipelineUrl: string;
}

// Notify a staff member they've been made the owner of a tour lead. The
// principal/admins are CC'd for oversight. Best-effort, gated on email being
// enabled.
export async function sendLeadAssignedEmail(
  args: LeadAssignedEmailArgs,
): Promise<boolean> {
  if (!emailEnabled() || !args.to) return false;
  try {
    const { client, fromEmail } = await getUncachableResendClient();
    const rows = [
      ["Family", args.familyName],
      ["Phone", args.phone],
      ["Student(s)", args.childrenSummary],
      ["Assigned by", args.assignedByName],
    ]
      .map(
        ([k, v]) =>
          `<tr><td style="padding:4px 10px 4px 0; color:#6b7280; font-size:13px; vertical-align:top;">${escapeHtml(
            k,
          )}</td><td style="padding:4px 0; font-size:14px;"><strong>${escapeHtml(
            v,
          )}</strong></td></tr>`,
      )
      .join("");
    const body = `
      <p style="margin:0 0 14px 0;">Hi ${escapeHtml(args.assigneeName)},</p>
      <p style="margin:0 0 14px 0;">You've been assigned a tour at <strong>${escapeHtml(
        args.schoolName,
      )}</strong>. Please reach out to the family within one school day and print the Tour Roadmap before they arrive.</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px 0;">${rows}</table>
      <p style="margin:0 0 22px 0; text-align:center;">
        <a href="${args.pipelineUrl}" style="display:inline-block; background:#0ea5a4; color:#ffffff; text-decoration:none; padding:12px 24px; border-radius:10px; font-weight:600; font-size:15px;">Open the lead</a>
      </p>`;
    const result = await client.emails.send({
      from: fromEmail,
      to: args.to,
      cc: args.cc.length ? args.cc : undefined,
      subject: `Tour assigned to you: ${args.familyName} — ${args.schoolName}`,
      html: shell("You've been assigned a tour", body),
      text: `Hi ${args.assigneeName},\n\nYou've been assigned a tour at ${args.schoolName}.\n\nFamily: ${args.familyName}\nPhone: ${args.phone}\nStudent(s): ${args.childrenSummary}\nAssigned by: ${args.assignedByName}\n\nOpen the lead: ${args.pipelineUrl}`,
    });
    if (result.error) throw new Error(result.error.message);
    return true;
  } catch (err) {
    logger.warn({ err }, "tour lead-assigned email failed");
    return false;
  }
}

export type TourOverdueReason =
  | "first_contact"
  | "tour_not_logged"
  | "follow_up";

export interface LeadOverdueEmailArgs {
  to: string[];
  cc: string[];
  schoolName: string;
  familyName: string;
  phone: string;
  childrenSummary: string;
  assigneeName: string | null;
  reason: TourOverdueReason;
  // Human-readable description of how long the lead has been waiting.
  waitingSummary: string;
  pipelineUrl: string;
}

const OVERDUE_COPY: Record<
  TourOverdueReason,
  { label: string; line: string; subject: string }
> = {
  first_contact: {
    label: "First contact overdue",
    line: "This new tour lead hasn't been contacted yet and is now past your first-contact window. Reach out today to keep the family warm.",
    subject: "Tour lead needs first contact",
  },
  tour_not_logged: {
    label: "Tour not logged",
    line: "This lead's scheduled tour time has passed but no outcome has been recorded. Log how the tour went (or reschedule) so the lead doesn't stall.",
    subject: "Tour outcome not logged",
  },
  follow_up: {
    label: "Follow-up due",
    line: "This family is still deciding and their follow-up is now due. A quick check-in keeps you top of mind while they choose.",
    subject: "Still-deciding lead needs a follow-up",
  },
};

// Escalation nudge to the lead's owner (or the notify group when unassigned),
// CC'ing the coordinator/principal. Sent by the background escalation job when a
// lead crosses its SLA threshold. Reason-specific copy. Best-effort, gated on
// email being enabled.
export async function sendLeadOverdueEscalationEmail(
  args: LeadOverdueEmailArgs,
): Promise<boolean> {
  if (!emailEnabled() || args.to.length === 0) return false;
  try {
    const { client, fromEmail } = await getUncachableResendClient();
    const copy = OVERDUE_COPY[args.reason];
    const rows = [
      ["Family", args.familyName],
      ["Phone", args.phone],
      ["Student(s)", args.childrenSummary],
      ["Owner", args.assigneeName || "Unassigned"],
      ["Waiting", args.waitingSummary],
    ]
      .map(
        ([k, v]) =>
          `<tr><td style="padding:4px 10px 4px 0; color:#6b7280; font-size:13px; vertical-align:top;">${escapeHtml(
            k,
          )}</td><td style="padding:4px 0; font-size:14px;"><strong>${escapeHtml(
            v,
          )}</strong></td></tr>`,
      )
      .join("");
    const body = `
      <p style="margin:0 0 10px 0;"><span style="display:inline-block; background:#fef2f2; color:#b91c1c; font-size:12px; font-weight:700; letter-spacing:0.4px; text-transform:uppercase; padding:4px 10px; border-radius:999px;">${escapeHtml(
        copy.label,
      )}</span></p>
      <p style="margin:0 0 14px 0;">${escapeHtml(copy.line)}</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px 0;">${rows}</table>
      <p style="margin:0 0 22px 0; text-align:center;">
        <a href="${args.pipelineUrl}" style="display:inline-block; background:#0ea5a4; color:#ffffff; text-decoration:none; padding:12px 24px; border-radius:10px; font-weight:600; font-size:15px;">Open the lead</a>
      </p>`;
    const result = await client.emails.send({
      from: fromEmail,
      to: args.to,
      cc: args.cc.length ? args.cc : undefined,
      subject: `${copy.subject}: ${args.familyName} — ${args.schoolName}`,
      html: shell(copy.label, body),
      text: `${copy.label} — ${args.schoolName}\n\n${copy.line}\n\nFamily: ${args.familyName}\nPhone: ${args.phone}\nStudent(s): ${args.childrenSummary}\nOwner: ${args.assigneeName || "Unassigned"}\nWaiting: ${args.waitingSummary}\n\nOpen the lead: ${args.pipelineUrl}`,
    });
    if (result.error) throw new Error(result.error.message);
    return true;
  } catch (err) {
    logger.warn({ err }, "tour lead-overdue escalation email failed");
    return false;
  }
}

export interface FamilyAckEmailArgs {
  to: string;
  schoolName: string;
  familyName: string;
  fromName: string;
  signature: string;
}

// Warm instant acknowledgment to the family.
export async function sendFamilyAckEmail(
  args: FamilyAckEmailArgs,
): Promise<boolean> {
  if (!emailEnabled()) return false;
  try {
    const { client, fromEmail } = await getUncachableResendClient();
    const sig = args.signature || `Warmly,\n${args.schoolName}`;
    const body = `
      <p style="margin:0 0 14px 0;">Hi ${escapeHtml(args.familyName)},</p>
      <p style="margin:0 0 14px 0;">Thank you for your interest in <strong>${escapeHtml(
        args.schoolName,
      )}</strong>! We received your tour request and a member of our team will reach out within one school day to find a time that works for you.</p>
      <p style="margin:0 0 14px 0;">We can't wait to show you around.</p>
      <p style="margin:0; color:#6b7280; font-size:13px; white-space:pre-line;">${escapeHtml(
        sig,
      )}</p>`;
    const result = await client.emails.send({
      from: formatFromHeader(args.fromName, fromEmail),
      to: args.to,
      subject: `We got your tour request — ${args.schoolName}`,
      html: shell("Thanks for reaching out!", body),
      text: `Hi ${args.familyName},\n\nThank you for your interest in ${args.schoolName}! We received your tour request and a member of our team will reach out within one school day.\n\n${sig}`,
    });
    if (result.error) throw new Error(result.error.message);
    return true;
  } catch (err) {
    logger.warn({ err }, "tour family ack email failed");
    return false;
  }
}

// =============================================================================
// Phase 3 "close the loop with families" — automated FAMILY nurture cadence.
// Each message mirrors sendFamilyAckEmail: gated on EMAIL_REMINDERS_ENABLED,
// best-effort (failures logged + swallowed, returns boolean), warm family tone.
// The background sweep (tourReminders.ts) stamps the lead only after a `true`
// return, so a transient failure is retried on the next hour.
// =============================================================================

interface FamilyNurtureBaseArgs {
  to: string;
  schoolName: string;
  familyName: string;
  // Display name for the From header + closing signature.
  fromName: string;
  signature: string;
}

function familyParagraphs(...paras: string[]): string {
  return paras
    .map(
      (p, i) =>
        `<p style="margin:0 0 ${
          i === paras.length - 1 ? "0" : "14px"
        } 0;">${p}</p>`,
    )
    .join("");
}

function signatureBlock(sig: string): string {
  return `<p style="margin:18px 0 0 0; color:#6b7280; font-size:13px; white-space:pre-line;">${escapeHtml(
    sig,
  )}</p>`;
}

async function sendFamilyNurture(
  args: FamilyNurtureBaseArgs,
  subject: string,
  title: string,
  bodyHtml: string,
  bodyText: string,
  logTag: string,
): Promise<boolean> {
  if (!emailEnabled()) return false;
  try {
    const { client, fromEmail } = await getUncachableResendClient();
    const sig = args.signature || `Warmly,\n${args.schoolName}`;
    const html = shell(title, `${bodyHtml}${signatureBlock(sig)}`);
    const result = await client.emails.send({
      from: args.fromName ? `${args.fromName} <${fromEmail}>` : fromEmail,
      to: args.to,
      subject,
      html,
      text: `${bodyText}\n\n${sig}`,
    });
    if (result.error) throw new Error(result.error.message);
    return true;
  } catch (err) {
    logger.warn({ err }, logTag);
    return false;
  }
}

export interface FamilyTourReminderArgs extends FamilyNurtureBaseArgs {
  // Human-readable scheduled time, already formatted in the school's locale.
  tourWhen: string;
}

// (1) Pre-tour reminder — goes out the day before the scheduled tour.
export async function sendFamilyTourReminderEmail(
  args: FamilyTourReminderArgs,
): Promise<boolean> {
  const html = familyParagraphs(
    `Hi ${escapeHtml(args.familyName)},`,
    `This is a friendly reminder that your tour of <strong>${escapeHtml(
      args.schoolName,
    )}</strong> is coming up on <strong>${escapeHtml(args.tourWhen)}</strong>.`,
    `If anything has come up and you need to reschedule, just reply to this email and we'll find another time. Otherwise, we look forward to seeing you!`,
  );
  const text = `Hi ${args.familyName},\n\nThis is a friendly reminder that your tour of ${args.schoolName} is coming up on ${args.tourWhen}.\n\nIf you need to reschedule, just reply to this email. Otherwise, we look forward to seeing you!`;
  return sendFamilyNurture(
    args,
    `Your tour is coming up — ${args.schoolName}`,
    "See you soon!",
    html,
    text,
    "tour family reminder email failed",
  );
}

export interface FamilyThankYouArgs extends FamilyNurtureBaseArgs {
  surveyUrl: string;
}

// (2) Post-tour thank-you + survey link.
export async function sendFamilyPostTourThankYouEmail(
  args: FamilyThankYouArgs,
): Promise<boolean> {
  const html = `${familyParagraphs(
    `Hi ${escapeHtml(args.familyName)},`,
    `Thank you for visiting <strong>${escapeHtml(
      args.schoolName,
    )}</strong> — it was a pleasure showing you around and getting to meet you.`,
    `We'd love to hear what you thought. If you have a moment, please share your feedback:`,
  )}
      <p style="margin:18px 0;">
        <a href="${escapeHtml(args.surveyUrl)}" style="display:inline-block; background:#0ea5a4; color:#ffffff; text-decoration:none; padding:11px 22px; border-radius:9px; font-weight:600; font-size:14px;">Share your feedback</a>
      </p>
      ${familyParagraphs(
        `If you have any questions as you consider your decision, just reply to this email — we're here to help.`,
      )}`;
  const text = `Hi ${args.familyName},\n\nThank you for visiting ${args.schoolName} — it was a pleasure showing you around.\n\nWe'd love to hear what you thought. Please share your feedback here:\n${args.surveyUrl}\n\nIf you have any questions as you consider your decision, just reply to this email.`;
  return sendFamilyNurture(
    args,
    `Thanks for touring ${args.schoolName}!`,
    "Thanks for visiting!",
    html,
    text,
    "tour family thank-you email failed",
  );
}

// (3) Gentle "still deciding" nudge.
export async function sendFamilyDecidingNudgeEmail(
  args: FamilyNurtureBaseArgs,
): Promise<boolean> {
  const html = familyParagraphs(
    `Hi ${escapeHtml(args.familyName)},`,
    `We so enjoyed having you visit <strong>${escapeHtml(
      args.schoolName,
    )}</strong>, and we wanted to check in as you think things over.`,
    `Choosing the right school is a big decision, and we're happy to answer any questions, arrange a second visit, or connect you with our team. Just reply to this email and we'll take it from there.`,
    `We'd be delighted to welcome your family.`,
  );
  const text = `Hi ${args.familyName},\n\nWe so enjoyed having you visit ${args.schoolName}, and we wanted to check in as you think things over.\n\nChoosing the right school is a big decision, and we're happy to answer any questions, arrange a second visit, or connect you with our team. Just reply to this email.\n\nWe'd be delighted to welcome your family.`;
  return sendFamilyNurture(
    args,
    `Checking in from ${args.schoolName}`,
    "Still here for you",
    html,
    text,
    "tour family deciding-nudge email failed",
  );
}

// (4) Enrollment welcome.
export async function sendFamilyEnrollmentWelcomeEmail(
  args: FamilyNurtureBaseArgs,
): Promise<boolean> {
  const html = familyParagraphs(
    `Hi ${escapeHtml(args.familyName)},`,
    `Welcome to the <strong>${escapeHtml(
      args.schoolName,
    )}</strong> family — we are thrilled you've chosen us!`,
    `Our team will be in touch shortly with next steps to get your student set up for a great start. In the meantime, if you have any questions, just reply to this email.`,
    `We can't wait to get started together.`,
  );
  const text = `Hi ${args.familyName},\n\nWelcome to the ${args.schoolName} family — we are thrilled you've chosen us!\n\nOur team will be in touch shortly with next steps to get your student set up for a great start. If you have any questions, just reply to this email.\n\nWe can't wait to get started together.`;
  return sendFamilyNurture(
    args,
    `Welcome to ${args.schoolName}!`,
    "Welcome aboard!",
    html,
    text,
    "tour family welcome email failed",
  );
}
