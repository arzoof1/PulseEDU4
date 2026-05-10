import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  boolean,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// Per-school registry of named security cameras. Schools commonly run
// 100–300+ cameras with long, structured names (e.g. "Building 4 / 2nd
// Floor / East Hallway / Cam 12"). Forcing admins to retype that into
// every footage row caused typos, drift, and review friction — the
// registry lets them pick from a dropdown once configured.
//
// Soft-delete via `active` rather than hard DELETE. Historical
// `case_video_evidence` rows store the camera name as TEXT and never
// FK into this table, so a deleted camera doesn't break audit history;
// it just disappears from the dropdown.
//
// Composite unique on (school_id, lower(name)) prevents duplicate
// registrations within a school but allows two schools to use the same
// name. `location` is an optional free-form column for the human-
// readable place ("3rd floor north stairwell") that admins want to
// document but didn't want to bake into the name itself.
export const cameraRegistryTable = pgTable(
  "case_camera_registry",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    name: text("name").notNull(),
    location: text("location"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // Case-insensitive uniqueness — defined in raw SQL in the ensure
    // function (drizzle's uniqueIndex doesn't currently emit lower()).
    // This index is here for the read path: list-by-school is a hot
    // query (every footage form opens it).
    schoolActiveIdx: index("case_camera_registry_school_active_idx").on(
      t.schoolId,
      t.active,
    ),
    schoolNameIdx: uniqueIndex("case_camera_registry_school_name_uidx").on(
      t.schoolId,
      t.name,
    ),
  }),
);
export type CameraRegistryRow = typeof cameraRegistryTable.$inferSelect;
