import crypto from "node:crypto";

const RESET_TOKEN_TTL_MS = 1000 * 60 * 30; // 30 minutes

function requireTokenSecret(): string {
  const secret = process.env.AUTH_TOKEN_SECRET || process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error(
      "AUTH_TOKEN_SECRET or SESSION_SECRET is required for password reset token signing",
    );
  }
  return secret;
}

const SECRET = requireTokenSecret();

type StaffPasswordResetPayload = {
  kind: "staff_password_reset";
  resetId: number;
  staffId: number;
  exp: number;
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
  return b64url(
    crypto.createHmac("sha256", SECRET).update(payload).digest(),
  );
}

export function staffPasswordResetExpiresAt(): Date {
  return new Date(Date.now() + RESET_TOKEN_TTL_MS);
}

export function issueStaffPasswordResetToken(args: {
  resetId: number;
  staffId: number;
  expiresAt: Date;
}): string {
  const payload: StaffPasswordResetPayload = {
    kind: "staff_password_reset",
    resetId: args.resetId,
    staffId: args.staffId,
    exp: args.expiresAt.getTime(),
  };
  const body = b64url(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}

export function verifyStaffPasswordResetToken(
  token: string,
): { resetId: number; staffId: number } | null {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;

  const expected = sign(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const json = JSON.parse(fromB64url(body).toString("utf8")) as Partial<
      StaffPasswordResetPayload
    >;
    if (
      json.kind !== "staff_password_reset" ||
      typeof json.resetId !== "number" ||
      typeof json.staffId !== "number" ||
      typeof json.exp !== "number"
    ) {
      return null;
    }
    if (json.exp < Date.now()) return null;
    return { resetId: json.resetId, staffId: json.staffId };
  } catch {
    return null;
  }
}

export function hashStaffPasswordResetToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
