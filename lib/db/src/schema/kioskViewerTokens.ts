import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

// Read-only "viewer" tokens for the Hall Pass Kiosk feature. A teacher can
// mint one of these from the Companion Queue Panel and surface it as a QR
// code so anyone in the room (paraprofessional, co-teacher) can pull up the
// current waiting line on their phone — strictly view-only, no add/remove.
//
// The token is cryptographically tied to a single kiosk_activations row;
// when that activation is deactivated (or expires), the viewer endpoint
// returns 410 Gone so distributed QR codes go dark on take-over. This
// matches the "clean handoff" rule we set on activation.
export const kioskViewerTokensTable = pgTable(
  "kiosk_viewer_tokens",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    kioskActivationId: integer("kiosk_activation_id").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    createdByStaffId: integer("created_by_staff_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => ({
    activationIdx: index("kiosk_viewer_tokens_activation_idx").on(
      t.kioskActivationId,
    ),
  }),
);

export type KioskViewerTokenRow = typeof kioskViewerTokensTable.$inferSelect;
