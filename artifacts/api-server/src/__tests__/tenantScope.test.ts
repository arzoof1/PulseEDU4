import { describe, it, expect } from "vitest";
import {
  resolveActiveSchoolId,
  type TenantResolutionInput,
} from "../lib/tenantScope.js";

// Automated tenant-isolation tests (Section 5.2). These lock the multi-tenant
// boundary decision the request middleware runs: which school a request acts
// under, and specifically that a non-SuperUser can never escape their home
// school.

// Sensible defaults: an active home school, no override, gate off.
function input(over: Partial<TenantResolutionInput> = {}): TenantResolutionInput {
  return {
    isSuperUser: false,
    homeSchoolId: 1,
    homeSchoolActive: true,
    homeDistrictActive: true,
    override: null,
    overrideExists: false,
    overrideSchoolActive: false,
    overrideDistrictActive: false,
    overrideSameDistrict: false,
    allowCrossDistrict: false,
    ...over,
  };
}

describe("resolveActiveSchoolId — non-SuperUser isolation (core invariant)", () => {
  it("resolves to the home school", () => {
    expect(resolveActiveSchoolId(input())).toEqual({
      schoolId: 1,
      isSchoolSwitched: false,
    });
  });

  it("IGNORES an override even if one is set, active, and same-district", () => {
    // A stale/forged override must not move a non-SuperUser to another tenant.
    const r = resolveActiveSchoolId(
      input({
        override: 2,
        overrideExists: true,
        overrideSchoolActive: true,
        overrideDistrictActive: true,
        overrideSameDistrict: true,
      }),
    );
    expect(r).toEqual({ schoolId: 1, isSchoolSwitched: false });
  });

  it("resolves to no school when the home school is inactive", () => {
    expect(resolveActiveSchoolId(input({ homeSchoolActive: false }))).toEqual({
      schoolId: null,
      isSchoolSwitched: false,
    });
  });

  it("resolves to no school when the home district is inactive", () => {
    expect(resolveActiveSchoolId(input({ homeDistrictActive: false }))).toEqual({
      schoolId: null,
      isSchoolSwitched: false,
    });
  });
});

describe("resolveActiveSchoolId — SuperUser school switch", () => {
  const su = (over: Partial<TenantResolutionInput> = {}) =>
    input({ isSuperUser: true, ...over });

  it("honors a valid, active, same-district override", () => {
    const r = resolveActiveSchoolId(
      su({
        override: 2,
        overrideExists: true,
        overrideSchoolActive: true,
        overrideDistrictActive: true,
        overrideSameDistrict: true,
      }),
    );
    expect(r).toEqual({ schoolId: 2, isSchoolSwitched: true });
  });

  it("falls back to home when the override target is inactive", () => {
    const r = resolveActiveSchoolId(
      su({
        override: 2,
        overrideExists: true,
        overrideSchoolActive: false,
        overrideDistrictActive: true,
        overrideSameDistrict: true,
      }),
    );
    expect(r).toEqual({ schoolId: 1, isSchoolSwitched: false });
  });

  it("falls back to home when the override row no longer exists (stale)", () => {
    const r = resolveActiveSchoolId(
      su({ override: 999, overrideExists: false }),
    );
    expect(r).toEqual({ schoolId: 1, isSchoolSwitched: false });
  });

  it("REFUSES a cross-district override when the gate is off", () => {
    const r = resolveActiveSchoolId(
      su({
        override: 2,
        overrideExists: true,
        overrideSchoolActive: true,
        overrideDistrictActive: true,
        overrideSameDistrict: false,
        allowCrossDistrict: false,
      }),
    );
    expect(r).toEqual({ schoolId: 1, isSchoolSwitched: false });
  });

  it("allows a cross-district override only when the gate is on", () => {
    const r = resolveActiveSchoolId(
      su({
        override: 2,
        overrideExists: true,
        overrideSchoolActive: true,
        overrideDistrictActive: true,
        overrideSameDistrict: false,
        allowCrossDistrict: true,
      }),
    );
    expect(r).toEqual({ schoolId: 2, isSchoolSwitched: true });
  });

  it("treats an override equal to the home school as no switch", () => {
    const r = resolveActiveSchoolId(
      su({ override: 1, overrideExists: true, overrideSchoolActive: true }),
    );
    expect(r).toEqual({ schoolId: 1, isSchoolSwitched: false });
  });

  it("still resolves to no school when the home school is inactive, even for a SuperUser with a valid override", () => {
    const r = resolveActiveSchoolId(
      su({
        homeSchoolActive: false,
        override: 2,
        overrideExists: true,
        overrideSchoolActive: true,
        overrideDistrictActive: true,
        overrideSameDistrict: true,
      }),
    );
    expect(r).toEqual({ schoolId: null, isSchoolSwitched: false });
  });
});
