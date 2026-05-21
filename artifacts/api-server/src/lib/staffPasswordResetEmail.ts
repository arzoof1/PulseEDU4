import { getUncachableResendClient } from "./resendClient.js";
import { logger } from "./logger.js";

function publicAppOrigin(): string {
  const explicit = process.env.PUBLIC_APP_URL;
  if (explicit && explicit.length > 0) return explicit.replace(/\/+$/, "");
  const replit = process.env.REPLIT_DEV_DOMAIN;
  if (replit && replit.length > 0) return `https://${replit}`;
  return "http://localhost:5173";
}

export function buildStaffPasswordResetUrl(token: string): string {
  return `${publicAppOrigin()}/reset-password/${encodeURIComponent(token)}`;
}

export async function sendStaffPasswordResetEmail(args: {
  to: string;
  displayName: string;
  resetUrl: string;
  expiresMinutes: number;
}): Promise<{ id: string }> {
  const { client, fromEmail } = await getUncachableResendClient();
  const subject = "Reset your PulseEDU password";
  const text = [
    `Hello ${args.displayName},`,
    ``,
    `We received a request to reset your PulseEDU password.`,
    `Click the link below to choose a new password. This link expires in ${args.expiresMinutes} minutes and can only be used once.`,
    ``,
    args.resetUrl,
    ``,
    `If you did not request this, you can ignore this email and your password will stay unchanged.`,
    ``,
    `PulseEDU`,
  ].join("\n");

  const html = `<!doctype html>
<html>
  <body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f5f7fa;padding:24px;margin:0;">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e6ebf1;">
      <tr>
        <td style="background:linear-gradient(135deg,#0ea5a4 0%,#2563eb 100%);padding:24px 28px;">
          <div style="color:#ffffff;font-size:13px;letter-spacing:1.5px;text-transform:uppercase;opacity:0.85;">PulseEDU</div>
          <div style="color:#ffffff;font-size:22px;font-weight:700;margin-top:6px;">Reset your password</div>
        </td>
      </tr>
      <tr>
        <td style="padding:24px 28px;color:#1f2937;font-size:15px;line-height:1.55;">
          <p style="margin:0 0 14px 0;">Hello ${escapeHtml(args.displayName)},</p>
          <p style="margin:0 0 14px 0;">We received a request to reset your PulseEDU password.</p>
          <p style="margin:0 0 22px 0;">Click the button below to choose a new password. This link expires in ${args.expiresMinutes} minutes and can only be used once.</p>
          <p style="margin:0 0 22px 0;text-align:center;">
            <a href="${args.resetUrl}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:10px;font-weight:600;font-size:15px;">Reset password</a>
          </p>
          <p style="margin:0 0 6px 0;color:#6b7280;font-size:13px;">Or paste this link into your browser:</p>
          <p style="margin:0 0 22px 0;word-break:break-all;color:#2563eb;font-size:13px;">${args.resetUrl}</p>
          <p style="margin:0;color:#6b7280;font-size:13px;">If you did not request this, you can ignore this email and your password will stay unchanged.</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const result = await client.emails.send({
    from: fromEmail,
    to: args.to,
    subject,
    text,
    html,
  });

  if (result.error) {
    logger.warn(
      { resendError: result.error, to: args.to },
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
