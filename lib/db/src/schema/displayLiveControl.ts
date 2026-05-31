import { pgTable, integer, text, timestamp } from "drizzle-orm/pg-core";

// Live remote-control state for a digital-signage playlist.
//
// One row per playlist (playlist_id is the primary key). The public
// display URL `/display/<id>` polls a tiny public endpoint that reads
// this row, so a presenter can drive every TV pointed at that playlist
// WITHOUT changing the TV's URL.
//
// Modes:
//   - "auto"         → normal cycler behavior (client timers, synthetic
//                      slides, schedule overrides). The default / absence
//                      of a row is treated as "auto".
//   - "manual"       → the cycler shows ONLY this playlist's items, at the
//                      controller-set { itemIndex, pageIndex }. No timers,
//                      no synthetic slides, no overrides — a clean
//                      click-through of the playlist like PowerPoint.
//   - "presentation" → the cycler temporarily shows a *different* deck —
//                      either another playlist (presentationPlaylistId) or
//                      a single live URL (presentationUrl) — at the
//                      controller-set position, then reverts to "auto"
//                      when the session ends.
//
// Position model: { itemIndex, pageIndex }. pageIndex is only meaningful
// for multi-page PDF items (each PDF page is individually controllable);
// every other item kind uses pageIndex 0. `revision` is bumped on every
// change so TVs can cheaply detect a new command between polls.
export const displayLiveControlTable = pgTable("display_live_control", {
  // PK + FK (logical) to display_playlists.id — one control row per
  // playlist. No serial; the playlist id IS the key.
  playlistId: integer("playlist_id").primaryKey(),
  schoolId: integer("school_id").notNull(),
  mode: text("mode").notNull().default("auto"),
  itemIndex: integer("item_index").notNull().default(0),
  pageIndex: integer("page_index").notNull().default(0),
  // When mode = "presentation": the deck to show. Exactly one of
  // presentationPlaylistId / presentationUrl is set (URL wins if both,
  // but the route enforces one).
  presentationPlaylistId: integer("presentation_playlist_id"),
  presentationUrl: text("presentation_url"),
  // Monotonic counter bumped on every control change.
  revision: integer("revision").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedByStaffId: integer("updated_by_staff_id"),
});

export type DisplayLiveControlRow = typeof displayLiveControlTable.$inferSelect;
