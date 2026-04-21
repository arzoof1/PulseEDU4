import { pgTable, serial, text, jsonb, timestamp } from "drizzle-orm/pg-core";

// SuperUser-defined roles. The capability bundle is applied as a "preset"
// when a SuperUser/Admin clicks the role on a staff row in the matrix.
export const customRolesTable = pgTable("custom_roles", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  label: text("label").notNull(),
  capabilities: jsonb("capabilities").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type CustomRoleRow = typeof customRolesTable.$inferSelect;
