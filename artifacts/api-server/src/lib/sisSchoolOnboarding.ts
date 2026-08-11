// Discover ClassLink school orgs that have no PulseEDU school yet, and
// onboard the ones a District Admin / SuperUser selects — the button-driven
// equivalent of scripts/src/setupClasslinkDistrict.mts (same upsert shapes,
// same org → state-code derivation), so a new school added to the district's
// Roster Server app can be brought into Pulse without SSH access.
//
// Two-phase by design, mirroring the script's dry-run → --apply:
//   discoverNewClasslinkSchools()  — read-only diff of live feed vs Pulse
//   onboardClasslinkSchools()      — create school + integration rows for an
//                                    explicit, admin-confirmed subset only.
// Never deletes or renames existing schools; onboarding an org that raced
// into existence is a no-op upsert.

import {
  db,
  districtIntegrationsTable,
  schoolsTable,
} from "@workspace/db";
import {
  buildSchoolOrgIndex,
  classlinkUsesFixtures,
  loadOneRosterFixtures,
  OneRosterLiveClient,
  resolveOneRosterBaseUrl,
  schoolCodeLookupKeys,
  type ClasslinkConfig,
  type SisSchoolOrg,
} from "@workspace/sis-adapters";
import { eq, and } from "drizzle-orm";
import { logger } from "./logger.js";

// Same env-var names the setup script and existing integration rows use.
const DEFAULT_ID_ENV = "CLASSLINK_ONEROSTER_CLIENT_ID";
const DEFAULT_SECRET_ENV = "CLASSLINK_ONEROSTER_CLIENT_SECRET";

export type DiscoveredSchoolOrg = {
  sourcedId: string;
  name: string;
  identifier: string | null;
  /** Derived PulseEDU state_school_code (identifier, else digits of sourcedId). */
  stateCode: string | null;
};

export type SchoolDiscoveryResult = {
  /** Orgs in the live feed with no matching Pulse school or integration. */
  newSchools: DiscoveredSchoolOrg[];
  /** School orgs with no identifier/state code — cannot be onboarded. */
  skippedNoCode: DiscoveredSchoolOrg[];
  /** Feed school orgs that already map to a Pulse school/integration. */
  existingCount: number;
  totalFeedSchools: number;
  usingFixtures: boolean;
};

export type OnboardedSchool = {
  schoolId: number;
  integrationId: number;
  name: string;
  stateCode: string;
  sourcedId: string;
};

export type SchoolOnboardResult = {
  ok: boolean;
  onboarded: OnboardedSchool[];
  /** Requested sourcedIds that were not onboarded, with the reason. */
  rejected: Array<{ sourcedId: string; reason: string }>;
};

/** Same derivation as the setup script: identifier, else digits of sourcedId. */
function orgStateCode(org: SisSchoolOrg): string | null {
  const id = org.identifier?.trim();
  if (id) return id;
  const digits = org.sourcedId.replace(/\D+/g, "");
  return digits || null;
}

/**
 * Build the district-level discovery config: reuse an existing ClassLink
 * integration row's sis_config (base URL + credential env-var names), falling
 * back to plain env config for a district with no integrations yet. The
 * school-scoping fields are irrelevant here — listSchoolOrgs() maps the whole
 * org feed regardless of schoolOrgSourcedId.
 */
async function getDiscoveryConfig(): Promise<ClasslinkConfig> {
  const [row] = await db
    .select({ sisConfig: districtIntegrationsTable.sisConfig })
    .from(districtIntegrationsTable)
    .where(eq(districtIntegrationsTable.sisProvider, "classlink"))
    .limit(1);
  const cfg = (row?.sisConfig ?? {}) as Record<string, unknown>;
  return {
    rostersBaseUrl:
      typeof cfg.rostersBaseUrl === "string" ? cfg.rostersBaseUrl : undefined,
    rostersClientIdEnvVar:
      typeof cfg.rostersClientIdEnvVar === "string"
        ? cfg.rostersClientIdEnvVar
        : DEFAULT_ID_ENV,
    rostersClientSecretEnvVar:
      typeof cfg.rostersClientSecretEnvVar === "string"
        ? cfg.rostersClientSecretEnvVar
        : DEFAULT_SECRET_ENV,
    useFixtures: typeof cfg.useFixtures === "boolean" ? cfg.useFixtures : undefined,
  };
}

