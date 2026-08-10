import { customType } from "drizzle-orm/pg-core";
import { decryptField, encryptField } from "../crypto/fieldCrypto";

// Transparent column-level encryption for highly sensitive free-text
// (Section 10.6). Drop-in replacements for `text(...)` and `jsonb(...)`:
// values are encrypted on write and decrypted on read, so callers, query
// builders, and route code are unchanged. See ../crypto/fieldCrypto for the
// key model and on-disk format.
//
// IMPORTANT — safe by construction:
//   * The SQL type is preserved (`text` stays text, `jsonb` stays jsonb), so
//     NO schema migration is needed to adopt these on existing columns.
//   * Drizzle does not route SQL NULL through toDriver (see pg-core sql.js),
//     and we also guard both directions, so NULL columns stay NULL.
//   * decryptField returns unprefixed values unchanged, so legacy plaintext
//     rows and empty-string column defaults round-trip cleanly.
//   * These columns must never be used in a SQL WHERE/ORDER BY/LIKE/JOIN —
//     AES-GCM is non-deterministic. (Verified: none of the adopted columns are.)

/** Encrypted `text` column. Use exactly where you would use `text("col")`. */
export const encryptedText = customType<{ data: string; driverData: string }>({
  dataType() {
    return "text";
  },
  toDriver(value: string): string {
    return value == null ? (value as unknown as string) : encryptField(value);
  },
  fromDriver(value: string): string {
    return value == null ? (value as unknown as string) : decryptField(value);
  },
});

// Envelope stored inside an encrypted jsonb column: { "enc": "data1:..." }.
// The whole JS value is JSON-serialized, encrypted, and wrapped so the column
// remains valid jsonb (no migration) while its contents are opaque at rest.
interface EncryptedJsonEnvelope {
  enc: string;
}

function isEnvelope(value: unknown): value is EncryptedJsonEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { enc?: unknown }).enc === "string"
  );
}

/**
 * Encrypted `jsonb` column. Use where you would use `jsonb("col")`, then refine
 * the shape with `.$type<T>()` exactly as with the built-in jsonb type.
 * Matches Drizzle's jsonb driver contract: toDriver returns a JSON string,
 * fromDriver receives the parsed value from node-postgres.
 */
export const encryptedJsonb = customType<{ data: unknown; driverData: unknown }>(
  {
    dataType() {
      return "jsonb";
    },
    toDriver(value: unknown): string {
      const envelope: EncryptedJsonEnvelope = {
        enc: encryptField(JSON.stringify(value)),
      };
      return JSON.stringify(envelope);
    },
    fromDriver(value: unknown): unknown {
      if (value == null) return value;
      const parsed = typeof value === "string" ? JSON.parse(value) : value;
      if (isEnvelope(parsed)) {
        return JSON.parse(decryptField(parsed.enc));
      }
      // Legacy plaintext jsonb (pre-encryption rows) — return as-is.
      return parsed;
    },
  },
);
