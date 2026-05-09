import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

// School-managed list of "prompt cards" the Spotlight feature rotates
// through when a student is picked. Examples: "What's a goal you're working
// on?", "Share a win from this week.", "Teach the class one fun fact."
// Admins curate this list; teachers just see one when they spin.
export const spotlightPromptsTable = pgTable(
  "spotlight_prompts",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    text: text("text").notNull(),
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    schoolActiveIdx: index("spotlight_prompts_school_active_idx").on(
      t.schoolId,
      t.active,
    ),
  }),
);

// Per-teacher rolling history of recent Spotlight picks. Used to avoid
// picking the same student twice in quick succession (no-repeat memory).
// We keep a tail and only consider the last N rows when filtering.
export const spotlightHistoryTable = pgTable(
  "spotlight_history",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    staffId: integer("staff_id").notNull(),
    studentId: text("student_id").notNull(),
    pickedAt: timestamp("picked_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    schoolStaffPickedIdx: index("spotlight_history_school_staff_picked_idx").on(
      t.schoolId,
      t.staffId,
      t.pickedAt,
    ),
  }),
);