// Orgs-only fetch — deliberately NOT the roster adapter's listSchoolOrgs(),
// which pulls the FULL district bundle (students, enrollments, …) just to
// read the org list and takes minutes on a cold cache. /orgs alone returns
// in seconds.
async function fetchFeedSchoolOrgs(
  config: ClasslinkConfig,
): Promise<SisSchoolOrg[]> {
  let orgs;
  if (classlinkUsesFixtures(config)) {
    orgs = loadOneRosterFixtures().orgs;
  } else {
    const baseUrl = resolveOneRosterBaseUrl(config.rostersBaseUrl);
    if (!baseUrl) {
      throw new Error(
        "Missing ClassLink OneRoster base URL (sis_config.rostersBaseUrl or CLASSLINK_ONEROSTER_BASE_URL).",
      );
    }
    const idVar = config.rostersClientIdEnvVar ?? DEFAULT_ID_ENV;
    const secretVar = config.rostersClientSecretEnvVar ?? DEFAULT_SECRET_ENV;
    const consumerKey = process.env[idVar]?.trim();
    const consumerSecret = process.env[secretVar]?.trim();
    if (!consumerKey || !consumerSecret) {
      throw new Error(`Missing ClassLink credentials (env ${idVar} / ${secretVar}).`);
    }
    const client = new OneRosterLiveClient({ baseUrl, consumerKey, consumerSecret });
    orgs = await client.fetchOrgs();
  }
  // Same school filter + shape as the adapter's mapOneRosterSchoolOrgs.
  return buildSchoolOrgIndex(orgs).schools.map((org) => ({
    sourcedId: org.sourcedId,
    identifier: org.identifier?.trim() ?? null,
    name: org.name,
    type: org.type,
  }));
}

/**
 * Diff the live ClassLink org feed against Pulse. An org counts as existing
 * when EITHER an integration is already configured with its sourcedId, OR a
 * Pulse school's state_school_code matches its derived code under the same
 * prefix-tolerant lookup keys the sync resolver uses (ENT8351 ≡ 8351 ≡ 08351
 * — the Wilton duplicate-org lesson).
 */
export async function discoverNewClasslinkSchools(): Promise<SchoolDiscoveryResult> {
  const config = await getDiscoveryConfig();
  const orgs = await fetchFeedSchoolOrgs(config);

  const schools = await db
    .select({ stateSchoolCode: schoolsTable.stateSchoolCode })
    .from(schoolsTable);
  const integrations = await db
    .select({ sisConfig: districtIntegrationsTable.sisConfig })
    .from(districtIntegrationsTable)
    .where(eq(districtIntegrationsTable.sisProvider, "classlink"));

  const knownCodeKeys = new Set<string>();
  for (const s of schools) {
    if (!s.stateSchoolCode) continue;
    for (const k of schoolCodeLookupKeys(s.stateSchoolCode)) knownCodeKeys.add(k);
  }
  const knownSourcedIds = new Set<string>();
  for (const i of integrations) {
    const cfg = (i.sisConfig ?? {}) as Record<string, unknown>;
    if (typeof cfg.schoolOrgSourcedId === "string" && cfg.schoolOrgSourcedId) {
      knownSourcedIds.add(cfg.schoolOrgSourcedId);
    }
  }

  const newSchools: DiscoveredSchoolOrg[] = [];
  const skippedNoCode: DiscoveredSchoolOrg[] = [];
  let existingCount = 0;

  for (const org of orgs) {
    const stateCode = orgStateCode(org);
    const entry: DiscoveredSchoolOrg = {
      sourcedId: org.sourcedId,
      name: org.name,
      identifier: org.identifier,
      stateCode,
    };
    if (!stateCode) {
      skippedNoCode.push(entry);
      continue;
    }
    const codeKnown = schoolCodeLookupKeys(stateCode).some((k) =>
      knownCodeKeys.has(k),
    );
    if (knownSourcedIds.has(org.sourcedId) || codeKnown) {
      existingCount++;
      continue;
    }
    newSchools.push(entry);
  }

  return {
    newSchools,
    skippedNoCode,
    existingCount,
    totalFeedSchools: orgs.length,
    usingFixtures: classlinkUsesFixtures(config),
  };
}

