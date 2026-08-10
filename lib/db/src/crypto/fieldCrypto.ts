import crypto from "node:crypto";

// =============================================================================
// Field-level at-rest encryption for highly sensitive free-text records
// (Section 10.6 of the district security remediation).
//
// Threat model: whole-disk / RDS encryption-at-rest (10.1) protects a stolen
// volume or raw backup, but ANY party who can run a normal query — a DBA, an
// Adminer session, a leaked read-only DB credential — sees these columns in
// plaintext. For the most sensitive records (Safety Plans, Investigations,
// MTSS/behavior plans, medical/support notes, family-communication notes) the
// district requires a second layer: the column value is ciphertext in the
// database itself, readable only by the application holding the key.
//
// Format (versioned so the key/algorithm can rotate later without a backfill):
//   dedicated : "data1:"  + base64(iv12) + ":" + base64(ciphertext_with_authtag)
//   fallback  : "dataf1:" + base64(iv12) + ":" + base64(ciphertext_with_authtag)
// Algorithm: AES-256-GCM, key = SHA-256(<key material>).
//
// Key model (mirrors the Section 10.5 MFA_ENC_KEY pattern):
//   * Production uses a DEDICATED secret, DATA_ENC_KEY — distinct from
//     SESSION_SECRET and MFA_ENC_KEY — so a compromise of one secret does not
//     expose the others, and each can be rotated independently. Values written
//     under it carry the "data1:" prefix.
//   * If DATA_ENC_KEY is unset (local dev / test), we derive a fallback key
//     from SESSION_SECRET (or a stable dev marker) and write the DISTINCT
//     "dataf1:" prefix. Because the prefix records which key path produced a
//     value, later SETTING DATA_ENC_KEY never orphans previously-written rows:
//     "data1:" rows use the dedicated key, "dataf1:" rows keep decrypting under
//     the fallback. PRODUCTION MUST SET DATA_ENC_KEY.
//
// Backwards-compat: `decryptField` returns any value WITHOUT a known version
// prefix unchanged, so legacy plaintext rows (and empty-string column defaults)
// round-trip cleanly. This is what makes deploying encryption safe on a table
// that already holds plaintext.
// =============================================================================

const V_DEDICATED = "data1";
const V_FALLBACK = "dataf1";

let warnedFallback = false;

function dedicatedKey(): Buffer | null {
  const raw = process.env.DATA_ENC_KEY?.trim();
  if (!raw) return null;
  return crypto.createHash("sha256").update(raw).digest();
}

function fallbackKey(): Buffer {
  const seed = process.env.SESSION_SECRET?.trim();
  // A stable marker in pure-dev (no SESSION_SECRET) so the same value
  // round-trips across process restarts in local development.
  const material = seed ? `${seed}|field-v1` : "dev-only|field-v1";
  return crypto.createHash("sha256").update(material).digest();
}

function encryptWith(version: string, key: Buffer, plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const combined = Buffer.concat([ct, tag]);
  return `${version}:${iv.toString("base64")}:${combined.toString("base64")}`;
}

function decryptWith(key: Buffer, stored: string): string {
  const parts = stored.split(":");
  if (parts.length !== 3) throw new Error("Malformed encrypted field");
  const iv = Buffer.from(parts[1], "base64");
  const combined = Buffer.from(parts[2], "base64");
  // Last 16 bytes are the GCM auth tag.
  const tag = combined.subarray(combined.length - 16);
  const ct = combined.subarray(0, combined.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** Encrypt a sensitive plaintext string for at-rest storage. */
export function encryptField(plain: string): string {
  const dedicated = dedicatedKey();
  if (dedicated) return encryptWith(V_DEDICATED, dedicated, plain);
  if (!warnedFallback) {
    // eslint-disable-next-line no-console
    console.warn(
      "[fieldCrypto] DATA_ENC_KEY not set — encrypting sensitive fields under a SESSION_SECRET-derived fallback key. Set DATA_ENC_KEY in production (Section 10.6).",
    );
    warnedFallback = true;
  }
  return encryptWith(V_FALLBACK, fallbackKey(), plain);
}

/** Decrypt an at-rest value; legacy/plaintext (unprefixed) is returned as-is. */
export function decryptField(stored: string): string {
  if (stored.startsWith(`${V_DEDICATED}:`)) {
    const key = dedicatedKey();
    if (!key) {
      throw new Error(
        "Sensitive field is in dedicated-key format but DATA_ENC_KEY is not set",
      );
    }
    return decryptWith(key, stored);
  }
  if (stored.startsWith(`${V_FALLBACK}:`)) {
    return decryptWith(fallbackKey(), stored);
  }
  // No known version prefix → legacy plaintext (or an empty-string default).
  return stored;
}

/** True if a stored value is one of our encrypted envelopes (for tests/evidence). */
export function isEncryptedField(stored: string): boolean {
  return (
    stored.startsWith(`${V_DEDICATED}:`) || stored.startsWith(`${V_FALLBACK}:`)
  );
}
