import { getUncachableResendClient } from "./resendClient.js";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface PlanUpdateEmailArgs {
  toEmail: string;
  toDisplayName: string;
  coordinatorName: string;
  planLabel: string; // "504 Plan", "ESE / IEP", ...
  studentName: string;
  effectiveDateLabel: string;
  summary: string;
  isReminder: boolean;
}

// Fire-and-forget notification/reminder that a student's plan changed and
// the teacher must re-read + acknowledge. Failures are logged and
// swallowed — the roster pill dot is the reliable in-app channel.
export async function sendPlanUpdateEmail(
  args: PlanUpdateEmailArgs,
): Promise<void> {
  try {
    if (!args.toEmail || !args.toEmail.includes("@")) return;
    const { client, fromEmail } = await getUncachableResendClient();
    const subject = `[PulseEDU] ${args.isReminder ? "Reminder: " : ""}${args.planLabel} updated for ${args.studentName}`;
    const html = `
      <div style="font-family:system-ui,-apple-system,sans-serif;max-width:540px;margin:0 auto;padding:24px;color:#111827">
        <h2 style="margin:0 0 12px;font-size:18px">${escapeHtml(args.planLabel)} updated — please re-read</h2>
        <p style="margin:0 0 12px;color:#374151;font-size:14px;line-height:1.5">
          Hi ${escapeHtml(args.toDisplayName)},
        </p>
        <p style="margin:0 0 12px;color:#374151;font-size:14px;line-height:1.5">
          ${escapeHtml(args.coordinatorName)} logged a change to
          <strong>${escapeHtml(args.studentName)}</strong>'s
          ${escapeHtml(args.planLabel)}, effective
          <strong>${escapeHtml(args.effectiveDateLabel)}</strong>:
        </p>
        <blockquote style="margin:0 0 12px;padding:10px 14px;border-left:3px solid #f59e0b;background:#fffbeb;color:#374151;font-size:14px;line-height:1.5">
          ${escapeHtml(args.summary)}
        </blockquote>
        <p style="margin:0 0 12px;color:#374151;font-size:14px;line-height:1.5">
          On your Teacher Roster, hover the highlighted plan pill next to the
          student's name, review the change, and check
          "I've re-read this plan" to acknowledge.
        </p>
        <p style="margin:24px 0 0;color:#9ca3af;font-size:12px">
          Your acknowledgment is tracked so the support team knows every
          teacher has seen the change.
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
      "[plan-updates] email failed (non-fatal)",
      err instanceof Error ? err.message : String(err),
    );
  }
}
