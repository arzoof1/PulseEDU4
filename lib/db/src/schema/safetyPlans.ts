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
import { encryptedJsonb, encryptedText } from "./_encrypted";

// Safety Plans — per-student behavioral / physical safety checklist owned
// by the school's Guidance Counselor and Core Team.
//
// Three tables:
//   1. safety_plan_library — school-wide catalog of preset items (Clear
//      backpack, No sharp objects, Escort to bathroom, …). Each school
//      gets a seeded default set on first staff visit; admins / guidance
//      counselors can add custom items.
//   2. safety_plans — exactly one row per (school, student). Holds plan-
//      level fields (active/inactive, dates, notes) plus the actual
//      checklist as a JSONB array of {label, active, note} so we can
//      include both library-derived items and per-student one-offs in
//      the same ordered list without a third join.
//   3. safety_plan_audit — every create/edit/deactivate logged with
//      actor + JSON snapshot for the Admin "history" tab.
//
// Visibility rules live in the route + client; the schema itself just
// stores the data (school-scoped for multi-tenancy).
export const safetyPlanLibraryTable = pgTable(
  "safety_plan_library",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    label: text("label").notNull(),
    // Built-in items get isBuiltIn=true so the UI can prevent renaming
    // them but still allow soft-deletion (active=false) per school.
    isBuiltIn: boolean("is_built_in").notNull().default(false),
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    schoolIdx: index("safety_plan_library_school_idx").on(t.schoolId),
    schoolLabelIdx: uniqueIndex("safety_plan_library_school_label_idx").on(
      t.schoolId,
      t.label,
    ),
  }),
);
export type SafetyPlanLibraryRow =
  typeof safetyPlanLibraryTable.$inferSelect;

// One checklist item inside a per-student safety plan. Stored inline as
// JSONB so the plan reads/writes in a single row without an extra table.
export interface SafetyPlanItem {
  label: string;
  active: boolean;
  note?: string;
}

export const safetyPlansTable = pgTable(
  "safety_plans",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    studentId: text("student_id").notNull(),
    // Status: 'active' or 'inactive'. Only 'active' plans drive the red
    // SP pill on rosters. Closing a plan keeps the row (history) but
    // hides the pill.
    status: text("status").notNull().default("active"),
    items: encryptedJsonb("items").$type<SafetyPlanItem[]>().notNull().default([]),
    notes: encryptedText("notes").notNull().default(""),
    startDate: text("start_date"),
    endDate: text("end_date"),
    createdByStaffId: integer("created_by_staff_id"),
    createdByName: text("created_by_name"),
    updatedByStaffId: integer("updated_by_staff_id"),
    updatedByName: text("updated_by_name"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    schoolIdx: index("safety_plans_school_idx").on(t.schoolId),
    // (school, student) is the natural primary key — one plan per
    // student per school. Enforced as a unique index so the upsert path
    // in the route can rely on it.
    schoolStudentIdx: uniqueIndex("safety_plans_school_student_idx").on(
      t.schoolId,
      t.studentId,
    ),
  }),
);
export type SafetyPlanRow = typeof safetyPlansTable.$inferSelect;

export const safetyPlanAuditTable = pgTable(
  "safety_plan_audit",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    studentId: text("student_id").notNull(),
    action: text("action").notNull(), // created | updated | activated | deactivated
    actorStaffId: integer("actor_staff_id"),
    actorName: text("actor_name"),
    snapshot: encryptedJsonb("snapshot").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    studentIdx: index("safety_plan_audit_student_idx").on(
      t.schoolId,
      t.studentId,
    ),
  }),
);
export type SafetyPlanAuditRow = typeof safetyPlanAuditTable.$inferSelect;
