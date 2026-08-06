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
import {
  OneRosterLiveClient,
  resolveOneRosterBaseUrl,
} from "./oneroster/liveClient.js";

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
  // Live OneRoster bundle, fetched once per adapter instance and shared across
  // all list* calls in a single sync (listStudents/listStaff/... would
  // otherwise each re-pull the whole district).
  private liveBundle: OneRosterFixtureBundle | null = null;
  private liveClientInstance: OneRosterLiveClient | null = null;

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

  // Build (once) the OAuth 1.0a-signing live client from config + env creds.
  // Throws AdapterNotImplementedError with a precise reason when the base URL
  // or credentials are absent, so misconfiguration surfaces clearly.
  private liveClient(): OneRosterLiveClient {
    if (this.liveClientInstance) return this.liveClientInstance;
    const baseUrl = resolveOneRosterBaseUrl(this.config.rostersBaseUrl);
    if (!baseUrl) {
      throw new AdapterNotImplementedError(
        `${this.id} live OneRoster: missing base URL (set sis_config.rostersBaseUrl or CLASSLINK_ONEROSTER_BASE_URL).`,
      );
    }
    const idVar = this.config.rostersClientIdEnvVar;
    const secretVar = this.config.rostersClientSecretEnvVar;
    const consumerKey = idVar ? process.env[idVar]?.trim() : undefined;
    const consumerSecret = secretVar
      ? process.env[secretVar]?.trim()
      : undefined;
    if (!consumerKey || !consumerSecret) {
      throw new AdapterNotImplementedError(
        `${this.id} live OneRoster: missing credentials (env ${idVar ?? "CLASSLINK_ONEROSTER_CLIENT_ID"} / ${secretVar ?? "CLASSLINK_ONEROSTER_CLIENT_SECRET"}).`,
      );
    }
    this.liveClientInstance = new OneRosterLiveClient({
      baseUrl,
      consumerKey,
      consumerSecret,
    });
    return this.liveClientInstance;
  }

  // Unified bundle source: fixtures in mock mode, otherwise the live district
  // pull (cached). The full district is fetched unfiltered and each list* call
  // narrows to this.config.schoolOrgSourcedId via the shared mappers — the same
  // path the fixtures use — so per-school scoping never depends on server-side
  // OneRoster filter support.
  private async loadBundle(): Promise<OneRosterFixtureBundle> {
    if (this.usingFixtures()) return this.getFixtures();
    if (!this.liveBundle) {
      this.liveBundle = await this.liveClient().fetchBundle();
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
    if (!resolveOneRosterBaseUrl(this.config.rostersBaseUrl)) {
      return { ok: false, message: "Missing ClassLink OneRoster base URL." };
    }

    // Live reachability + auth check: sign and fetch a single org row.
    try {
      await this.liveClient().ping();
      return {
        ok: true,
        message: "ClassLink OneRoster live API reachable (OAuth 1.0a).",
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        message: `ClassLink OneRoster live API unreachable: ${msg}`,
      };
    }
  }

  async listStudents(): Promise<SisStudent[]> {
    return mapOneRosterStudents(
      await this.loadBundle(),
      this.config.schoolOrgSourcedId,
    );
  }

  async listStaff(): Promise<SisStaff[]> {
    const bundle = await this.loadBundle();
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
    return mapOneRosterRoomAssignments(
      await this.loadBundle(),
      this.config.schoolOrgSourcedId,
    );
  }

  async listClassSections(): Promise<SisClassSection[]> {
    return mapOneRosterClassSections(
      await this.loadBundle(),
      this.config.schoolOrgSourcedId,
    );
  }

  async listEnrollments(): Promise<SisEnrollment[]> {
    return mapOneRosterEnrollments(
      await this.loadBundle(),
      this.config.schoolOrgSourcedId,
    );
  }

  async listSchoolOrgs(): Promise<SisSchoolOrg[]> {
    return mapOneRosterSchoolOrgs((await this.loadBundle()).orgs);
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
    return (await this.loadBundle()).orgs;
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
