import { getUncachableResendClient } from "./resendClient.js";
import { resolvePublicAppOrigin } from "./publicAppUrl.js";
import { logger } from "./logger.js";

export function buildAcceptInviteUrl(token: string): string {
  return `${resolvePublicAppOrigin()}/parent/accept-invite/${encodeURIComponent(token)}`;
}

type SendInviteArgs = {
  to: string;
  studentFirstName: string;
  studentLastName: string;
  schoolName: string;
  fromName: string;
  emailSignature: string;
  acceptUrl: string;
  isResend: boolean;
};

// Sends a parent invite email. Throws on failure so the caller can decide
// whether to surface the error (interactive admin click) or just log it
// (bulk send loop, where one bad address shouldn't abort the rest).
export async function sendParentInviteEmail(args: SendInviteArgs): Promise<{
  id: string;
}> {
  const {
    to,
    studentFirstName,
    studentLastName,
    schoolName,
    fromName,
    emailSignature,
    acceptUrl,
    isResend,
  } = args;

  const { client, fromEmail } = await getUncachableResendClient();
  const studentFull = `${studentFirstName} ${studentLastName}`.trim();
  const subjectLead = isResend
    ? `Reminder: set up your HeartBEAT account`
    : `${schoolName}: Set up your HeartBEAT parent account`;

  const text = [
    `Hello,`,
    ``,
    `${schoolName} has invited you to view ${studentFull}'s HeartBEAT — a private snapshot of how things are going at school: recognition, attendance, accommodations, communication, and more.`,
    ``,
    `Click the link below to set your password and sign in. The link is good for 14 days.`,
    ``,
    acceptUrl,
    ``,
    `If you weren't expecting this email, you can ignore it — no account will be created until you set a password.`,
    ``,
    emailSignature || `Thank you,\n${schoolName}`,
  ].join("\n");

  const html = `<!doctype html>
<html>
  <body style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; background:#f5f7fa; padding:24px; margin:0;">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px; margin:0 auto; background:#ffffff; border-radius:14px; overflow:hidden; border:1px solid #e6ebf1;">
      <tr>
        <td style="background:linear-gradient(135deg,#0ea5a4 0%,#2563eb 100%); padding:24px 28px;">
          <div style="color:#ffffff; font-size:13px; letter-spacing:1.5px; text-transform:uppercase; opacity:0.85;">PulseEDU · HeartBEAT</div>
          <div style="color:#ffffff; font-size:22px; font-weight:700; margin-top:6px;">Set up your parent account</div>
        </td>
      </tr>
      <tr>
        <td style="padding:24px 28px; color:#1f2937; font-size:15px; line-height:1.55;">
          <p style="margin:0 0 14px 0;">Hello,</p>
          <p style="margin:0 0 14px 0;"><strong>${escapeHtml(schoolName)}</strong> has invited you to view <strong>${escapeHtml(studentFull)}</strong>'s HeartBEAT — a private snapshot of how things are going at school: recognition, attendance, accommodations, communication, and more.</p>
          <p style="margin:0 0 22px 0;">Click the button below to set your password and sign in. The link is good for 14 days.</p>
          <p style="margin:0 0 22px 0; text-align:center;">
            <a href="${acceptUrl}" style="display:inline-block; background:#0ea5a4; color:#ffffff; text-decoration:none; padding:12px 24px; border-radius:10px; font-weight:600; font-size:15px;">Set up my account</a>
          </p>
          <p style="margin:0 0 6px 0; color:#6b7280; font-size:13px;">Or paste this link into your browser:</p>
          <p style="margin:0 0 22px 0; word-break:break-all; color:#2563eb; font-size:13px;">${acceptUrl}</p>
          <p style="margin:0 0 4px 0; color:#6b7280; font-size:13px;">If you weren't expecting this email, you can ignore it — no account will be created until you set a password.</p>
        </td>
      </tr>
      <tr>
        <td style="padding:18px 28px; border-top:1px solid #eef2f6; color:#6b7280; font-size:13px; white-space:pre-line;">${escapeHtml(emailSignature || `Thank you,\n${schoolName}`)}</td>
      </tr>
    </table>
  </body>
</html>`;

  const result = await client.emails.send({
    from: fromName ? `${fromName} <${fromEmail}>` : fromEmail,
    to,
    subject: subjectLead,
    text,
    html,
  });

  if (result.error) {
    logger.warn(
      { resendError: result.error, to },
      "parent invite email send failed",
    );
    throw new Error(result.error.message || "Email send failed");
  }
  return { id: result.data?.id ?? "" };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
