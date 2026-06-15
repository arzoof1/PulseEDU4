import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Per-teacher long-lived enrollment credentials for one-tap kiosk
// activation via printed card (QR + Code 128 + 6-digit PIN). Distinct
// from kiosk_activations: this is the *credential* a teacher carries,
// not the *device session* they create when they scan it.
//
// Three encodings, one secret per teacher:
//   - QR code: encodes a URL like /kiosk?enroll=<raw_token>
//   - Code 128 barcode: encodes the same raw_token for hardware scanners
//   - 6-digit PIN: typed when no scanner / no phone available
//
// We store hashes (sha256 for the token, bcrypt for the PIN — PIN has
// only 1M possible values so bcrypt's cost matters) and rotate on
// "Reissue card" or teacher self-revoke.
export const kioskEnrollTokensTable = pgTable(
  "kiosk_enroll_tokens",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    staffId: integer("staff_id").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    // bcrypt of the 6-digit PIN. Nullable so future bulk-issue flows
    // could create token-only cards if a school disables typed PINs.
    pinHash: text("pin_hash"),
    // Reversibly-encrypted copy of the same 6-digit PIN (AES-256-GCM via
    // secretCrypto, purpose "kiosk-pin-v1"). Lets the OWNING teacher read
    // back the exact code printed on their badge from the Hall Pass gear
    // ("Get kiosk URL" tab) without an admin reprint. Owner-only reveal —
    // never exposed cross-staff. Nullable: tokens issued before this column
    // existed have no recoverable PIN (teacher must get a fresh badge).
    pinEncrypted: text("pin_encrypted"),
    label: text("label"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdByStaffId: integer("created_by_staff_id"),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByStaffId: integer("revoked_by_staff_id"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => ({
    // At most one live enrollment token per teacher per school.
    // "Reissue card" must revoke-then-insert in a single transaction.
    oneLivePerStaff: uniqueIndex("kiosk_enroll_tokens_one_live_per_staff")
      .on(t.schoolId, t.staffId)
      .where(sql`revoked_at IS NULL`),
  }),
);

export type KioskEnrollTokenRow =
  typeof kioskEnrollTokensTable.$inferSelect;
