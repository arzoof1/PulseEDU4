import crypto from "node:crypto";
import { logger } from "./logger.js";
import { encryptSecret, decryptSecret } from "./secretCrypto.js";
import { isStaffMfaEnabled } from "./staffMfaSwitch.js";

// Dedicated at-rest encryption for STAFF MFA (TOTP) secrets. Per the Section
// 10.5 remediation, the key is a DEDICATED secret (MFA_ENC_KEY) — NOT derived
// from SESSION_SECRET — so a compromise of the session secret does not expose
// MFA seeds, and the two can be rotated independently.
//
// Format (versioned so the algorithm/key can rotate later):
//   "mfa1:" + base64(iv12) + ":" + base64(ciphertext_with_authtag)
// Algorithm: AES-256-GCM, key = SHA-256(MFA_ENC_KEY).
//
// Fallback: if MFA_ENC_KEY is unset (local dev / test), we defer to
// secretCrypto's SESSION_SECRET-derived key under a distinct "mfa-v1" purpose
// and warn once, so local dev works without extra setup. PRODUCTION MUST SET
// MFA_ENC_KEY. decrypt auto-detects which path a stored value used, so mixing
// (e.g. after setting the key) round-trips cleanly.

const VERSION = "mfa1";
const FALLBACK_PURPOSE = "mfa-v1";
let warnedFallback = false;

function dedicatedKey(): Buffer | null {
  const raw = process.env.MFA_ENC_KEY?.trim();
  if (!raw) return null;
  return crypto.createHash("sha256").update(raw).digest();
}

export function encryptMfaSecret(plain: string): string {
  const key = dedicatedKey();
  if (!key) {
    if (!warnedFallback) {
      logger.warn(
        "MFA_ENC_KEY not set — encrypting MFA secrets under the SESSION_SECRET-derived fallback key. Set MFA_ENC_KEY in production.",
      );
      warnedFallback = true;
    }
    return encryptSecret(plain, FALLBACK_PURPOSE);
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const combined = Buffer.concat([ct, tag]);
  return `${VERSION}:${iv.toString("base64")}:${combined.toString("base64")}`;
}

export function decryptMfaSecret(stored: string): string {
  // Not our dedicated-key format → it was written under the fallback path;
  // delegate to secretCrypto (which handles its own "v1:" + legacy plaintext).
  if (!stored.startsWith(`${VERSION}:`)) {
    return decryptSecret(stored, FALLBACK_PURPOSE);
  }
  const key = dedicatedKey();
  if (!key) {
    throw new Error(
      "MFA secret is in dedicated-key format but MFA_ENC_KEY is not set",
    );
  }
  const parts = stored.split(":");
  if (parts.length !== 3) throw new Error("Malformed MFA secret");
  const iv = Buffer.from(parts[1], "base64");
  const combined = Buffer.from(parts[2], "base64");
  const tag = combined.subarray(combined.length - 16);
  const ct = combined.subarray(0, combined.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

// ---------------------------------------------------------------------------
// Boot-time MFA_ENC_KEY configuration check (DO-07).
//
// Surfaces at startup whether a DEDICATED MFA_ENC_KEY is configured — the
// silent SESSION_SECRET-derived fallback above only warns lazily on the first
// enrollment, so a production instance with no enrollees would show no evidence
// either way. This logs the state on every boot (the "configuration evidence"),
// and can OPTIONALLY hard-fail boot — but only when MFA_ENC_KEY_REQUIRED is
// explicitly set true. It defaults OFF so deploying this can never crash an
// instance that has not set the key yet.
// ---------------------------------------------------------------------------

export type MfaEncKeyStatus = "configured" | "not_required" | "fallback";

export interface MfaEncKeyReport {
  status: MfaEncKeyStatus;
  level: "info" | "warn";
  shouldThrow: boolean;
  message: string;
}

export function isMfaEncKeyRequired(): boolean {
  const raw = process.env.MFA_ENC_KEY_REQUIRED?.trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}

// Pure decision — no env / logger reads — so every branch is unit-testable.
export function evaluateMfaEncKeyConfig(input: {
  hasKey: boolean;
  mfaEnabled: boolean;
  isProduction: boolean;
  strict: boolean;
}): MfaEncKeyReport {
  if (input.hasKey) {
    return {
      status: "configured",
      level: "info",
      shouldThrow: false,
      message: "MFA_ENC_KEY is configured (dedicated at-rest key for staff MFA).",
    };
  }
  if (!input.mfaEnabled) {
    return {
      status: "not_required",
      level: "info",
      shouldThrow: false,
      message:
        "staff MFA is disabled and MFA_ENC_KEY is unset — no dedicated key required.",
    };
  }
  return {
    status: "fallback",
    // Loud in production (a real gap), quiet in dev (expected).
    level: input.isProduction ? "warn" : "info",
    // Only enforce when explicitly opted in — never crash a prod boot by default.
    shouldThrow: input.strict,
    message:
      "MFA_ENC_KEY is NOT set — staff MFA secrets fall back to the " +
      "SESSION_SECRET-derived key. Set a dedicated MFA_ENC_KEY in production.",
  };
}

// Boot wrapper: read env, log the evidence line, and hard-fail ONLY under the
// opt-in strict flag. Call once during startup.
export function checkMfaEncKeyAtBoot(): void {
  const report = evaluateMfaEncKeyConfig({
    hasKey: !!process.env.MFA_ENC_KEY?.trim(),
    mfaEnabled: isStaffMfaEnabled(),
    isProduction: process.env.NODE_ENV === "production",
    strict: isMfaEncKeyRequired(),
  });
  if (report.shouldThrow) {
    throw new Error(
      `[mfa] ${report.message} (MFA_ENC_KEY_REQUIRED=true enforces a dedicated key.)`,
    );
  }
  logger[report.level](`[mfa] ${report.message}`);
}
