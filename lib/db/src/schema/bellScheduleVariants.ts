import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { bellSchedulesTable } from "./bellSchedules.js";

// ---------------------------------------------------------------------------
// Multi-schedule bell architecture.
//
// A bell_schedules row is the DAY TYPE ("Regular Day", "Early Release", ...).
// Each Day Type owns one or more SCHEDULE VARIANTS ("Grade 6", "Grade 7",
// "Default Schedule") that run simultaneously during that day. Each variant
// owns typed BLOCKS (instructional period, lunch, passing, advisory,
// homeroom, custom) with their own start/end times. ASSIGNMENT rules map a
// student attribute to a variant — grade level today, extensible to other
// kinds (academy/cohort/...) later via the `kind` column.
//
// Resolution (see api-server lib/scheduleResolver.ts):
//   student → grade → variant with a matching assignment → else the
//   variant with is_default=true → else "not configured" (never guess).
// ---------------------------------------------------------------------------

export const bellScheduleVariantsTable = pgTable(
  "bell_schedule_variants",
  {
    id: serial("id").primaryKey(),
    scheduleId: integer("schedule_id")
      .notNull()
      .references(() => bellSchedulesTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Exactly one default variant per Day Type — the fallback when no
    // assignment matches the student (and the whole schedule for schools
    // that never configure grade variants).
    isDefault: boolean("is_default").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    scheduleDefaultIdx: uniqueIndex("bell_schedule_variants_default_idx")
      .on(t.scheduleId)
      .where(sql`${t.isDefault} = true`),
    scheduleIdx: index("bell_schedule_variants_schedule_idx").on(t.scheduleId),
  }),
);

export type BellScheduleVariantRow =
  typeof bellScheduleVariantsTable.$inferSelect;

// Block types the resolver understands. "period" is instructional;
// "passing" blocks are optional — when absent, passing time is derived
// from the gap between consecutive blocks.
export const BELL_BLOCK_TYPES = [
  "period",
  "lunch",
  "passing",
  "advisory",
  "homeroom",
  "custom",
] as const;
export type BellBlockType = (typeof BELL_BLOCK_TYPES)[number];

export const bellVariantBlocksTable = pgTable(
  "bell_variant_blocks",
  {
    id: serial("id").primaryKey(),
    variantId: integer("variant_id")
      .notNull()
      .references(() => bellScheduleVariantsTable.id, { onDelete: "cascade" }),
    blockType: text("block_type").notNull().default("period"),
    // Instructional period number (matches class_sections.period). Null for
    // lunch/passing/other non-instructional blocks.
    periodNumber: integer("period_number"),
    name: text("name").notNull(),
    startTime: text("start_time").notNull(), // "HH:MM" 24h, school-local
    endTime: text("end_time").notNull(),
    // Mirrors bell_schedule_periods semantics for the on-time streak.
    includedInOnTimeStreak: boolean("included_in_on_time_streak")
      .notNull()
      .default(true),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => ({
    variantIdx: index("bell_variant_blocks_variant_idx").on(t.variantId),
    // A period number may appear at most once within a variant (lunch and
    // other null-period blocks are exempt — partial index).
    variantPeriodIdx: uniqueIndex("bell_variant_blocks_variant_period_idx")
      .on(t.variantId, t.periodNumber)
      .where(sql`${t.periodNumber} IS NOT NULL`),
  }),
);

export type BellVariantBlockRow = typeof bellVariantBlocksTable.$inferSelect;

// Assignment rules: which students follow a variant. kind='grade' with
// value = the student's grade as text ("6", "7", ...). schedule_id is
// denormalized so the DB itself can enforce "one variant per grade per
// Day Type" — without it the uniqueness would have to span a join.
export const bellVariantAssignmentsTable = pgTable(
  "bell_variant_assignments",
  {
    id: serial("id").primaryKey(),
    scheduleId: integer("schedule_id")
      .notNull()
      .references(() => bellSchedulesTable.id, { onDelete: "cascade" }),
    variantId: integer("variant_id")
      .notNull()
      .references(() => bellScheduleVariantsTable.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("grade"),
    value: text("value").notNull(),
  },
  (t) => ({
    // One rule per (day type, kind, value): a grade can't follow two
    // variants of the same Day Type.
    scheduleKindValueIdx: uniqueIndex(
      "bell_variant_assignments_schedule_kind_value_idx",
    ).on(t.scheduleId, t.kind, t.value),
    variantIdx: index("bell_variant_assignments_variant_idx").on(t.variantId),
  }),
);

export type BellVariantAssignmentRow =
  typeof bellVariantAssignmentsTable.$inferSelect;
