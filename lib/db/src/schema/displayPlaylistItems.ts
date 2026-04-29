import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core";

// One asset inside a display playlist. Items are ordered by
// `order_index` (we always renumber on reorder, no ties).
//
// `kind` is derived from the upload's MIME at insert time so the
// public cycler doesn't have to sniff it on every render:
//   - "image" → PNG/JPEG/etc; honors `duration_seconds` (or playlist
//     default).
//   - "video" → MP4 etc; cycler ignores duration and advances on
//     <video onEnded>.
//   - "audio" → WAV/MP3; cycler shows a colored card and advances on
//     <audio onEnded>.
//   - "pdf"  → cycler renders each page via pdfjs and uses
//     `duration_seconds` *per page*.
export const displayPlaylistItemsTable = pgTable("display_playlist_items", {
  id: serial("id").primaryKey(),
  playlistId: integer("playlist_id").notNull(),
  // Densely renumbered (1, 2, 3, …) on every reorder so the public
  // cycler can sort by this column with no gaps. We don't bother
  // with fractional ordering since playlists are tiny (<200 items).
  orderIndex: integer("order_index").notNull(),
  kind: text("kind").notNull(),
  // The `/objects/<uuid>` path returned by the storage upload
  // endpoint. We store the full path so future bucket migrations
  // are a search-and-replace, not a recompute.
  objectPath: text("object_path").notNull(),
  originalFilename: text("original_filename").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull().default(0),
  // Per-item override. NULL → fall back to the playlist's default.
  // For PDFs, this is *per page*, not per file.
  durationSeconds: integer("duration_seconds"),
  // Soft enable/disable so admins can toggle without losing the
  // upload. Disabled items are returned by admin endpoints but
  // skipped by the public cycler.
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type DisplayPlaylistItemRow = typeof displayPlaylistItemsTable.$inferSelect;
