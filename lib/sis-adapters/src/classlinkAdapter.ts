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
import {
  OneRosterLiveClient,
  resolveClasslinkBaseUrl,
  resolveClasslinkTokenUrl,
} from "./oneroster/liveClient.js";
import type { OneRosterFixtureBundle } from "./oneroster/types.js";

// ClassLink can be used two ways: as a OneRoster-compatible rostering
// source, and as an OIDC SSO identity provider. Many districts use both
// (rostering from Skyward, SSO from ClassLink), so the two adapter
// interfaces stay separate.

export interface ClasslinkConfig {
  /** OneRoster base URL, e.g. "https://example.classlink.com/oneroster/v1p1" */
  rostersBaseUrl?: string;
  /** OAuth2 token URL (defaults to ClassLink proxy or CLASSLINK_ONEROSTER_TOKEN_URL). */
  rostersTokenUrl?: string;
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
    rostersTokenUrl: c.rostersTokenUrl as string | undefined,
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

function readRosterCredential(
  envVarName: string | undefined,
  fallbackEnvName: string,
): string | null {
  if (envVarName) {
    const fromNamed = process.env[envVarName]?.trim();
    if (fromNamed) return fromNamed;
  }
  const fromFallback = process.env[fallbackEnvName]?.trim();
  return fromFallback || null;
}

export class ClasslinkRosterAdapter implements RosterAdapter {
  readonly id = "classlink";
  readonly displayName = "ClassLink (OneRoster)";

  private readonly config: ClasslinkConfig;
  private fixtureBundle: OneRosterFixtureBundle | null = null;
  private liveBundle: OneRosterFixtureBundle | null = null;

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

  private buildLiveClient(): OneRosterLiveClient {
    const baseUrl = resolveClasslinkBaseUrl(this.config.rostersBaseUrl);
    if (!baseUrl) {
      throw new Error("Missing ClassLink OneRoster base URL.");
    }

    const clientId = readRosterCredential(
      this.config.rostersClientIdEnvVar,
      "CLASSLINK_ONEROSTER_CLIENT_ID",
    );
    if (!clientId) {
      throw new Error("Missing ClassLink rostering client id.");
    }

    const clientSecret = readRosterCredential(
      this.config.rostersClientSecretEnvVar,
      "CLASSLINK_ONEROSTER_CLIENT_SECRET",
    );
    if (!clientSecret) {
      throw new Error("Missing ClassLink rostering client secret.");
    }

    return new OneRosterLiveClient({
      baseUrl,
      tokenUrl: resolveClasslinkTokenUrl(this.config.rostersTokenUrl),
      clientId,
      clientSecret,
    });
  }

  private async getRosterBundle(): Promise<OneRosterFixtureBundle> {
    if (this.usingFixtures()) {
      return this.getFixtures();
    }
    if (!this.liveBundle) {
      const client = this.buildLiveClient();
      this.liveBundle = await client.fetchFixtureBundle(
        this.config.schoolOrgSourcedId,
      );
    }
    return this.liveBundle;
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

    try {
      const client = this.buildLiveClient();
      await client.ping();
      return {
        ok: true,
        message: "ClassLink OneRoster API reachable.",
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, message: msg };
    }
  }

  async listStudents(): Promise<SisStudent[]> {
    const bundle = await this.getRosterBundle();
    return mapOneRosterStudents(bundle, this.config.schoolOrgSourcedId);
  }

  async listStaff(): Promise<SisStaff[]> {
    const bundle = await this.getRosterBundle();
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
    const bundle = await this.getRosterBundle();
    return mapOneRosterRoomAssignments(bundle, this.config.schoolOrgSourcedId);
  }

  async listClassSections(): Promise<SisClassSection[]> {
    const bundle = await this.getRosterBundle();
    return mapOneRosterClassSections(bundle, this.config.schoolOrgSourcedId);
  }

  async listEnrollments(): Promise<SisEnrollment[]> {
    const bundle = await this.getRosterBundle();
    return mapOneRosterEnrollments(bundle, this.config.schoolOrgSourcedId);
  }

  async listSchoolOrgs(): Promise<SisSchoolOrg[]> {
    const bundle = await this.getRosterBundle();
    return mapOneRosterSchoolOrgs(bundle.orgs);
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
    const bundle = await this.getRosterBundle();
    return bundle.orgs;
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
