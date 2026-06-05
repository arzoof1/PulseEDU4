import { logger } from "./logger.js";

// --------------------------------------------------------------------------
// Generic SMS sender — AWS SNS, STUBBED.
//
// This is intentionally a no-op stub today: every call is logged and returns
// `{ stubbed: true }` without sending anything, so callers (School Tours
// notify group now; pullout return-message notifications later) can fire it
// safely before AWS is wired up.
//
// To go live:
//   1. `pnpm --filter @workspace/api-server add @aws-sdk/client-sns`
//   2. Set Secrets: SMS_ENABLED=true, AWS_REGION, AWS_ACCESS_KEY_ID,
//      AWS_SECRET_ACCESS_KEY (and optionally SMS_SENDER_ID).
//   3. Replace the body of `deliverViaSns` below with a real
//      SNSClient + PublishCommand call (sketch left in place, commented).
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
  // Provider message id when sent for real; empty string when stubbed/failed.
  id: string;
  // True when no real send happened (AWS not configured / SMS disabled).
  stubbed: boolean;
}

function smsEnabled(): boolean {
  return (
    process.env.SMS_ENABLED === "true" &&
    Boolean(process.env.AWS_ACCESS_KEY_ID) &&
    Boolean(process.env.AWS_SECRET_ACCESS_KEY) &&
    Boolean(process.env.AWS_REGION)
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

async function deliverViaSns(_to: string, _body: string): Promise<string> {
  // Real implementation (uncomment once @aws-sdk/client-sns is installed):
  //
  // const { SNSClient, PublishCommand } = await import("@aws-sdk/client-sns");
  // const client = new SNSClient({ region: process.env.AWS_REGION });
  // const out = await client.send(
  //   new PublishCommand({ PhoneNumber: _to, Message: _body }),
  // );
  // return out.MessageId ?? "";
  throw new Error("AWS SNS client not installed (SMS stub).");
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
      "sms: STUB (SMS disabled / AWS not configured) — not sent",
    );
    return { ok: false, id: "", stubbed: true };
  }

  try {
    const id = await deliverViaSns(to, msg.body);
    logger.info({ to, id }, "sms: sent via SNS");
    return { ok: true, id, stubbed: false };
  } catch (err) {
    logger.warn({ to, err }, "sms: SNS send failed");
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
