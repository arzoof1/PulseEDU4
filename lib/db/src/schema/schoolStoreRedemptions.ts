import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  index,
} from "drizzle-orm/pg-core";

// School Store redemptions — one row per "purchase" a student makes (or a
// family/staff makes on their behalf) against the school-wide rewards
// catalog. This is the ledger the points wallet is computed from and the
// queue the Core Team fulfills.
//
// Lifecycle (status):
//   pending_approval → (item.requiresApproval) created here; NO points are
//                      held yet. Staff must approve.
//   pending          → points are HELD (deducted from the available wallet)
//                      and stock (quantity mode) is decremented. Awaiting
//                      fulfillment by the Core Team.
//   fulfilled        → handed to the student; points stay spent.
//   cancelled        → released; points are refunded (excluded from the
//                      wallet) and stock (if it had been decremented) is
//                      restored.
//
// Wallet math: available = lifetime-earned PBIS points
//   − SUM(pointsSpent) WHERE status IN ('pending','fulfilled').
// (pending_approval and cancelled never count against the wallet.)
//
// `studentId` is the canonical FLEID — an INTERNAL join key only. It must
// never be rendered to a user; surfaces display `students.local_sis_id`.
// `itemName` / `pointsSpent` are snapshots so history survives item edits
// or archival.
export const schoolStoreRedemptionsTable = pgTable(
  "school_store_redemptions",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    itemId: integer("item_id").notNull(),
    // FLEID — internal foreign key, never displayed.
    studentId: text("student_id").notNull(),
    // Snapshots taken at redemption time (item may later change/archive).
    itemName: text("item_name").notNull(),
    pointsSpent: integer("points_spent").notNull(),
    // pending_approval | pending | fulfilled | cancelled
    status: text("status").notNull().default("pending"),
    // Who initiated: 'staff' | 'parent' | 'student'.
    requestedByType: text("requested_by_type").notNull(),
    // staff.id or parents.id; null for student-initiated (the student is
    // identified by studentId above).
    requestedById: integer("requested_by_id"),
    approvedByStaffId: integer("approved_by_staff_id"),
    approvedAt: text("approved_at"),
    fulfilledByStaffId: integer("fulfilled_by_staff_id"),
    fulfilledAt: text("fulfilled_at"),
    // Snapshot of where/when the reward will be handed off, for the
    // "delivered in Mrs. Martin's 3rd period" confirmation message.
    deliverTeacherName: text("deliver_teacher_name"),
    deliverPeriod: text("deliver_period"),
    cancelledByStaffId: integer("cancelled_by_staff_id"),
    cancelledAt: text("cancelled_at"),
    cancelReason: text("cancel_reason"),
    // Whether a unit of inventory was actually decremented for this
    // redemption (only true in quantity mode once points are held). Drives
    // the restore-on-cancel decision so we never over-restore stock for
    // simple-mode or still-pending-approval rows that never decremented.
    stockHeld: boolean("stock_held").notNull().default(false),
    // Informational: were the points returned to the wallet on cancel?
    pointsRefunded: boolean("points_refunded").notNull().default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at"),
  },
  (t) => ({
    schoolStatusIdx: index("school_store_redemptions_school_status_idx").on(
      t.schoolId,
      t.status,
    ),
    schoolStudentIdx: index("school_store_redemptions_school_student_idx").on(
      t.schoolId,
      t.studentId,
    ),
    schoolItemIdx: index("school_store_redemptions_school_item_idx").on(
      t.schoolId,
      t.itemId,
    ),
  }),
);

export type SchoolStoreRedemptionRow =
  typeof schoolStoreRedemptionsTable.$inferSelect;
