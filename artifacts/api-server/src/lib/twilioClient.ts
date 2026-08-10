import twilio from "twilio";

// Lazily-constructed Twilio REST client, authenticated with an API Key
// (SID + Secret) scoped to a specific Account SID. Mirrors the lazy pattern in
// resendClient.ts: a missing-credential boot never crashes the server — only an
// actual send attempt throws.
//
// We deliberately authenticate with an API Key rather than the account Auth
// Token, so the credential can be scoped/rotated by the account owner without
// touching the root token. Signature: twilio(apiKeySid, apiKeySecret, { accountSid }).

type TwilioClient = ReturnType<typeof twilio>;

let cached: TwilioClient | null = null;

export function getTwilioClient(): TwilioClient {
  if (cached) return cached;
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const apiKeySid = process.env.TWILIO_API_KEY_SID;
  const apiKeySecret = process.env.TWILIO_API_KEY_SECRET;
  if (!accountSid || !apiKeySid || !apiKeySecret) {
    throw new Error(
      "Twilio not configured: set TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET.",
    );
  }
  cached = twilio(apiKeySid, apiKeySecret, { accountSid });
  return cached;
}

// Resolve the configured sender. Prefer a Messaging Service SID (handles number
// pooling + carrier opt-out automatically), else a single from-number. Returns
// the exact param object Twilio's messages.create() expects, or null when no
// sender is configured yet (number/10DLC still pending).
export type TwilioSender = { messagingServiceSid: string } | { from: string };

export function twilioSender(): TwilioSender | null {
  const mss = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim();
  if (mss) return { messagingServiceSid: mss };
  const from = process.env.TWILIO_FROM_NUMBER?.trim();
  if (from) return { from };
  return null;
}
