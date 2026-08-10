// Pure tenant-resolution decision (Section 5.2), extracted from the request
// middleware in app.ts so the multi-tenant isolation rule is unit-testable
// without a database (same DB-free split as geoAnomalyMath / authAuditChain).
//
// This is the single most security-critical decision in the app: it determines
// which school (tenant) a request operates under. The invariant it must uphold:
//
//   A non-SuperUser ALWAYS operates under their own home school. A client-
//   supplied or stale override can NEVER move a non-SuperUser (or move anyone
//   into an inactive or, unless explicitly allowed, cross-district tenant).
//
// The middleware gathers the facts (home-school active state, the persisted
// SuperUser override and its target's active/district state) and calls this
// function to decide. Keeping the decision pure means the test suite exercises
// the exact logic the middleware runs.

export type TenantResolutionInput = {
  isSuperUser: boolean;
  homeSchoolId: number | null;
  // Home school row exists and is active, and its district is active.
  homeSchoolActive: boolean;
  homeDistrictActive: boolean;
  // Persisted SuperUser school override (staff.activeSchoolOverride), or null.
  override: number | null;
  // Facts about the override target — only meaningful when an override that
  // differs from the home school is being considered.
  overrideExists: boolean;
  overrideSchoolActive: boolean;
  overrideDistrictActive: boolean;
  overrideSameDistrict: boolean;
  // ALLOW_CROSS_DISTRICT_SUPERUSER opt-in: honor a cross-district override.
  allowCrossDistrict: boolean;
};

export type TenantResolution = {
  schoolId: number | null;
  isSchoolSwitched: boolean;
};

export function resolveActiveSchoolId(
  i: TenantResolutionInput,
): TenantResolution {
  // 1. The home school (and its district) must be active before ANY school
  //    context is granted. A retired/soft-deleted tenant resolves to no school;
  //    downstream route guards 4xx on a missing school.
  if (!i.homeSchoolActive || !i.homeDistrictActive) {
    return { schoolId: null, isSchoolSwitched: false };
  }

  // 2. Only a SuperUser may switch schools, and only via a persisted override
  //    that actually differs from their home school. For everyone else the
  //    override is ignored entirely — this is the core isolation guarantee.
  if (i.isSuperUser && i.override != null && i.override !== i.homeSchoolId) {
    const overrideHonored =
      i.overrideExists &&
      i.overrideSchoolActive &&
      i.overrideDistrictActive &&
      (i.overrideSameDistrict || i.allowCrossDistrict);
    if (overrideHonored) {
      return { schoolId: i.override, isSchoolSwitched: true };
    }
    // Stale, inactive, or (with the gate off) cross-district override — fall
    // back to the home school rather than leaking the override's tenant.
    return { schoolId: i.homeSchoolId, isSchoolSwitched: false };
  }

  // 3. Default: the caller's own home school.
  return { schoolId: i.homeSchoolId, isSchoolSwitched: false };
}
