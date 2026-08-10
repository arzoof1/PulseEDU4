// Short-TTL cache in front of isMfaRequiredForStaff (Gate A / Section 1).
//
// The MFA enrollment gate (see mfaEnrollmentGate.ts) resolves policy on the
// request hot path for every authenticated, not-yet-enrolled staff member.
// isMfaRequiredForStaff costs 2-3 DB queries, so without a cache an entire
// district of un-enrolled users would pay that on every request. We memoize
// the decision per (school, tier) — the only inputs that matter — for a short
// window. Policy edits propagate within TTL_MS on their own, and every write
// to the mfa_required_* flags calls clearMfaPolicyCache() for immediate effect.
//
// This module imports the DB-backed resolver, so it is NOT unit-tested; the
// pure caching/expiry behavior lives in (and is tested via) ttlAsyncCache.ts.

import { isMfaRequiredForStaff } from "./mfaPolicy.js";
import { createTtlAsyncCache } from "./ttlAsyncCache.js";

type StaffInput = Parameters<typeof isMfaRequiredForStaff>[0];

const TTL_MS = 30_000;
const cache = createTtlAsyncCache<boolean>(TTL_MS);

function keyFor(staff: StaffInput): string {
  const privileged =
    staff.isSuperUser || staff.isDistrictAdmin || staff.isAdmin;
  return `${staff.schoolId}:${privileged ? "p" : "s"}`;
}

/** Drop all cached policy decisions. Call after any write to the
 *  mfa_required_* flags so enforcement changes take effect immediately
 *  rather than after the TTL window. */
export function clearMfaPolicyCache(): void {
  cache.clear();
}

export function isMfaRequiredForStaffCached(
  staff: StaffInput,
): Promise<boolean> {
  return cache.get(keyFor(staff), () => isMfaRequiredForStaff(staff));
}
