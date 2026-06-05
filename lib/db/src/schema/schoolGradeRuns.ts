import {
  pgTable,
  serial,
  text,
  integer,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

// school_grade_runs — append-only snapshots of a calculated school grade.
// One row each time an admin clicks "Calculate" for a (school, year,
// window). Append-only so the PM1 → PM2 → PM3 progression is preserved
// and the module can show "how the estimate moved across the year."
//
// `components` holds the full per-component breakdown (value, source,
// status, and FAST sub-metrics like % tested / counts) as JSONB so the
// shape can evolve without a migration. `status` is the run's confidence:
//   - 'estimated'  → PM1/PM2 projection, or PM3 before survey match.
//   - 'provisional'→ PM3 with some but not all official inputs present.
//   - 'official'   → PM3 with all matched inputs (Phase 2).
export interface SchoolGradeRunComponent {
  key: string;
  label: string;
  value: number | null;
  source: "fast" | "manual";
  // 'computed' | 'manual' | 'pending' (no data yet) | 'projected' (LG
  // estimate at PM1/PM2).
  status: "computed" | "manual" | "pending" | "projected";
  // FAST-only detail.
  testedPct?: number | null;
  testedCount?: number | null;
  eligibleCount?: number | null;
  numerator?: number | null;
  denominator?: number | null;
  note?: string | null;
}

export interface SchoolGradeRunDetail {
  components: SchoolGradeRunComponent[];
  // Participation snapshot per tested subject.
  participation?: {
    ela?: { testedPct: number; tested: number; eligible: number };
    math?: { testedPct: number; tested: number; eligible: number };
  };
}

export const schoolGradeRunsTable = pgTable(
  "school_grade_runs",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    schoolYear: text("school_year").notNull(),
    pmWindow: text("pm_window").notNull(), // 'pm1' | 'pm2' | 'pm3'
    schoolType: text("school_type").notNull().default("middle"),
    status: text("status").notNull().default("estimated"),
    detail: jsonb("detail").$type<SchoolGradeRunDetail>().notNull(),
    totalPoints: integer("total_points").notNull(),
    totalPossible: integer("total_possible").notNull(),
    percent: integer("percent").notNull(),
    letter: text("letter").notNull(),
    createdByStaffId: integer("created_by_staff_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    schoolIdx: index("school_grade_runs_school_idx").on(t.schoolId),
    schoolYearWindowIdx: index("school_grade_runs_school_year_window_idx").on(
      t.schoolId,
      t.schoolYear,
      t.pmWindow,
    ),
  }),
);

export type SchoolGradeRunRow = typeof schoolGradeRunsTable.$inferSelect;
