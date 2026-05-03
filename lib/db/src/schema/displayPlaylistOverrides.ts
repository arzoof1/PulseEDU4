import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

// Per-display weekly schedule overrides. A display (which in this codebase
// is `display_playlists.id` — see displayPlaylists.ts) plays its own items
// as the BASE loop. An override row says: on day X, between time A and
// time B (school-local 24h HH:MM), interrupt that base loop and play the
// items from `playlist_id` instead.
//
// Conventions:
//   - day_of_week: 0 = Sunday … 6 = Saturday
//   - start_time / end_time: "HH:MM" (24h). end_time MUST be strictly >
//     start_time — overnight wraps are rejected at the API and admins
//     are asked to split them across two rows.
//   - When multiple overrides match the same instant, the deterministic
//     tie-breaker is "lowest start_time wins" (computed in the cycler).
//   - Both FKs cascade: deleting a display playlist or an override
//     playlist removes the override row automatically.
export const displayPlaylistOverridesTable = pgTable(
  "display_playlist_overrides",
  {
    id: serial("id").primaryKey(),
    // The "display" — i.e. the display_playlists row whose public URL
    // hosts this schedule. Always the same school as `playlistId`.
    displayId: integer("display_id").notNull(),
    // The playlist whose items get cycled during the override window.
    // May be the same school's school-level or owner-staff playlist.
    playlistId: integer("playlist_id").notNull(),
    dayOfWeek: integer("day_of_week").notNull(),
    startTime: text("start_time").notNull(),
    endTime: text("end_time").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    displayIdx: index("display_overrides_display_idx").on(t.displayId),
  }),
);

export type DisplayPlaylistOverrideRow =
  typeof displayPlaylistOverridesTable.$inferSelect;
