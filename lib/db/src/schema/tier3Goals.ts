import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { encryptedText } from "./_encrypted";

// Tier 3 goal versions. Goals are EDIT-AS-INSERT: every time the Core
// Team (Admin / BS / MTSS / School Psych) edits a goal, a new row is
// written rather than mutating the existing text. Older weekly records
// continue to point at the goal_version they were tracking, so historic
// scores keep their original goal context.
//
// `slot` is 1..5 — each student can have up to five concurrent goals,
// addressed by stable slot number. Multiple rows for the same slot
// represent the version history of that slot.
//
// "Currently active" for a slot = the row with the largest
// `effectiveFrom` <= today.
export const tier3GoalsTable = pgTable(
  "tier3_goals",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    studentId: text("student_id").notNull(),
    slot: integer("slot").notNull(), // 1..5
    text: encryptedText("text").notNull(),
    // School-local "YYYY-MM-DD"; defaults to today when a Core Team
    // member writes the goal for the first time.
    effectiveFrom: text("effective_from").notNull(),
    createdByStaffId: integer("created_by_staff_id"),
    createdByName: text("created_by_name"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    schoolIdx: index("tier3_goals_school_idx").on(t.schoolId),
    studentSlotIdx: index("tier3_goals_student_slot_idx").on(
      t.schoolId,
      t.studentId,
      t.slot,
      t.effectiveFrom,
    ),
  }),
);

export type Tier3GoalRow = typeof tier3GoalsTable.$inferSelect;
