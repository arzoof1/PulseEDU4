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
    // The staff member the kiosk is FOR — i.e. whose room this is and
    // whose name shows on the kiosk masthead. For sub/proxy
    // activations this is the absent teacher, not the Core Team member
    // who activated it.
    staffId: integer("staff_id").notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    deviceLabel: text("device_label"),
    deviceFingerprint: text("device_fingerprint"),
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
    deactivatedByStaffId: integer("deactivated_by_staff_id"),
    // Phase 1 (kiosk activation cards) — provenance + audit columns.
    // enrollTokenId: the kiosk_enroll_tokens row this activation used
    //   (NULL = activated via email + password, the legacy path).
    // activatedByStaffId: who triggered the activation. For self
    //   activations this equals staffId; for Core Team sub/proxy
    //   activations it's the Core Team member, while staffId remains
    //   the absent teacher so the kiosk shows the right name.
    // proxyForStaffId: redundant with staffId when sessionKind='proxy'
    //   but kept explicit so admin queries can filter "show me all
    //   live sub coverages" without joining sessionKind.
    // sessionKind: 'password' | 'enroll' | 'proxy' — categorizes the
    //   activation for the Active Kiosks admin panel and audit log.
    enrollTokenId: integer("enroll_token_id"),
    activatedByStaffId: integer("activated_by_staff_id"),
    proxyForStaffId: integer("proxy_for_staff_id"),
    sessionKind: text("session_kind"),
    // On-Time Attendance "Done" marker. Set to the current attendance
    // period_key when the teacher taps Done at the bell — flips this kiosk
    // back to hall-pass mode for that passing window. Auto-resets logically
    // when the period_key changes (next passing window).
    onTimeEndedKey: text("on_time_ended_key"),
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
