import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

// Audit + one-time-use ledger for staff self-service password reset links.
export const staffPasswordResetsTable = pgTable("staff_password_resets", {
  id: serial("id").primaryKey(),
  staffId: integer("staff_id"),
  email: text("email").notNull(),
  tokenHash: text("token_hash").unique(),
  status: text("status").notNull().default("requested"),
  requestedAt: timestamp("requested_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  usedAt: timestamp("used_at", { withTimezone: true }),
  requestIp: text("request_ip"),
  usedIp: text("used_ip"),
  userAgent: text("user_agent"),
  emailSentAt: timestamp("email_sent_at", { withTimezone: true }),
  emailError: text("email_error"),
});

export type StaffPasswordResetRow =
  typeof staffPasswordResetsTable.$inferSelect;
