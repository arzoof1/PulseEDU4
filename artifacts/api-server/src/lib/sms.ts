import { logger } from "./logger.js";
import { getTwilioClient, twilioSender } from "./twilioClient.js";

// --------------------------------------------------------------------------
// Generic SMS sender — Twilio.
//
// Inert until configured: when SMS is disabled, or Twilio credentials / a
// sender are missing, every call is a logged no-op returning `{ stubbed: true }`
// — so the existing callers (overdue hall-pass alerts, school-tour lead alerts,
// tardy notifications) fire safely before the number is provisioned.
//
// To go live:
//   1. In the account owner's Twilio project, provision a sender — a Messaging
//      Service (recommended) or a phone number — and complete US A2P 10DLC /
//      toll-free registration for it.
//   2. Set Secrets: SMS_ENABLED=true, TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID,
//      TWILIO_API_KEY_SECRET, and ONE of TWILIO_MESSAGING_SERVICE_SID or
//      TWILIO_FROM_NUMBER (see twilioClient.ts).
//
// Phone numbers must be E.164 ("+1XXXXXXXXXX"). `toE164` does a best-effort
// normalization of US 10-digit input; anything already starting with "+" is
// passed through untouched.
// --------------------------------------------------------------------------

export interface SmsMessage {
  to: string;
  body: string;
}

export interface SmsResult {
  ok: boolean;
  // Provider message id (Twilio SID) when sent for real; empty when stubbed/failed.
  id: string;
  // True when no real send happened (Twilio not configured / SMS disabled).
  stubbed: boolean;
}

function smsEnabled(): boolean {
  return (
    process.env.SMS_ENABLED === "true" &&
    Boolean(process.env.TWILIO_ACCOUNT_SID) &&
    Boolean(process.env.TWILIO_API_KEY_SID) &&
    Boolean(process.env.TWILIO_API_KEY_SECRET) &&
    twilioSender() !== null
  );
}

// Best-effort E.164 for US numbers. Returns null when the input clearly
// isn't a phone number we can dial.
export function toE164(raw: string): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("+")) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

async function deliverViaTwilio(to: string, body: string): Promise<string> {
  const sender = twilioSender();
  if (!sender) throw new Error("No Twilio sender configured.");
  const client = getTwilioClient();
  const res = await client.messages.create({ to, body, ...sender });
  return res.sid;
}

// Send a single SMS. Never throws — returns a result the caller can log.
export async function sendSms(msg: SmsMessage): Promise<SmsResult> {
  const to = toE164(msg.to);
  if (!to) {
    logger.warn({ rawTo: msg.to }, "sms: unparseable phone number, skipping");
    return { ok: false, id: "", stubbed: true };
  }

  if (!smsEnabled()) {
    logger.info(
      { bodyLength: msg.body.length },
      "sms: STUB (SMS disabled / Twilio not configured) — not sent",
    );
    return { ok: false, id: "", stubbed: true };
  }

  try {
    const id = await deliverViaTwilio(to, msg.body);
    logger.info({ to, id }, "sms: sent via Twilio");
    return { ok: true, id, stubbed: false };
  } catch (err) {
    logger.warn({ to, err }, "sms: Twilio send failed");
    return { ok: false, id: "", stubbed: false };
  }
}

// Fan out the same body to many recipients. Best-effort; logs a rollup.
export async function sendSmsBatch(
  recipients: string[],
  body: string,
): Promise<{ sent: number; stubbed: number; failed: number }> {
  let sent = 0;
  let stubbed = 0;
  let failed = 0;
  for (const to of recipients) {
    const r = await sendSms({ to, body });
    if (r.ok) sent += 1;
    else if (r.stubbed) stubbed += 1;
    else failed += 1;
  }
  return { sent, stubbed, failed };
}
