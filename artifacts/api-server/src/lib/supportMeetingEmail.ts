import { getUncachableResendClient } from "./resendClient.js";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface MeetingReminderArgs {
  toEmail: string;
  toDisplayName: string;
  organizerName: string;
  meetingType: string;
  studentName: string;
  dateLabel: string; // already formatted, e.g. "Thu, Aug 13, 2026"
  timeLabel: string; // e.g. "9:30 AM – 10:00 AM"
  location: string;
  needsFeedback: boolean; // declined attendee who still owes the feedback form
}

// Fire-and-forget reminder email for a support-meeting attendee. Failures
// are logged and swallowed — the in-app badge is the reliable channel; email
// is a courtesy nudge.
export async function sendMeetingReminderEmail(
  args: MeetingReminderArgs,
): Promise<void> {
  try {
    if (!args.toEmail || !args.toEmail.includes("@")) return;
    const { client, fromEmail } = await getUncachableResendClient();
    const ask = args.needsFeedback
      ? "You marked yourself unable to attend — please add your quick feedback so your input still reaches the team."
      : "Please open PulseEDU and confirm whether you can attend.";
    const subject = `[PulseEDU] Reminder: ${args.meetingType} for ${args.studentName} — ${args.dateLabel}`;
    const html = `
      <div style="font-family:system-ui,-apple-system,sans-serif;max-width:540px;margin:0 auto;padding:24px;color:#111827">
        <h2 style="margin:0 0 12px;font-size:18px">Support meeting reminder</h2>
        <p style="margin:0 0 12px;color:#374151;font-size:14px;line-height:1.5">
          Hi ${escapeHtml(args.toDisplayName)},
        </p>
        <p style="margin:0 0 12px;color:#374151;font-size:14px;line-height:1.5">
          ${escapeHtml(args.organizerName)} scheduled a
          <strong>${escapeHtml(args.meetingType)}</strong> for
          <strong>${escapeHtml(args.studentName)}</strong>:
        </p>
        <p style="margin:0 0 12px;color:#374151;font-size:14px;line-height:1.6">
          📅 ${escapeHtml(args.dateLabel)}<br/>
          🕘 ${escapeHtml(args.timeLabel)}${
            args.location
              ? `<br/>📍 ${escapeHtml(args.location)}`
              : ""
          }
        </p>
        <p style="margin:0 0 12px;color:#374151;font-size:14px;line-height:1.5">
          ${escapeHtml(ask)}
        </p>
        <p style="margin:24px 0 0;color:#9ca3af;font-size:12px">
          Respond from the Meetings page in PulseEDU (Student Support &gt; Meetings).
        </p>
      </div>
    `;
    await client.emails.send({
      from: fromEmail,
      to: args.toEmail,
      subject,
      html,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[support-meetings] reminder email failed (non-fatal)",
      err instanceof Error ? err.message : String(err),
    );
  }
}
