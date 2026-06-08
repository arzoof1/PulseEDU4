import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";

/** Tracks failed login attempts per IP or per email for rate limiting / lockout. */
export const loginThrottleTable = pgTable("login_throttle", {
  throttleKey: text("throttle_key").primaryKey(),
  failCount: integer("fail_count").notNull().default(0),
  windowStart: timestamp("window_start", { withTimezone: true })
    .notNull()
    .defaultNow(),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
});

export type LoginThrottleRow = typeof loginThrottleTable.$inferSelect;