function shortNameFrom(name: string): string {
  return (
    name
      .replace(/\b(School|Middle|High|Elementary|Center)\b/gi, "")
      .trim()
      .split(/\s+/)[0] ?? name
  );
}

/**
 * Create school + ClassLink integration rows for the selected feed orgs.
 * Selection is by sourcedId and re-validated against a fresh discovery diff —
 * the client only ever tells us WHICH new org to onboard, never its name or
 * code (those come from the feed).
 */
export async function onboardClasslinkSchools(args: {
  sourcedIds: string[];
  districtId: number;
}): Promise<SchoolOnboardResult> {
  const requested = [...new Set(args.sourcedIds)];
  const discovery = await discoverNewClasslinkSchools();
  const byId = new Map(discovery.newSchools.map((o) => [o.sourcedId, o]));

  const config = await getDiscoveryConfig();
  const baseUrl = discovery.usingFixtures
    ? (config.rostersBaseUrl ?? null)
    : resolveOneRosterBaseUrl(config.rostersBaseUrl);

  const onboarded: OnboardedSchool[] = [];
  const rejected: SchoolOnboardResult["rejected"] = [];

  await db.transaction(async (tx) => {
    for (const sourcedId of requested) {
      const org = byId.get(sourcedId);
      if (!org || !org.stateCode) {
        rejected.push({
          sourcedId,
          reason: org
            ? "Org has no identifier/state code."
            : "Org is not a new school in the current feed (already onboarded, or absent).",
        });
        continue;
      }

      // School row — same conflict target as the setup script (unique on
      // district_id + state_school_code), name refreshed from the feed.
      const [school] = await tx
        .insert(schoolsTable)
        .values({
          districtId: args.districtId,
          name: org.name,
          shortName: shortNameFrom(org.name),
          stateSchoolCode: org.stateCode,
        })
        .onConflictDoUpdate({
          target: [schoolsTable.districtId, schoolsTable.stateSchoolCode],
          set: { name: org.name },
        })
        .returning({ id: schoolsTable.id });

      // Integration row — select-then-write, mirroring the script (no unique
      // key on school_name).
      const sisConfig = {
        useFixtures: config.useFixtures ?? false,
        stateSchoolCode: org.stateCode,
        schoolOrgSourcedId: org.sourcedId,
        schoolOrgIdentifier: org.identifier,
        rostersBaseUrl: baseUrl,
        rostersClientIdEnvVar: config.rostersClientIdEnvVar ?? DEFAULT_ID_ENV,
        rostersClientSecretEnvVar:
          config.rostersClientSecretEnvVar ?? DEFAULT_SECRET_ENV,
      };
      const [existing] = await tx
        .select({ id: districtIntegrationsTable.id })
        .from(districtIntegrationsTable)
        .where(
          and(
            eq(districtIntegrationsTable.schoolName, org.name),
            eq(districtIntegrationsTable.sisProvider, "classlink"),
          ),
        );
      let integrationId: number;
      if (existing) {
        await tx
          .update(districtIntegrationsTable)
          .set({ sisProvider: "classlink", sisConfig, updatedAt: new Date() })
          .where(eq(districtIntegrationsTable.id, existing.id));
        integrationId = existing.id;
      } else {
        const [inserted] = await tx
          .insert(districtIntegrationsTable)
          .values({
            schoolName: org.name,
            sisProvider: "classlink",
            sisConfig,
          })
          .returning({ id: districtIntegrationsTable.id });
        integrationId = inserted!.id;
      }

      onboarded.push({
        schoolId: school!.id,
        integrationId,
        name: org.name,
        stateCode: org.stateCode,
        sourcedId: org.sourcedId,
      });
    }
  });

  logger.info(
    {
      districtId: args.districtId,
      onboarded: onboarded.map((o) => `${o.name} (${o.stateCode})`),
      rejected,
    },
    "ClassLink school onboarding",
  );

  return { ok: rejected.length === 0, onboarded, rejected };
}
