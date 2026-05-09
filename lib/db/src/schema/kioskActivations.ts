import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const kioskActivationsTable = pgTable(
  "kiosk_activations",
  {
    id: serial("id").primaryKey(),
    // Tenant column. Stamped from the activating staff member's school
    // because /kiosk/activate is unauthenticated (no req.schoolId yet).
    schoolId: integer("school_id").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    room: text("room").notNull(),
    staffId: integer("staff_id").notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    deviceLabel: text("device_label"),
    deviceFingerprint: text("device_fingerprint"),
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
    deactivatedByStaffId: integer("deactivated_by_staff_id"),
  },
  (t) => ({
    // Defense-in-depth against race conditions in the activate flow:
    // even if two requests pass the conflict check simultaneously, this
    // partial unique index makes the second INSERT fail with 23505 so we
    // never end up with two live kiosks claiming the same room.
    oneLivePerRoom: uniqueIndex("kiosk_activations_one_live_per_room")
      .on(t.schoolId, t.room)
      .where(sql`deactivated_at IS NULL`),
  }),
);

export type KioskActivationRow = typeof kioskActivationsTable.$inferSelect;
