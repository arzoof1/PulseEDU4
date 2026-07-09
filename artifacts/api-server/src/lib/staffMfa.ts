import crypto from "node:crypto";
import { authenticator } from "otplib";

// Staff MFA PURE primitives: TOTP (shared secret) + recovery-code generation
// and normalization. Deliberately free of any DB import so this module stays
// unit-testable without a database. DB-backed storage/consumption of recovery
// codes lives in staffMfaStore.ts.

authenticator.options = { window: 1 };
const TOTP_ISSUER = "PulseEDU";

export function generateTotpSecret(): string {
  return authenticator.generateSecret();
}

export function buildOtpauthUri(email: string, secret: string): string {
  return authenticator.keyuri(email, TOTP_ISSUER, secret);
}

export function verifyTotp(secret: string, code: unknown): boolean {
  if (typeof code !== "string") return false;
  const trimmed = code.trim().replace(/\s+/g, "");
  if (!/^\d{6}$/.test(trimmed)) return false;
  try {
    return authenticator.check(trimmed, secret);
  } catch {
    return false;
  }
}

// ---- Recovery codes -------------------------------------------------------

// No-confusion alphabet (no O/0, I/1). Codes are formatted "XXXXX-XXXXX".
const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomBlock(len: number): string {
  let out = "";
  for (let i = 0; i < len; i++) {
    out += RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)];
  }
  return out;
}

export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => `${randomBlock(5)}-${randomBlock(5)}`);
}

export function normalizeRecoveryCode(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}
