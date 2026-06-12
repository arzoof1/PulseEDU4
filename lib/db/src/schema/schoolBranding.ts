import {
  pgTable,
  serial,
  text,
  integer,
  uniqueIndex,
  timestamp,
} from "drizzle-orm/pg-core";

// =============================================================================
// school_branding — per-school visual customization for the printed reports,
// the HeartBEAT parent snapshot, and the Kiosk masthead.
//
// One row per school. Falls back to PulseEDU defaults when missing.
// =============================================================================
export const schoolBrandingTable = pgTable(
  "school_branding",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    // 1 to 4 hex colors (#rrggbb). Stored as a JSON array string so we can
    // keep it portable across drizzle-kit versions without a Postgres array.
    // Resolved by the client into a CSS gradient (or solid if length === 1).
    gradientColorsJson: text("gradient_colors_json").notNull().default("[]"),
    // 0 to 360 degrees. Default 90 = left-to-right.
    gradientAngle: integer("gradient_angle").notNull().default(90),
    // Optional explicit primary/accent overrides. If null, the first/last
    // gradient color is used as a sensible default.
    primaryColor: text("primary_color"),
    accentColor: text("accent_color"),
    // Object-storage path of the uploaded logo (e.g. "/objects/<uuid>"),
    // bound to the school via the existing storage ACL flow.
    logoObjectPath: text("logo_object_path"),
    // Optional friendlier name to print on the report header (e.g.
    // "Parrott Middle Leopards"). When null, fall back to schools.name.
    displayNameOverride: text("display_name_override"),
    // Branded primary-action button. Background is stored as the same
    // colors[]+angle shape as the header (1 hex = solid fill, 2-4 hex = a
    // linear-gradient at the given angle). Text/foreground is a single hex.
    // All nullable — when null the app falls back to the existing
    // var(--primary)/white styling.
    buttonRestBgColorsJson: text("button_rest_bg_colors_json"),
    buttonRestBgAngle: integer("button_rest_bg_angle").default(90),
    buttonRestText: text("button_rest_text"),
    buttonHoverBgColorsJson: text("button_hover_bg_colors_json"),
    buttonHoverBgAngle: integer("button_hover_bg_angle").default(90),
    buttonHoverText: text("button_hover_text"),
    // ---------------------------------------------------------------------
    // Student ID card designer. All nullable/defaulted so existing rows keep
    // the legacy look (house-colored top band) until a school customizes.
    // ---------------------------------------------------------------------
    // Top-region background mode: 'colors' (1-2 hex, solid or diagonal
    // gradient) or 'image' (uploaded photo behind the upper portion).
    cardBgMode: text("card_bg_mode").notNull().default("colors"),
    // 1-2 hex for the top background when mode='colors'. JSON array string,
    // same portability rationale as gradientColorsJson. Empty = fall back to
    // primary/accent, then to the student's house color.
    cardBgColorsJson: text("card_bg_colors_json").notNull().default("[]"),
    cardBgAngle: integer("card_bg_angle").notNull().default(135),
    // Object-storage path of the uploaded top background image (mode='image').
    cardBgObjectPath: text("card_bg_object_path"),
    // Header/name text color: 'auto' (contrast against the background) or
    // 'manual' (cardHeaderTextColor hex).
    cardHeaderTextMode: text("card_header_text_mode").notNull().default("auto"),
    cardHeaderTextColor: text("card_header_text_color"),
    // Optional house footer band (the "HOUSE PHOENIX" row in the reference).
    cardShowHouse: integer("card_show_house").notNull().default(1),
    // Footer band background: 'house' (the student's house color), 'white',
    // or 'custom' (cardHouseBgColor hex).
    cardHouseBgMode: text("card_house_bg_mode").notNull().default("house"),
    cardHouseBgColor: text("card_house_bg_color"),
    // Footer text color: 'auto' (contrast) or 'manual' (cardHouseTextColor).
    cardHouseTextMode: text("card_house_text_mode").notNull().default("auto"),
    cardHouseTextColor: text("card_house_text_color"),
    // Physical badge orientation: 'landscape' (CR80 horizontal, the legacy
    // look) or 'portrait' (tall lanyard-style ID — corner ribbons, lanyard
    // slot, icon rows, house emblem, navy crisis bar). Per-school choice.
    cardOrientation: text("card_orientation").notNull().default("landscape"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedByStaffId: integer("updated_by_staff_id"),
  },
  (t) => ({
    schoolIdUnique: uniqueIndex("school_branding_school_unique").on(t.schoolId),
  }),
);

export type SchoolBrandingRow = typeof schoolBrandingTable.$inferSelect;
