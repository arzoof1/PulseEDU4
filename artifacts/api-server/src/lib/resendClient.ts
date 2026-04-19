import { Resend } from "resend";

type ConnectionItem = { settings?: { api_key?: string; from_email?: string } };

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
