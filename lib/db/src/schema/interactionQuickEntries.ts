import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Core-Team-managed catalog of "quick entry" templates for the Log
// Interaction modal. Selecting one in the modal pre-fills kind /
// severity / location / summary so common scenarios (hallway shove,
// cafeteria verbal, bus rumor, etc.) can be captured in two clicks.
export const interactionQuickEntriesTable = pgTable(
  "interaction_quick_entries",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    label: text("label").notNull(),
    // Must match INTERACTION_KINDS in interactions.ts
    kind: text("kind").notNull(),
    severity: integer("severity").notNull().default(2),
    location: text("location").notNull().default(""),
    summaryTemplate: text("summary_template").notNull().default(""),
    sortOrder: integer("sort_order").notNull().default(0),
    active: boolean("active").notNull().default(true),
    createdByStaffId: integer("created_by_staff_id"),
    createdByName: text("created_by_name").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    schoolIdx: index("interaction_quick_entries_school_idx").on(t.schoolId),
    schoolLabelIdx: uniqueIndex(
      "interaction_quick_entries_school_label_idx",
    ).on(t.schoolId, t.label),
  }),
);
export type InteractionQuickEntryRow =
  typeof interactionQuickEntriesTable.$inferSelect;
