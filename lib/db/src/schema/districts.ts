import { pgTable, serial, text, boolean, timestamp } from "drizzle-orm/pg-core";

// A district is the top-level tenant. In silo-per-district production this
// row identifies which Postgres schema (or RDS instance) the request lives
// in. In dev/Replit we keep all districts in the same schema and scope by
// district_id + school_id on each row.
export const districtsTable = pgTable("districts", {
  id: serial("id").primaryKey(),
  // Display name shown in the UI ("Hernando County School District").
  name: text("name").notNull(),
  // Short slug used in URLs / tenant routing ("hernando").
  slug: text("slug").notNull().unique(),
  // State-issued district code if applicable ("27" for Hernando, FL).
  stateDistrictCode: text("state_district_code"),
  // IANA timezone for date bucketing (e.g. "America/New_York"). Per-district
  // for now; per-school override added later if needed.
  timezone: text("timezone").notNull().default("America/New_York"),
  active: boolean("active").notNull().default(true),
  // District-level branding for School Tours brag pages. Set once by a
  // SuperUser; every school in the district inherits it and cannot change
  // it. The logo is an object-storage key (/objects/...), streamed publicly
  // by ACL-bypass like tour photos. Each placement is an independent toggle.
  logoObjectKey: text("logo_object_key"),
  tagline: text("tagline"),
  brandHeroTop: boolean("brand_hero_top").notNull().default(true),
  brandDocuments: boolean("brand_documents").notNull().default(true),
  brandFooter: boolean("brand_footer").notNull().default(false),
  brandWatermark: boolean("brand_watermark").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type DistrictRow = typeof districtsTable.$inferSelect;
