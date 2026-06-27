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
    // -----------------------------------------------------------------
    // Inventory + redemption customization (school-configurable).
    //
    // A school picks ONE inventory mode in school_settings
    // (school_store_inventory_mode): "simple" or "quantity".
    //
    //   simple   → availability is the manual `inStock` toggle below.
    //              `quantityOnHand` is ignored.
    //   quantity → availability is derived from `quantityOnHand` (> 0 is
    //              in stock); each fulfilled/approved redemption decrements
    //              it and a cancellation restores it. `inStock` is ignored.
    // -----------------------------------------------------------------
    // Manual in/out-of-stock flag — the source of truth in "simple" mode.
    inStock: boolean("in_stock").notNull().default(true),
    // Tracked count — the source of truth in "quantity" mode. NULL means
    // "untracked" (treated as unlimited even if the school is in quantity
    // mode); a non-null value is decremented atomically on redemption.
    quantityOnHand: integer("quantity_on_hand"),
    // Optional per-student cap: a student may hold at most this many
    // active (pending/approved/fulfilled) redemptions of this item.
    // NULL = unlimited. Applies in every inventory mode.
    perStudentLimit: integer("per_student_limit"),
    // When true, a redemption lands in `pending_approval` and NO points are
    // deducted until a staff member approves it. When false, points are
    // deducted atomically at redemption time.
    requiresApproval: boolean("requires_approval").notNull().default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at"),
  },
  (t) => ({
    schoolIdx: index("school_store_items_school_idx").on(t.schoolId),
  }),
);

export type SchoolStoreItemRow = typeof schoolStoreItemsTable.$inferSelect;
