import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  index,
} from "drizzle-orm/pg-core";

// School-wide store items.
// Unlike classroom_store_items (owned by a single staffer), these rows are
// shared across the entire school: any staff member can view the catalog,
// but only school admins can create / edit / delete entries. The future
// student-redemption flow will deduct points from a student's running
// total when they "buy" an item from this catalog.
//
// imageUrl stores the normalized object-storage path (e.g. "/objects/<uuid>")
// returned by the upload endpoint, OR null if no thumbnail has been
// attached yet (the UI shows a generic gift placeholder in that case).
export const schoolStoreItemsTable = pgTable(
  "school_store_items",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    pointsCost: integer("points_cost").notNull().default(1),
    imageUrl: text("image_url"),
    sortOrder: integer("sort_order").notNull().default(0),
    archived: boolean("archived").notNull().default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at"),
  },
  (t) => ({
    schoolIdx: index("school_store_items_school_idx").on(t.schoolId),
  }),
);

export type SchoolStoreItemRow = typeof schoolStoreItemsTable.$inferSelect;
