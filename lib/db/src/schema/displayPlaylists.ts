import { pgTable, serial, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";

// Digital-signage playlists. Each playlist belongs to a school and is
// either school-level (owner_staff_id NULL → managed by core team) or
// owned by an individual staff member (a teacher who's been granted
// `cap_manage_displays` so they can run their own classroom TV).
//
// The public display URL is `/display/<id>` and is unauthenticated —
// anyone with the link can view (smart TVs, kiosks). Creation /
// editing is gated on the role/capability check on the server.
export const displayPlaylistsTable = pgTable("display_playlists", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull(),
  // NULL = school-level playlist (any core team member at this
  // school can edit). Non-null = owned by a specific staff member;
  // only that staff (and core team for the same school) can edit.
  ownerStaffId: integer("owner_staff_id"),
  name: text("name").notNull(),
  // Default seconds each visual item stays on screen when an item
  // doesn't override it. Videos / audio always play to their natural
  // end regardless of this value.
  defaultDurationSeconds: integer("default_duration_seconds")
    .notNull()
    .default(10),
  // When true, the cycler injects a synthetic "PBIS Houses" slide at
  // the start of each loop showing house point totals and recent
  // pop-recognition shoutouts.
  showPbisHousePage: boolean("show_pbis_house_page")
    .notNull()
    .default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type DisplayPlaylistRow = typeof displayPlaylistsTable.$inferSelect;
