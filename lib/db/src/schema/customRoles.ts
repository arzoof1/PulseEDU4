import {
  pgTable,
  serial,
  text,
  jsonb,
  timestamp,
  integer,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { districtsTable } from "./districts";

// SuperUser-defined roles. The capability bundle is applied as a "preset"
// when a SuperUser/Admin clicks the role on a staff row in the matrix.
//
// District-scoped (D6 follow-up). Each district maintains its own role
// catalog: Hernando's "Behavior Tech" preset is independent from Pasco's,
// and the same `key` may exist in both districts. Composite unique on
// (district_id, key) replaces the prior global unique on `key`.
export const customRolesTable = pgTable(
  "custom_roles",
  {
    id: serial("id").primaryKey(),
    districtId: integer("district_id")
      .notNull()
      .references(() => districtsTable.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    capabilities: jsonb("capabilities").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    districtKeyUnique: uniqueIndex("custom_roles_district_key_uq").on(
      t.districtId,
      t.key,
    ),
  }),
);

export type CustomRoleRow = typeof customRolesTable.$inferSelect;
