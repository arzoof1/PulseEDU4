import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  index,
} from "drizzle-orm/pg-core";

// Per-teacher classroom store items.
// Each row is OWNED by a single staffer (the teacher) and is only visible
// to and editable by that staffer (or an admin). Future redemption flow
// will deduct points from a student's running total when they "buy" an item.
//
// imageUrl stores the normalized object-storage path (e.g. "/objects/<uuid>")
// returned by the upload endpoint, OR null if the teacher hasn't attached
// an image yet (the UI shows a generic gift placeholder in that case).
export const classroomStoreItemsTable = pgTable(
  "classroom_store_items",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    ownerStaffId: integer("owner_staff_id").notNull(),
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
    schoolOwnerIdx: index("classroom_store_items_school_owner_idx").on(
      t.schoolId,
      t.ownerStaffId,
    ),
  }),
);

export type ClassroomStoreItemRow =
  typeof classroomStoreItemsTable.$inferSelect;
