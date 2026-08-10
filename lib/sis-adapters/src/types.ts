// Vendor-neutral shapes used by every roster adapter.
//
// Each adapter implementation (Skyward, ClassLink, PowerSchool, ...) maps
// its native API into these structures so the rest of the app never sees
// vendor-specific fields. When you add a new vendor, add a new adapter
// file beside `skywardAdapter.ts` / `classlinkAdapter.ts` and register it
// in `index.ts` — no other code needs to change.

export interface SisStaff {
  /** Stable identifier from the SIS. Stored on `staff.external_id`. */
  externalId: string;
  email: string;
  displayName: string;
  /** Primary classroom / homeroom, if the SIS exposes one. */
  primaryRoom: string | null;
}

export interface SisStudent {
  externalId: string;
  studentId: string;
  firstName: string;
  lastName: string;
  gradeLevel: string | null;
  /** `undefined` = not provided by feed (preserve existing DB value on update). */
  gender?: string | null;
  ell?: boolean;
  ese?: boolean;
  is504?: boolean;
  race?: string | null;
  ethnicity?: string | null;
}

export interface SisSchoolOrg {
  sourcedId: string;
  identifier: string | null;
  name: string;
  type: string;
}

export interface SisClassSection {
  /** OneRoster class `sourcedId` — used to wire enrollments. */
  externalId: string;
  teacherExternalId: string;
  period: number;
  courseName: string;
  isPlanning?: boolean;
}

export interface SisEnrollment {
  classExternalId: string;
  studentId: string;
}

export interface SisRoomAssignment {
  staffExternalId: string;
  room: string;
}

export interface RosterAdapter {
  /** Friendly identifier — also the value stored in `district_integrations.sis_provider`. */
  readonly id: string;
  readonly displayName: string;

  /** Quick reachability / credentials check. */
  ping(): Promise<{ ok: boolean; message: string }>;

  listStaff(): Promise<SisStaff[]>;
  listStudents(): Promise<SisStudent[]>;
  listRoomAssignments(): Promise<SisRoomAssignment[]>;
  listClassSections(): Promise<SisClassSection[]>;
  listEnrollments(): Promise<SisEnrollment[]>;
  listSchoolOrgs(): Promise<SisSchoolOrg[]>;
  /** Full OneRoster org feed (district + schools) for school mapping validation. */
  listOrgs(): Promise<
    Array<{
      sourcedId: string;
      status?: string;
      name: string;
      type: string;
      identifier?: string;
    }>
  >;
}

export interface SsoAdapter {
  readonly id: string;
  readonly displayName: string;
  /** Returns the URL to redirect the user to in order to start sign-in. */
  buildAuthorizeUrl(state: string): string;
  /** Exchange whatever the IdP returned for a verified user identity. */
  verifyCallback(query: Record<string, string>): Promise<{
    externalId: string;
    email: string;
    displayName: string;
  }>;
}

/**
 * Thrown when an adapter is selected in district_integrations but no concrete
 * implementation is available yet. Callers catch this and fall back to the
 * built-in local roster / password login.
 */
export class AdapterNotImplementedError extends Error {
  constructor(provider: string) {
    super(`Adapter "${provider}" is not implemented yet.`);
    this.name = "AdapterNotImplementedError";
  }
}
