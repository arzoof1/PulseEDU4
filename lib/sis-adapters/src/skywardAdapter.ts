import type {
  RosterAdapter,
  SisClassSection,
  SisEnrollment,
  SisSchoolOrg,
  SisStaff,
  SisStudent,
  SisRoomAssignment,
} from "./types.js";
import { AdapterNotImplementedError } from "./types.js";

// Skyward roster adapter. Implementation will hit Skyward's REST API
// (commonly via the school's "API Access" account) using credentials read
// from `district_integrations.sis_config`. Expected config shape:
//
//   { baseUrl: "...", apiKeyEnvVar: "SKYWARD_API_KEY", districtCode: "..." }
//
// We never read the secret from the row itself — the adapter pulls it from
// `process.env[apiKeyEnvVar]` at call time so secrets stay in env storage.

export interface SkywardConfig {
  baseUrl: string;
  apiKeyEnvVar: string;
  districtCode?: string;
}

export class SkywardAdapter implements RosterAdapter {
  readonly id = "skyward";
  readonly displayName = "Skyward";

  constructor(private readonly config: SkywardConfig) {}

  async ping(): Promise<{ ok: boolean; message: string }> {
    const key = process.env[this.config.apiKeyEnvVar];
    if (!key) {
      return {
        ok: false,
        message: `Missing env var ${this.config.apiKeyEnvVar}`,
      };
    }
    return { ok: true, message: "Skyward adapter present (no live call yet)." };
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
  listClassSections(): Promise<SisClassSection[]> {
    throw new AdapterNotImplementedError(this.id);
  }
  listEnrollments(): Promise<SisEnrollment[]> {
    throw new AdapterNotImplementedError(this.id);
  }
  listSchoolOrgs(): Promise<SisSchoolOrg[]> {
    throw new AdapterNotImplementedError(this.id);
  }
  listOrgs(): Promise<
    Array<{
      sourcedId: string;
      status?: string;
      name: string;
      type: string;
      identifier?: string;
    }>
  > {
    throw new AdapterNotImplementedError(this.id);
  }
}
