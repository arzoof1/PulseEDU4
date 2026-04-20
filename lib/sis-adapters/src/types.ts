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
