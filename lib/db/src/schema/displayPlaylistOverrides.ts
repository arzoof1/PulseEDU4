import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  date,
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
    // Optional grouping. When admins bulk-add a "passing period" the
    // server stamps every row with the same UUID + a friendly name
    // (e.g. "1st period passing"). The client uses this to offer
    // "edit/delete this day only vs the entire period". A null
    // group_id means the row is a one-off (single-day add or a row
    // whose group was later edited per-day).
    groupId: text("group_id"),
    groupName: text("group_name"),
    // Date-range gating. Both null = the row recurs every week
    // forever ("until changed"). Either set = the row only fires on
    // a date that falls within [effectiveFrom, effectiveUntil]
    // inclusive (and still must match dayOfWeek + the time window).
    // For a one-day override, both are equal to the picked date.
    // Stored as YYYY-MM-DD strings (drizzle's `date` mode "string")
    // because the cycler compares against a school-local date.
    effectiveFrom: date("effective_from", { mode: "string" }),
    effectiveUntil: date("effective_until", { mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    displayIdx: index("display_overrides_display_idx").on(t.displayId),
    groupIdx: index("display_overrides_group_idx").on(t.groupId),
  }),
);

export type DisplayPlaylistOverrideRow =
  typeof displayPlaylistOverridesTable.$inferSelect;
