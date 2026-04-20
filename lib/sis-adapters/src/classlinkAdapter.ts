import type {
  RosterAdapter,
  SisStaff,
  SisStudent,
  SisRoomAssignment,
  SsoAdapter,
} from "./types.js";
import { AdapterNotImplementedError } from "./types.js";

// ClassLink can be used two ways: as a OneRoster-compatible rostering
// source, and as an OIDC SSO identity provider. Many districts use both
// (rostering from Skyward, SSO from ClassLink), so the two adapter
// interfaces stay separate.

export interface ClasslinkConfig {
  /** OneRoster base URL, e.g. "https://example.classlink.com/oneroster/v1p1" */
  rostersBaseUrl?: string;
  rostersClientIdEnvVar?: string;
  rostersClientSecretEnvVar?: string;

  /** OIDC issuer base URL, e.g. "https://launchpad.classlink.com" */
  oidcIssuer?: string;
  oidcClientIdEnvVar?: string;
  oidcClientSecretEnvVar?: string;
  oidcRedirectUri?: string;
}

export class ClasslinkRosterAdapter implements RosterAdapter {
  readonly id = "classlink";
  readonly displayName = "ClassLink (OneRoster)";

  constructor(private readonly config: ClasslinkConfig) {}

  async ping(): Promise<{ ok: boolean; message: string }> {
    const idVar = this.config.rostersClientIdEnvVar;
    if (!idVar || !process.env[idVar]) {
      return { ok: false, message: "Missing ClassLink rostering client id." };
    }
    return {
      ok: true,
      message: "ClassLink rostering adapter present (no live call yet).",
    };
  }

  listStaff(): Promise<SisStaff[]> {
    throw new AdapterNotImplementedError(this.id);
  }
  listStudents(): Promise<SisStudent[]> {
    throw new AdapterNotImplementedError(this.id);
  }
  listRoomAssignments(): Promise<SisRoomAssignment[]> {
    throw new AdapterNotImplementedError(this.id);
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
