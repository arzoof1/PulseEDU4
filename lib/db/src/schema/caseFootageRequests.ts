import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

// Per-case "we need this footage but don't have it yet" placeholder.
// Investigators ask for video out-of-band (Microsoft Teams DM to the
// admin who owns the camera system, walkie to the bus garage, etc.)
// so this table is purely an internal record of the gap + the ask:
// who requested, when, what window, why, and how it was resolved.
//
// No outbound integration. The "request" itself happens in Teams; the
// row exists so an investigator opening a stale case immediately sees
// what's still outstanding instead of forgetting they asked.
//
// `linkedClipId` lets a fulfilled request resolve into a normal video
// evidence row — the request is closed and the clip becomes the
// authoritative record of the footage. Until then the request lives
// alongside (not inside) the video clip list.
//
// Strict admin-only — every route gates on isCaseInvestigator. Same
// audience as the rest of VideoEvidencePanel.
export const caseFootageRequestsTable = pgTable(
  "case_footage_requests",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    caseId: integer("case_id").notNull(),
    // bus | hallway_camera | classroom_camera | cafeteria_camera |
    // exterior_camera | external | other. Free-form by design — the
    // sources schools care about evolve faster than enums.
    source: text("source").notNull(),
    // Free-text "Bus 12" / "200 wing west" / "cafeteria north entry".
    // Optional because `source` already implies a coarse location.
    locationText: text("location_text"),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }),
    reason: text("reason").notNull(),
    // requested | received | unavailable | cancelled
    status: text("status").notNull().default("requested"),
    requestedByStaffId: integer("requested_by_staff_id"),
    requestedByName: text("requested_by_name"),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    fulfilledByStaffId: integer("fulfilled_by_staff_id"),
    fulfilledByName: text("fulfilled_by_name"),
    fulfilledAt: timestamp("fulfilled_at", { withTimezone: true }),
    // Note left when status moves off `requested` — e.g. "received,
    // saved as cam 1 east wing 11:23-11:26", or "unavailable, bus
    // garage only retains 7 days".
    fulfillmentNote: text("fulfillment_note"),
    // When a request is fulfilled by uploading/linking a clip into
    // the case, the resulting video evidence row id is recorded here
    // so the request → clip relationship is auditable.
    linkedClipId: integer("linked_clip_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    caseIdx: index("case_footage_requests_case_idx").on(
      t.schoolId,
      t.caseId,
      t.status,
    ),
  }),
);
export type CaseFootageRequestRow =
  typeof caseFootageRequestsTable.$inferSelect;
