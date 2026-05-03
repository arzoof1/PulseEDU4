import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

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
  // "image" | "video" | "audio" | "pdf" | "url"
  // For "url" items the cycler renders an iframe of `url` and uses
  // `duration_seconds` (or playlist default) to advance.
  kind: text("kind").notNull(),
  // The `/objects/<uuid>` path returned by the storage upload
  // endpoint. We store the full path so future bucket migrations
  // are a search-and-replace, not a recompute. NULL for kind=url.
  objectPath: text("object_path"),
  originalFilename: text("original_filename"),
  mimeType: text("mime_type"),
  sizeBytes: integer("size_bytes").notNull().default(0),
  // For kind=url only — the page to embed.
  url: text("url"),
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
}, (t) => ({
  // Enforce the kind/payload XOR at the DB level so we never end up
  // with an "image" row whose object_path is NULL or a "url" row that
  // is missing its url. Mirrors the dispatch in the cycler / item
  // POST handler.
  urlXorObject: check(
    "display_playlist_items_url_xor_object_check",
    sql`(
      (${t.kind} = 'url' AND ${t.url} IS NOT NULL AND ${t.objectPath} IS NULL)
      OR (${t.kind} <> 'url' AND ${t.objectPath} IS NOT NULL AND ${t.originalFilename} IS NOT NULL AND ${t.mimeType} IS NOT NULL AND ${t.url} IS NULL)
    )`,
  ),
}));

export type DisplayPlaylistItemRow = typeof displayPlaylistItemsTable.$inferSelect;
