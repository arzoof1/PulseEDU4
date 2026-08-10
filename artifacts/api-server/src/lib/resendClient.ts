import { Resend } from "resend";
import { isEmailGloballyEnabled } from "./emailGlobalSwitch.js";
import { logger } from "./logger.js";

type ConnectionItem = { settings?: { api_key?: string; from_email?: string } };

// Inert Resend stand-in returned when email is globally disabled. Only
// `emails.send` is exercised by callers across the app; it logs and reports a
// benign success ({ data, error: null }) so no caller's error/retry path is
// triggered. Typed through `unknown` because we implement just the one method
// the app actually uses.
function disabledResendClient(): Resend {
  return {
    emails: {
      async send() {
        logger.info(
          "email: STUB (email disabled via EMAIL_ENABLED) — not sent",
        );
        return { data: { id: "email-disabled-noop" }, error: null };
      },
    },
  } as unknown as Resend;
}

async function getCredentialsFromConnection(): Promise<{
  apiKey?: string;
  fromEmail?: string;
}> {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? "depl " + process.env.WEB_REPL_RENEWAL
      : null;

  if (!xReplitToken || !hostname) {
    return {};
  }

  try {
    const data = (await fetch(
      "https://" +
        hostname +
        "/api/v2/connection?include_secrets=true&connector_names=resend",
      {
        headers: {
          Accept: "application/json",
          "X-Replit-Token": xReplitToken,
        },
      },
    ).then((res) => res.json())) as { items?: ConnectionItem[] };
    const item = data.items?.[0];
    return {
      apiKey: item?.settings?.api_key,
      fromEmail: item?.settings?.from_email,
    };
  } catch {
    return {};
  }
}

export async function getUncachableResendClient(): Promise<{
  client: Resend;
  fromEmail: string;
}> {
  // Master kill switch: when email is globally disabled, hand back an inert
  // client so every send is a logged no-op. Short-circuits before any
  // credential lookup, so a missing/rotated RESEND_API_KEY can never surface an
  // error to callers during the restricted launch.
  if (!isEmailGloballyEnabled()) {
    return {
      client: disabledResendClient(),
      fromEmail: "disabled@pulseedu.invalid",
    };
  }

  const envKey = process.env.RESEND_API_KEY;
  const envFrom = process.env.RESEND_FROM_EMAIL;

  let apiKey = envKey;
  let fromEmail = envFrom;

  if (!apiKey || !fromEmail) {
    const conn = await getCredentialsFromConnection();
    apiKey = apiKey || conn.apiKey;
    fromEmail = fromEmail || conn.fromEmail;
  }

  if (!apiKey) {
    throw new Error(
      "Resend API key not configured. Set RESEND_API_KEY in Secrets.",
    );
  }
  if (!fromEmail) {
    throw new Error(
      "Resend from-email not configured. Set RESEND_FROM_EMAIL in Secrets.",
    );
  }

  return { client: new Resend(apiKey), fromEmail };
}
