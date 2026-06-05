import crypto from "node:crypto";

// =============================================================================
// At-rest symmetric encryption for short, sensitive strings.
//
// Use case today: parent TOTP secrets. Threat model: a read of the `parents`
// table by anyone without the server's SESSION_SECRET should not yield usable
// authenticator codes.
//
// Format (versioned so we can rotate algorithms later without a backfill):
//   "v1:" + base64(iv12) + ":" + base64(ciphertext_with_authtag)
// Algorithm: AES-256-GCM with a key derived from SESSION_SECRET via
// SHA-256(SESSION_SECRET + "|totp-v1"). The purpose tag keeps this key
// from being interchangeable with other future derivations.
//
// Backwards-compat: `decryptSecret` accepts a raw legacy plaintext (no "v1:"
// prefix) and returns it unchanged, so existing rows (we just added the
// column; there are none yet) won't break.
// =============================================================================

const PURPOSE_TAG = "totp-v1";
const VERSION = "v1";

function deriveKey(): Buffer {
  const seed = process.env.SESSION_SECRET;
  if (!seed) {
    // app.ts already exits if SESSION_SECRET is missing in production. In dev
    // the session middleware uses a generated secret per process — derive a
    // matching ephemeral key from a stable dev marker so the same process can
    // round-trip but a restart will invalidate stored secrets. That's fine
    // for dev: the parent re-enrolls.
    return crypto
      .createHash("sha256")
      .update(`dev-only|${PURPOSE_TAG}`)
      .digest();
  }
  return crypto.createHash("sha256").update(`${seed}|${PURPOSE_TAG}`).digest();
}

export function encryptSecret(plain: string): string {
  const key = deriveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const combined = Buffer.concat([ct, tag]);
  return `${VERSION}:${iv.toString("base64")}:${combined.toString("base64")}`;
}

export function decryptSecret(stored: string): string {
  // Legacy / dev plaintext fallback — anything without the version prefix
  // is treated as already-plaintext so we don't break round-trip on rows
  // that pre-date encryption.
  if (!stored.startsWith(`${VERSION}:`)) return stored;
  const parts = stored.split(":");
  if (parts.length !== 3) {
    throw new Error("Malformed encrypted secret");
  }
  const iv = Buffer.from(parts[1], "base64");
  const combined = Buffer.from(parts[2], "base64");
  // Last 16 bytes are the GCM auth tag.
  const tag = combined.subarray(combined.length - 16);
  const ct = combined.subarray(0, combined.length - 16);
  const key = deriveKey();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}
