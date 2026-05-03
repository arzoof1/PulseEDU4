import { pgTable, serial, text, boolean, jsonb, uniqueIndex } from "drizzle-orm/pg-core";

// Named bundles of feature flags used by the SuperUser School Plans page
// to bulk-enable a set of `super_feature_*` columns on a school in one
// click. The `featureKeys` array stores the FeatureKey strings (the same
// PascalCase keys used by routes/schoolSettings.ts FEATURE_KEYS) that
// are ON in this preset; any key not listed is OFF.
//
// Built-in presets (Basic / Pro / Enterprise) are seeded at boot and
// flagged `is_built_in = true` so the UI prevents edits/deletes.
export const tierPresetsTable = pgTable(
  "tier_presets",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    isBuiltIn: boolean("is_built_in").notNull().default(false),
    featureKeys: jsonb("feature_keys").$type<string[]>().notNull().default([]),
  },
  (t) => ({
    nameUnique: uniqueIndex("tier_presets_name_unique").on(t.name),
  }),
);

export type TierPresetRow = typeof tierPresetsTable.$inferSelect;
