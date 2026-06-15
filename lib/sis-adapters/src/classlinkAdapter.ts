import type {
  RosterAdapter,
  SisClassSection,
  SisEnrollment,
  SisSchoolOrg,
  SisStaff,
  SisStudent,
  SisRoomAssignment,
  SsoAdapter,
} from "./types.js";
import { AdapterNotImplementedError } from "./types.js";
import { loadOneRosterFixtures } from "./oneroster/fixtures.js";
import {
  mapOneRosterClassSections,
  mapOneRosterEnrollments,
  mapOneRosterRoomAssignments,
  mapOneRosterSchoolOrgs,
  mapOneRosterStaff,
  mapOneRosterStudents,
} from "./oneroster/mapToSis.js";
import type { OneRosterFixtureBundle } from "./oneroster/types.js";

// ClassLink can be used two ways: as a OneRoster-compatible rostering
// source, and as an OIDC SSO identity provider. Many districts use both
// (rostering from Skyward, SSO from ClassLink), so the two adapter
// interfaces stay separate.

export interface ClasslinkConfig {
  /** OneRoster base URL, e.g. "https://example.classlink.com/oneroster/v1p1" */
  rostersBaseUrl?: string;
  rostersClientIdEnvVar?: string;
  rostersClientSecretEnvVar?: string;

  /**
   * When true, read roster data from on-disk OneRoster fixtures
   * (`lib/sis-adapters/fixtures/oneroster-v1p1`). Also enabled when
   * env `CLASSLINK_MOCK=true` unless explicitly set to false here.
   */
  useFixtures?: boolean;

  /** Limit sync to a single ClassLink school org `sourcedId`. */
  schoolOrgSourcedId?: string;
  /** ClassLink org `identifier` (often state school code) for school mapping. */
  schoolOrgIdentifier?: string;
  /** PulseEDU `schools.state_school_code` — validated against org identifier. */
  stateSchoolCode?: string;

  /** OIDC issuer base URL, e.g. "https://launchpad.classlink.com" */
  oidcIssuer?: string;
  oidcClientIdEnvVar?: string;
  oidcClientSecretEnvVar?: string;
  oidcRedirectUri?: string;
}

export function classlinkUsesFixtures(config: ClasslinkConfig): boolean {
  if (config.useFixtures === true) return true;
  if (config.useFixtures === false) return false;
  return process.env.CLASSLINK_MOCK?.trim().toLowerCase() === "true";
}

function normalizeClasslinkConfig(
  raw: ClasslinkConfig | Record<string, unknown>,
): ClasslinkConfig {
  const c = raw as Record<string, unknown>;
  return {
    rostersBaseUrl: c.rostersBaseUrl as string | undefined,
    rostersClientIdEnvVar: c.rostersClientIdEnvVar as string | undefined,
    rostersClientSecretEnvVar: c.rostersClientSecretEnvVar as
      | string
      | undefined,
    useFixtures: c.useFixtures as boolean | undefined,
    schoolOrgSourcedId: c.schoolOrgSourcedId as string | undefined,
    schoolOrgIdentifier: c.schoolOrgIdentifier as string | undefined,
    stateSchoolCode: c.stateSchoolCode as string | undefined,
    oidcIssuer: c.oidcIssuer as string | undefined,
    oidcClientIdEnvVar: c.oidcClientIdEnvVar as string | undefined,
    oidcClientSecretEnvVar: c.oidcClientSecretEnvVar as string | undefined,
    oidcRedirectUri: c.oidcRedirectUri as string | undefined,
  };
}

export class ClasslinkRosterAdapter implements RosterAdapter {
  readonly id = "classlink";
  readonly displayName = "ClassLink (OneRoster)";

  private readonly config: ClasslinkConfig;
  private fixtureBundle: OneRosterFixtureBundle | null = null;

  constructor(
    config: ClasslinkConfig | Record<string, unknown>,
    fixtureBundle?: OneRosterFixtureBundle,
  ) {
    this.config = normalizeClasslinkConfig(config);
    if (fixtureBundle) {
      this.fixtureBundle = fixtureBundle;
    }
  }

  private usingFixtures(): boolean {
    return classlinkUsesFixtures(this.config);
  }

