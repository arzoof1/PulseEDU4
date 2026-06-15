import type { DistrictIntegrationRow } from "@workspace/db";
import {
  resolveSchoolOrg,
  schoolCodesMatch,
  type OneRosterOrg,
  type ResolvedSchoolOrg,
  type RosterAdapter,
} from "@workspace/sis-adapters";

export type SisMappingConfig = {
  schoolOrgSourcedId?: string;
  schoolOrgIdentifier?: string;
  stateSchoolCode?: string;
};

export type ResolvedSisSchoolMapping = {
  pulseSchoolId: number;
  pulseSchoolName: string;
  pulseStateSchoolCode: string | null;
  classLinkOrg: ResolvedSchoolOrg;
  /** Merged sis_config with resolved `schoolOrgSourcedId` for adapter scoping. */
  adapterConfig: Record<string, unknown>;
};

export type ResolveSisSchoolMappingResult =
  | { ok: true; mapping: ResolvedSisSchoolMapping }
  | { ok: false; errors: string[] };

function parseMappingConfig(
  raw: Record<string, unknown> | null | undefined,
): SisMappingConfig {
  const c = raw ?? {};
  return {
    schoolOrgSourcedId:
      typeof c.schoolOrgSourcedId === "string" ? c.schoolOrgSourcedId : undefined,
    schoolOrgIdentifier:
      typeof c.schoolOrgIdentifier === "string"
        ? c.schoolOrgIdentifier
        : undefined,
    stateSchoolCode:
      typeof c.stateSchoolCode === "string" ? c.stateSchoolCode : undefined,
  };
}

/**
 * Cross-validate PulseEDU school + ClassLink org feed before roster writes.
 * Fails closed on any identifier / sourcedId mismatch.
 */
export async function resolveSisSchoolMapping(
  row: DistrictIntegrationRow,
  pulseSchool: {
    id: number;
    name: string;
    stateSchoolCode: string | null;
  },
  adapter: RosterAdapter,
): Promise<ResolveSisSchoolMappingResult> {
  const cfg = parseMappingConfig(row.sisConfig);
  const orgFeed = (await adapter.listOrgs()) as OneRosterOrg[];

  const stateCode =
    cfg.stateSchoolCode?.trim() ||
    pulseSchool.stateSchoolCode?.trim() ||
    undefined;

  const resolved = resolveSchoolOrg(orgFeed, {
    schoolOrgSourcedId: cfg.schoolOrgSourcedId,
    schoolOrgIdentifier: cfg.schoolOrgIdentifier,
    stateSchoolCode: stateCode,
  });

  if (!resolved.ok) {
    return { ok: false, errors: resolved.errors };
  }

  const errors: string[] = [];

  if (
    pulseSchool.stateSchoolCode?.trim() &&
    resolved.org.identifier?.trim() &&
    !schoolCodesMatch(pulseSchool.stateSchoolCode, resolved.org.identifier)
  ) {
    errors.push(
      `PulseEDU school "${pulseSchool.name}" state code "${pulseSchool.stateSchoolCode}" does not match ClassLink org identifier "${resolved.org.identifier}".`,
    );
  }

  if (
    stateCode &&
    resolved.org.identifier?.trim() &&
    !schoolCodesMatch(stateCode, resolved.org.identifier)
  ) {
    errors.push(
      `Configured state school code "${stateCode}" does not match ClassLink org identifier "${resolved.org.identifier}".`,
    );
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const adapterConfig: Record<string, unknown> = {
    ...(row.sisConfig ?? {}),
    schoolOrgSourcedId: resolved.org.sourcedId,
    stateSchoolCode: stateCode ?? pulseSchool.stateSchoolCode ?? undefined,
    schoolOrgIdentifier: resolved.org.identifier ?? cfg.schoolOrgIdentifier,
  };

  return {
    ok: true,
    mapping: {
      pulseSchoolId: pulseSchool.id,
      pulseSchoolName: pulseSchool.name,
      pulseStateSchoolCode: pulseSchool.stateSchoolCode,
      classLinkOrg: resolved.org,
      adapterConfig,
    },
  };
}
