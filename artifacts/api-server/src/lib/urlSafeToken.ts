import { randomBytes } from "node:crypto";

// =============================================================================
// Linkifier-safe random tokens (base62)
//
// Use this for ANY token that ends up inside a URL a recipient opens from
// OUTSIDE the app: emailed password-reset / invite links, QR payloads, shared
// viewer links, signing links, etc.
//
// We deliberately avoid base64url (`randomBytes(n).toString("base64url")`).
// base64url's alphabet includes '-' and '_'; when one of those lands at the END
// of a URL, email and chat auto-linkifiers routinely strip the trailing
// character from the detected hyperlink, truncating the token by one char. The
// server then finds no matching record and returns "invalid"/404 — even seconds
// after the link was created. Roughly 1 in 32 base64url tokens ends in '-'/'_',
// so this fails intermittently and is maddening to reproduce.
//
// A pure-alphanumeric (base62) token can never be truncated this way, so these
// links work 100% of the time — through linkification, copy/paste, and trailing
// punctuation. base62 is a strict subset of the base64url charset, so any
// existing lookup/validation/hashing keeps working unchanged.
// =============================================================================

const URL_SAFE_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"; // 62 chars

// Generate `length` characters of cryptographically-random base62.
// Entropy ≈ length * log2(62) ≈ length * 5.954 bits.
//   43 chars ≈ 256 bits   (parity with randomBytes(32))
//   32 chars ≈ 190 bits   (parity with randomBytes(24))
//   24 chars ≈ 143 bits   (parity with randomBytes(18))
export function genUrlSafeToken(length = 32): string {
  if (length <= 0) return "";
  const out: string[] = [];
  // Rejection-sample bytes into 0..61 with no modulo bias: 248 = 4 * 62, so
  // bytes 248..255 are discarded and every alphabet symbol is equally likely.
  // Pull bytes in generous batches to minimize randomBytes() calls.
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b < 248) {
        out.push(URL_SAFE_ALPHABET[b % 62]);
        if (out.length === length) break;
      }
    }
  }
  return out.join("");
}
