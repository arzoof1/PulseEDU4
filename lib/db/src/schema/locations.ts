import { pgTable, serial, text, boolean, integer } from "drizzle-orm/pg-core";

export const locationsTable = pgTable("locations", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull(),
  externalId: text("external_id"),
  // NOTE: name has a global unique index; with multi-tenancy two schools could
  // legitimately share a location name (both have a "Library"). The DB unique
  // index is left in place for now; Day 4+ will swap it for a (school_id,name)
  // composite. Until then, location creation must avoid name collisions
  // across schools.
  name: text("name").notNull().unique(),
  kind: text("kind").notNull().default("classroom"),
  isOrigin: boolean("is_origin").notNull().default(false),
  isDestination: boolean("is_destination").notNull().default(false),
  studentVisible: boolean("student_visible").notNull().default(false),
  active: boolean("active").notNull().default(true),
  // Restroom-area model (hall-pass allowlist overhaul). A "restroom area" is a
  // named group (e.g. "B-Wing") shared by the boys + girls variant rows that
  // sit in the same part of the building. Assigning the area to a teacher grants
  // BOTH gendered variants at once. Both columns are nullable: a plain location
  // with no area/gender behaves exactly as before (the manual edge-case path).
  restroomArea: text("restroom_area"),
  // 'boys' | 'girls' | null. Only meaningful on restroom locations that belong
  // to a restroom_area; null elsewhere.
  gender: text("gender"),
  // School-wide facility default (office / clinic / nurse). When true this
  // destination is granted to EVERY teacher automatically — it never needs an
  // allowlist row and is unioned on top of the per-teacher list at the kiosk.
  schoolWideDefault: boolean("school_wide_default").notNull().default(false),
});

export type LocationRow = typeof locationsTable.$inferSelect;