  private getFixtures(): OneRosterFixtureBundle {
    if (!this.fixtureBundle) {
      this.fixtureBundle = loadOneRosterFixtures();
    }
    return this.fixtureBundle;
  }

  private requireLiveApi(): never {
    throw new AdapterNotImplementedError(
      `${this.id} live OneRoster API (set CLASSLINK_MOCK=true or useFixtures in sis_config until credentials are wired)`,
    );
  }

  async ping(): Promise<{ ok: boolean; message: string }> {
    if (this.usingFixtures()) {
      const bundle = this.getFixtures();
      const students = mapOneRosterStudents(
        bundle,
        this.config.schoolOrgSourcedId,
      ).length;
      const staff = mapOneRosterStaff(
        bundle,
        this.config.schoolOrgSourcedId,
      ).length;
      return {
        ok: true,
        message: `ClassLink mock fixtures loaded (${students} students, ${staff} staff).`,
      };
    }

    const idVar = this.config.rostersClientIdEnvVar;
    const secretVar = this.config.rostersClientSecretEnvVar;
    if (!idVar || !process.env[idVar]) {
      return { ok: false, message: "Missing ClassLink rostering client id." };
    }
    if (!secretVar || !process.env[secretVar]) {
      return {
        ok: false,
        message: "Missing ClassLink rostering client secret.",
      };
    }
    if (!this.config.rostersBaseUrl?.trim()) {
      return { ok: false, message: "Missing ClassLink OneRoster base URL." };
    }

    this.requireLiveApi();
  }

  async listStudents(): Promise<SisStudent[]> {
    if (!this.usingFixtures()) this.requireLiveApi();
    return mapOneRosterStudents(
      this.getFixtures(),
      this.config.schoolOrgSourcedId,
    );
  }

  async listStaff(): Promise<SisStaff[]> {
    if (!this.usingFixtures()) this.requireLiveApi();
    const bundle = this.getFixtures();
    const staff = mapOneRosterStaff(bundle, this.config.schoolOrgSourcedId);
    const rooms = mapOneRosterRoomAssignments(
      bundle,
      this.config.schoolOrgSourcedId,
    );
    const roomByStaff = new Map(
      rooms.map((r) => [r.staffExternalId, r.room]),
    );
    return staff.map((s) => ({
      ...s,
      primaryRoom: roomByStaff.get(s.externalId) ?? null,
    }));
  }

  async listRoomAssignments(): Promise<SisRoomAssignment[]> {
    if (!this.usingFixtures()) this.requireLiveApi();
    return mapOneRosterRoomAssignments(
      this.getFixtures(),
      this.config.schoolOrgSourcedId,
    );
  }

  async listClassSections(): Promise<SisClassSection[]> {
    if (!this.usingFixtures()) this.requireLiveApi();
    return mapOneRosterClassSections(
      this.getFixtures(),
      this.config.schoolOrgSourcedId,
    );
  }

  async listEnrollments(): Promise<SisEnrollment[]> {
    if (!this.usingFixtures()) this.requireLiveApi();
    return mapOneRosterEnrollments(
      this.getFixtures(),
      this.config.schoolOrgSourcedId,
    );
  }

  async listSchoolOrgs(): Promise<SisSchoolOrg[]> {
    if (!this.usingFixtures()) this.requireLiveApi();
    return mapOneRosterSchoolOrgs(this.getFixtures().orgs);
  }

  async listOrgs(): Promise<
    Array<{
      sourcedId: string;
      status?: string;
      name: string;
      type: string;
      identifier?: string;
    }>
  > {
    if (!this.usingFixtures()) this.requireLiveApi();
    return this.getFixtures().orgs;
  }
}

export class ClasslinkSsoAdapter implements SsoAdapter {
  readonly id = "classlink";
  readonly displayName = "ClassLink SSO";

  constructor(private readonly config: ClasslinkConfig) {}

  buildAuthorizeUrl(_state: string): string {
    throw new AdapterNotImplementedError(`${this.id}-sso`);
  }
  verifyCallback(_query: Record<string, string>): Promise<{
    externalId: string;
    email: string;
    displayName: string;
  }> {
    throw new AdapterNotImplementedError(`${this.id}-sso`);
  }
}
