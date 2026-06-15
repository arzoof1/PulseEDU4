// Public entry point for the SIS / SSO adapter package.
//
// Use `getRosterAdapter(provider, config)` (and the SSO equivalent) instead
// of importing concrete adapters directly, so adding a new vendor only
// requires one new branch here.

export * from "./types.js";
export { SkywardAdapter } from "./skywardAdapter.js";
export {
  ClasslinkRosterAdapter,
  ClasslinkSsoAdapter,
  classlinkUsesFixtures,
} from "./classlinkAdapter.js";
export type { ClasslinkConfig } from "./classlinkAdapter.js";
export {
  loadOneRosterFixtures,
  oneRosterFixtureDir,
  ONEROSTER_FIXTURE_BASE_URL,
} from "./oneroster/fixtures.js";
export type * from "./oneroster/types.js";
export {
  resolveSchoolOrg,
  schoolCodesMatch,
  buildSchoolOrgIndex,
} from "./oneroster/schoolMapping.js";
export type {
  ResolvedSchoolOrg,
  SchoolOrgMappingConfig,
} from "./oneroster/schoolMapping.js";
export {
  mapStudentDemographics,
  parseOptionalBoolFlag,
} from "./oneroster/demographicsMap.js";

import type { RosterAdapter, SsoAdapter } from "./types.js";
import { SkywardAdapter } from "./skywardAdapter.js";
import { ClasslinkRosterAdapter, ClasslinkSsoAdapter } from "./classlinkAdapter.js";

export const SUPPORTED_SIS_PROVIDERS = ["none", "skyward", "classlink"] as const;
export type SisProviderId = (typeof SUPPORTED_SIS_PROVIDERS)[number];

export const SUPPORTED_SSO_PROVIDERS = ["none", "classlink"] as const;
export type SsoProviderId = (typeof SUPPORTED_SSO_PROVIDERS)[number];

export function getRosterAdapter(
  provider: SisProviderId,
  config: Record<string, unknown> | null | undefined,
): RosterAdapter | null {
  const cfg = (config ?? {}) as Record<string, unknown>;
  switch (provider) {
    case "skyward":
      return new SkywardAdapter({
        baseUrl: String(cfg.baseUrl ?? ""),
        apiKeyEnvVar: String(cfg.apiKeyEnvVar ?? "SKYWARD_API_KEY"),
        districtCode: cfg.districtCode as string | undefined,
      });
    case "classlink":
      return new ClasslinkRosterAdapter(cfg);
    case "none":
    default:
      return null;
  }
}

export function getSsoAdapter(
  provider: SsoProviderId,
  config: Record<string, unknown> | null | undefined,
): SsoAdapter | null {
  const cfg = (config ?? {}) as Record<string, unknown>;
  switch (provider) {
    case "classlink":
      return new ClasslinkSsoAdapter(cfg);
    case "none":
    default:
      return null;
  }
}
