import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// Per-(case, student) impact rating. This is intentionally a separate table
// rather than a column on interaction_case_players (which doesn't exist —
// players are derived from interaction participants). Impact is a Core-Team
// editorial judgement about how central a student is to the *whole case
// arc*, distinct from per-incident severity and per-incident role.
//
// impact: 1 = Minor, 2 = Contributing, 3 = Significant, 4 = Driver
export const interactionCasePlayerImpactTable = pgTable(
  "interaction_case_player_impact",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    caseId: integer("case_id").notNull(),
    studentId: text("student_id").notNull(),
    impact: integer("impact").notNull().default(2),
    updatedByStaffId: integer("updated_by_staff_id"),
    updatedByName: text("updated_by_name").notNull().default(""),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    caseStudentIdx: uniqueIndex(
      "interaction_case_player_impact_case_student_idx",
    ).on(t.schoolId, t.caseId, t.studentId),
    schoolIdx: index("interaction_case_player_impact_school_idx").on(t.schoolId),
  }),
);

export type InteractionCasePlayerImpactRow =
  typeof interactionCasePlayerImpactTable.$inferSelect;
