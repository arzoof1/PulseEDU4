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

// Per-school configurable catalog of case-closure outcomes. Closing a case
// REQUIRES picking one of these (no skip path), so admins control the
// vocabulary their team uses to summarize how an investigation ended.
//
// `code` is the stable identifier stored on `interaction_cases.outcome_code`.
// `label` is what staff see. `active=false` retires an outcome from new
// closures without orphaning the historical cases that already cite it.
//
// Defaults seeded per school by `ensureCaseOutcomeCatalogSchema` in seed.ts.
export const caseOutcomeTypesTable = pgTable(
  "case_outcome_types",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    code: text("code").notNull(),
    label: text("label").notNull(),
    description: text("description").notNull().default(""),
    sortOrder: integer("sort_order").notNull().default(0),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdByName: text("created_by_name").notNull().default(""),
  },
  (t) => ({
    schoolIdx: index("case_outcome_types_school_idx").on(t.schoolId),
    schoolCodeIdx: uniqueIndex("case_outcome_types_school_code_idx").on(
      t.schoolId,
      t.code,
    ),
  }),
);
export type CaseOutcomeTypeRow = typeof caseOutcomeTypesTable.$inferSelect;

// Default catalog applied to every school on first run. Each entry's `code`
// is what we'll persist on closed cases — keep these stable, the labels
// are safe to retitle in the catalog editor without losing history.
export const DEFAULT_CASE_OUTCOMES: ReadonlyArray<{
  code: string;
  label: string;
  description: string;
  sortOrder: number;
}> = [
  {
    code: "no_action",
    label: "No action needed",
    description:
      "Investigated; no behavioral consequence warranted (false alarm, misunderstanding, or fully resolved at the source).",
    sortOrder: 10,
  },
  {
    code: "conflict_resolution",
    label: "Conflict resolution",
    description:
      "Mediated conversation between the involved students; agreement reached.",
    sortOrder: 20,
  },
  {
    code: "mediation",
    label: "Restorative mediation",
    description:
      "Structured restorative session with facilitator; documented agreement on file.",
    sortOrder: 30,
  },
  {
    code: "parent_contact",
    label: "Parent contact",
    description:
      "Parent/guardian notified; outcome handled in coordination with the family.",
    sortOrder: 40,
  },
  {
    code: "office_referral",
    label: "Office referral",
    description: "Referred to administration for disciplinary follow-up.",
    sortOrder: 50,
  },
  {
    code: "iss_assigned",
    label: "ISS assigned",
    description: "In-school suspension assigned. Recorded in ISS log.",
    sortOrder: 60,
  },
  {
    code: "oss_assigned",
    label: "OSS assigned",
    description: "Out-of-school suspension assigned.",
    sortOrder: 70,
  },
  {
    code: "safety_plan_update",
    label: "Safety plan updated",
    description:
      "Student safety plan was revised based on this investigation's findings.",
    sortOrder: 80,
  },
  {
    code: "other",
    label: "Other (note required)",
    description:
      "Use sparingly — closing with this outcome requires a written note describing what happened.",
    sortOrder: 99,
  },
];
