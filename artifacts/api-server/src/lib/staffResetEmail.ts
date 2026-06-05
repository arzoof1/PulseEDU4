import type { Request } from "express";
import { getUncachableResendClient } from "./resendClient.js";
import { logger } from "./logger.js";

// Resolve the absolute origin for links staff click OUTSIDE the workspace.
// Mirrors publicAppOrigin(req) in routes/tours.ts — preferring the published
// production domain over the dev host so reset links don't point at a dead
// dev URL in production. (See the publicAppOrigin gotcha in replit.md.)
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

// Staff reset pages live at the staff app root (no /parent prefix).
export function buildStaffResetPasswordUrl(token: string, req?: Request): string {
  return `${publicAppOrigin(req)}/reset-password/${encodeURIComponent(token)}`;
}

type SendStaffResetArgs = {
  to: string;
  staffDisplayName: string;
  schoolName: string;
  fromName: string;
  emailSignature: string;
  resetUrl: string;
};

// Sends a "you (or someone) asked to reset your password" email. We always
// 200 from the request-reset endpoint regardless of whether the email matches
// a real account (no enumeration), so this only runs when there's a real
// staff member to reset. Throws on Resend failure so the route can log it;
// the route still returns 200 to preserve the no-enumeration property.
export async function sendStaffPasswordResetEmail(
  args: SendStaffResetArgs,
): Promise<{ id: string }> {
  const { to, staffDisplayName, schoolName, fromName, emailSignature, resetUrl } =
    args;

  const { client, fromEmail } = await getUncachableResendClient();
  const subject = `Reset your PulseEDU password`;

  const text = [
    `Hi ${staffDisplayName || "there"},`,
    ``,
    `Someone asked to reset the password for your PulseEDU staff account at ${schoolName}.`,
    ``,
    `Click the link below to choose a new password. The link is good for 1 hour.`,
    ``,
    resetUrl,
    ``,
    `If you didn't ask for this, you can safely ignore this email — your password won't change.`,
    ``,
    emailSignature || `Thank you,\n${schoolName}`,
  ].join("\n");

  const html = `<!doctype html>
<html>
  <body style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; background:#f5f7fa; padding:24px; margin:0;">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px; margin:0 auto; background:#ffffff; border-radius:14px; overflow:hidden; border:1px solid #e6ebf1;">
      <tr>
        <td style="background:linear-gradient(135deg,#2563eb 0%,#1e293b 100%); padding:24px 28px;">
          <div style="color:#ffffff; font-size:13px; letter-spacing:1.5px; text-transform:uppercase; opacity:0.85;">PulseEDU</div>
          <div style="color:#ffffff; font-size:22px; font-weight:700; margin-top:6px;">Reset your password</div>
        </td>
      </tr>
      <tr>
        <td style="padding:24px 28px; color:#1f2937; font-size:15px; line-height:1.55;">
          <p style="margin:0 0 14px 0;">Hi ${escapeHtml(staffDisplayName || "there")},</p>
          <p style="margin:0 0 14px 0;">Someone asked to reset the password for your PulseEDU staff account at <strong>${escapeHtml(schoolName)}</strong>.</p>
          <p style="margin:0 0 22px 0;">Click the button below to choose a new password. The link is good for <strong>1 hour</strong>.</p>
          <p style="margin:0 0 22px 0; text-align:center;">
            <a href="${resetUrl}" style="display:inline-block; background:#2563eb; color:#ffffff; text-decoration:none; padding:12px 24px; border-radius:10px; font-weight:600; font-size:15px;">Reset my password</a>
          </p>
          <p style="margin:0 0 6px 0; color:#6b7280; font-size:13px;">Or paste this link into your browser:</p>
          <p style="margin:0 0 22px 0; word-break:break-all; color:#2563eb; font-size:13px;">${resetUrl}</p>
          <p style="margin:0 0 4px 0; color:#6b7280; font-size:13px;">If you didn't ask for this, you can safely ignore this email — your password won't change.</p>
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
    subject,
    text,
    html,
  });

  if (result.error) {
    logger.warn(
      { resendError: result.error, to },
      "staff password reset email send failed",
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
