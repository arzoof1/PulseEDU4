import { pgTable, serial, text, integer } from "drizzle-orm/pg-core";

// Houses are PBIS team affiliations (Falcon, Phoenix, etc.) used for the
// school-wide PBIS Houses signage screen and the broader "house cup"
// competition. A house belongs to a single school. Students may be assigned
// to at most one house via students.house_id.
export const housesTable = pgTable("houses", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull(),
  name: text("name").notNull(),
  // Tailwind-friendly hex (e.g. "#3b82f6"). Used as the bar/avatar accent
  // on the houses signage and any future house-cup surfaces.
  color: text("color").notNull(),
  // Short rallying line shown under the house name on signage. Optional.
  motto: text("motto"),
  // Lucide icon name (e.g. "Crown", "Shield", "Flame"). Optional — when
  // null the UI falls back to a colored circle with the house's first
  // letter. Kept as a free string rather than a Drizzle enum so admins
  // can pick any Lucide icon without a schema migration.
  iconKey: text("icon_key"),
  // Object-storage path (e.g. "/objects/uploads/abc123") to a custom
  // house logo PNG/SVG uploaded by an admin. When present, takes
  // priority over iconKey on printed surfaces (ID badges) and is the
  // intended path for schools that want their actual house crest on
  // student IDs. Bound to the school's ACL via bindObjectToSchool at
  // upload time. Null = fall back to iconKey, then to letter bubble.
  iconObjectKey: text("icon_object_key"),
  createdAt: text("created_at").notNull(),
});

export type HouseRow = typeof housesTable.$inferSelect;
