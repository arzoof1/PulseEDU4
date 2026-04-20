import { pgTable, serial, text, jsonb, timestamp } from "drizzle-orm/pg-core";

// Per-school (or per-district) selection of which external systems to use.
//
// `sisProvider` chooses the roster source (Skyward, ClassLink rostering,
// PowerSchool, none, ...). `ssoProvider` chooses the identity source
// (ClassLink SSO, Google, Clever, none, ...). Each adapter knows how to
// read its own credentials out of `sisConfig` / `ssoConfig` (typically
// references to env-var names rather than the secrets themselves).
//
// Keeping a single row per school here lets multi-district installs route
// each school to a different stack without redeploying. When no row exists
// the app falls back to local password auth and the seed roster.
export const districtIntegrationsTable = pgTable("district_integrations", {
  id: serial("id").primaryKey(),
  schoolName: text("school_name").notNull().default("default"),

  sisProvider: text("sis_provider").notNull().default("none"),
  sisConfig: jsonb("sis_config").$type<Record<string, unknown>>(),
  sisLastSyncAt: timestamp("sis_last_sync_at", { withTimezone: true }),
  sisLastSyncStatus: text("sis_last_sync_status"),

  ssoProvider: text("sso_provider").notNull().default("none"),
  ssoConfig: jsonb("sso_config").$type<Record<string, unknown>>(),

  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type DistrictIntegrationRow =
  typeof districtIntegrationsTable.$inferSelect;
