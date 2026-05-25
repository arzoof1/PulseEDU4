import crypto from "node:crypto";

// Optional HMAC bearer used only when STAFF_BEARER_AUTH_ENABLED=true (legacy
// Replit preview iframe). Production staff auth is HttpOnly session cookies.

function requireTokenSecret(): string {
  const secret = process.env.AUTH_TOKEN_SECRET || process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error(
      "AUTH_TOKEN_SECRET or SESSION_SECRET is required for token signing",
    );
  }
  return secret;
}

const SECRET = requireTokenSecret();

/** Short TTL when bearer is enabled — limits XSS / post-logout exposure. */
const STAFF_BEARER_TTL_MS = 1000 * 60 * 30; // 30 minutes
const PARENT_BEARER_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours (parent portal unchanged here)

export type VerifiedStaffToken = {
  staffId: number;
  tokenVersion: number;
};

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

export function issueAuthToken(
  staffId: number,
  tokenVersion = 0,
  ttlMs = STAFF_BEARER_TTL_MS,
): string {
  const payload = JSON.stringify({
    sid: staffId,
    tv: tokenVersion,
    kind: "staff",
    exp: Date.now() + ttlMs,
  });
  const body = b64url(payload);
  return `${body}.${sign(body)}`;
}

export function verifyAuthToken(token: string): VerifiedStaffToken | null {
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
      tv?: unknown;
      kind?: unknown;
    };
    if (typeof json.sid !== "number" || typeof json.exp !== "number") {
      return null;
    }
    if (json.exp < Date.now()) return null;
    if (json.kind && json.kind !== "staff") return null;
    const tokenVersion =
      typeof json.tv === "number" && Number.isInteger(json.tv) ? json.tv : 0;
    return { staffId: json.sid, tokenVersion };
  } catch {
    return null;
  }
}

// Parent tokens carry an explicit `kind: "parent"` so they can't be confused
// with staff tokens at the middleware layer, even though both are signed with
// the same SESSION_SECRET.
export function issueParentAuthToken(
  parentId: number,
  ttlMs = PARENT_BEARER_TTL_MS,
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
