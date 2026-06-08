import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

// -----------------------------------------------------------------------------
// staff_password_resets — one row per staff "I forgot my password" request.
// Mirrors parent_password_resets (see schema/parents.ts). The raw token is a
// URL-safe random string emailed once to the staff member; we persist only a
// SHA-256 hash of it, never the raw value. Tokens have a 1-hour TTL (short on
// purpose — possession of the inbox IS the second factor) and are marked
// `used_at` on consumption so the same link can't be replayed.
//
// We do NOT delete rows on consumption — keeping the history helps debug "I
// clicked the link twice" support calls and feeds the abuse rate-limit query.
// -----------------------------------------------------------------------------
export const staffPasswordResetsTable = pgTable(
  "staff_password_resets",
  {
    id: serial("id").primaryKey(),
    staffId: integer("staff_id").notNull(),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Optional: requester IP for abuse forensics. Stored as text (handles
    // both v4 and v6) — not indexed because we only read it during post-hoc
    // investigation.
    requestedIp: text("requested_ip"),
  },
  (t) => ({
    byStaff: index("staff_password_resets_by_staff").on(t.staffId),
  }),
);

export type StaffPasswordResetRow = typeof staffPasswordResetsTable.$inferSelect;
