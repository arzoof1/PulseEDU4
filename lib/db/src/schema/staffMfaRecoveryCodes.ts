import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

// Single-use MFA recovery codes for staff (Gate A / item 1.9). Each code is
// shown to the user exactly once at enrollment; only its bcrypt HASH is
// stored here, so a database read can never reveal a usable code. Consuming a
// code stamps used_at — codes are one-time. Regenerating recovery codes
// replaces a staff member's whole set.
export const staffMfaRecoveryCodesTable = pgTable(
  "staff_mfa_recovery_codes",
  {
    id: serial("id").primaryKey(),
    staffId: integer("staff_id").notNull(),
    codeHash: text("code_hash").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    staffIdx: index("staff_mfa_recovery_codes_staff_idx").on(t.staffId),
  }),
);

export type StaffMfaRecoveryCodeRow =
  typeof staffMfaRecoveryCodesTable.$inferSelect;
