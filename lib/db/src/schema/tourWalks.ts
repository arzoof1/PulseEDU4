import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// --------------------------------------------------------------------------
// School Tours — Phase 4 "Live Tour Capture".
//
// A guide scans the QR on the Tour Roadmap (printed PDF or the on-screen lead
// view), which opens a token-gated, offline-first live-walk screen. The guide
// confirms who is guiding the tour (defaults to the lead owner, but is
// editable), taps once per checkpoint as it is completed, and can jot a
// per-stop note. Taps carry CLIENT timestamps (they happen while walking, often
// offline) and are buffered locally then synced when the connection is clear,
// so the server stores the client-provided completion time, not the sync time.
//
// Multi-tenant: every row carries school_id and every query MUST filter on it.
// The live-walk surface is UNAUTHENTICATED-by-design and gated by the opaque
// per-walk `token` (mirrors the post-tour survey + kiosk enrollment pattern) —
// a guide walking the building with a phone has no session. The token is a
// linkifier-safe base62 secret minted server-side.
// --------------------------------------------------------------------------

export const TOUR_WALK_STATUSES = [
  // Container exists (token minted for the QR) but the guide has not tapped
  // "start" yet.
  "pending",
  // First checkpoint tapped / explicitly started; the clock is running.
  "in_progress",
  // Guide tapped "end tour"; endedAt is set.
  "completed",
  // Guide marked the walk abandoned (family left early, etc.). Excluded from
  // tour-length averages.
  "abandoned",
] as const;
export type TourWalkStatus = (typeof TOUR_WALK_STATUSES)[number];

export const tourWalksTable = pgTable(
  "tour_walks",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    // One live walk per lead. Resumed (not duplicated) if the guide reopens.
    tourRequestId: integer("tour_request_id").notNull(),
    // Opaque base62 token for the QR deep link (/tour/walk/<token>). Globally
    // unique so the token alone resolves the walk + its school.
    token: text("token").notNull(),
    // Who is actually guiding this tour. Defaults to the lead owner
    // (assigned_staff_id) when the walk is created, but the guide can change it
    // on the walk screen so per-guide metrics reflect who really walked it.
    guideStaffId: integer("guide_staff_id"),
    status: text("status").$type<TourWalkStatus>().notNull().default("pending"),
    // First-tap / explicit-start time and explicit-end time, both client-stamped
    // (the walk happens offline). Tour length = endedAt - startedAt.
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("tour_walks_request_unique").on(t.tourRequestId),
    uniqueIndex("tour_walks_token_unique").on(t.token),
    index("tour_walks_school_idx").on(t.schoolId),
  ],
);
export type TourWalkRow = typeof tourWalksTable.$inferSelect;

export const tourWalkStepsTable = pgTable(
  "tour_walk_steps",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    walkId: integer("walk_id").notNull(),
    tourRequestId: integer("tour_request_id").notNull(),
    // The admin-configured checkpoint key (TourCheckpoint.key) this tap belongs
    // to. Unique per walk so re-syncing the same tap is idempotent.
    checkpointKey: text("checkpoint_key").notNull(),
    // Snapshots of the checkpoint at tap time so reports survive later edits to
    // the page's checkpoint labels / durations.
    checkpointLabel: text("checkpoint_label").notNull().default(""),
    plannedMinutes: integer("planned_minutes").notNull().default(0),
    // Client-stamped completion time (the tap). Tour length + per-stop actuals
    // derive from these.
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
    // Optional staff-only note jotted during the walk — meant to capture a
    // family follow-up question for the post-tour call. NEVER family-facing.
    note: text("note").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("tour_walk_steps_walk_checkpoint_unique").on(
      t.walkId,
      t.checkpointKey,
    ),
    index("tour_walk_steps_walk_idx").on(t.walkId),
  ],
);
export type TourWalkStepRow = typeof tourWalkStepsTable.$inferSelect;
