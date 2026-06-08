import crypto from "node:crypto";

// Short-lived HMAC-signed bearer token used as a fallback for privileged
// endpoints when the browser blocks the session cookie (e.g. inside the
// Replit preview iframe). The token is signed with SESSION_SECRET so the
// client cannot forge or modify it.

const SECRET =
  process.env.SESSION_SECRET ||
  process.env.AUTH_TOKEN_SECRET ||
  "dev-only-insecure-secret-change-me";

const DEFAULT_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function fromB64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function sign(payload: string): string {
  return b64url(crypto.createHmac("sha256", SECRET).update(payload).digest());
}

export function issueAuthToken(staffId: number, ttlMs = DEFAULT_TTL_MS): string {
  const payload = JSON.stringify({ sid: staffId, exp: Date.now() + ttlMs });
  const body = b64url(payload);
  return `${body}.${sign(body)}`;
}

export function verifyAuthToken(token: string): number | null {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = sign(body);
  // Constant-time compare
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const json = JSON.parse(fromB64url(body).toString("utf8")) as {
      sid?: unknown;
      exp?: unknown;
      // `kind` is set on parent tokens so a parent bearer cannot be
      // mistaken for a staff bearer (and vice versa). Older staff tokens
      // do not carry a `kind` and must be treated as staff.
      kind?: unknown;
    };
    if (typeof json.sid !== "number" || typeof json.exp !== "number") {
      return null;
    }
    if (json.exp < Date.now()) return null;
    // Reject parent-kind tokens here; verifyParentAuthToken handles those.
    if (json.kind && json.kind !== "staff") return null;
    return json.sid;
  } catch {
    return null;
  }
}

// Parent tokens carry an explicit `kind: "parent"` so they can't be confused
// with staff tokens at the middleware layer, even though both are signed with
// the same SESSION_SECRET.
export function issueParentAuthToken(
  parentId: number,
  ttlMs = DEFAULT_TTL_MS,
): string {
  const payload = JSON.stringify({
    sid: parentId,
    kind: "parent",
    exp: Date.now() + ttlMs,
  });
  const body = b64url(payload);
  return `${body}.${sign(body)}`;
}

export function verifyParentAuthToken(token: string): number | null {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = sign(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const json = JSON.parse(fromB64url(body).toString("utf8")) as {
      sid?: unknown;
      exp?: unknown;
      kind?: unknown;
    };
    if (
      typeof json.sid !== "number" ||
      typeof json.exp !== "number" ||
      json.kind !== "parent"
    ) {
      return null;
    }
    if (json.exp < Date.now()) return null;
    return json.sid;
  } catch {
    return null;
  }
}
