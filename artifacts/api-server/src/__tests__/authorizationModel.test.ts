// DV-02 — "verified compatibility" characterization tests.
//
// PulseEDU runs a hybrid authorization model: legacy per-role boolean flags
// (isAdmin, isBehaviorSpecialist, ...) alongside a newer capability layer
// (capImportGrades, ...). These tests do NOT change behavior — they LOCK the
// current composed-gate semantics so the legacy/capability layers can be
// migrated later without silent drift. Each case documents an intended rule
// from the gate's own spec comment.

import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  canEditSafetyPlan,
  isAdminOrSuperUser,
  isCaseInvestigator,
  isCoreTeam,
} from "../lib/coreTeam";

describe("isCoreTeam — the 8 sources that grant Core Team (DV-02)", () => {
  const sources = [
    "isSuperUser",
    "isDistrictAdmin",
    "isAdmin",
    "isBehaviorSpecialist",
    "isMtssCoordinator",
    "isSchoolPsychologist",
    "isCoreTeam",
    "isConfidentialSecretary",
  ] as const;

  it("denies an empty / plain-teacher staff", () => {
    expect(isCoreTeam({})).toBe(false);
    expect(isCoreTeam({ isCounselor: true } as never)).toBe(false);
  });

  it.each(sources)("grants when only %s is set", (flag) => {
    expect(isCoreTeam({ [flag]: true })).toBe(true);
  });

  it("does NOT grant on counselor/guidance flags alone", () => {
    expect(isCoreTeam({ isGuidanceCounselor: true } as never)).toBe(false);
  });
});

describe("isAdminOrSuperUser — admin tier only (DV-02)", () => {
  // NOTE: despite its name, the ACTUAL code admits District Admin too. Locked
  // here so a refactor cannot quietly change the tier.
  it("admits SuperUser, District Admin and school Admin", () => {
    expect(isAdminOrSuperUser({ isSuperUser: true })).toBe(true);
    expect(isAdminOrSuperUser({ isDistrictAdmin: true })).toBe(true);
    expect(isAdminOrSuperUser({ isAdmin: true })).toBe(true);
  });

  it("excludes intervention-only roles (BS / MTSS / school psych)", () => {
    expect(isAdminOrSuperUser({ isBehaviorSpecialist: true } as never)).toBe(
      false,
    );
    expect(isAdminOrSuperUser({ isMtssCoordinator: true } as never)).toBe(false);
    expect(isAdminOrSuperUser({ isSchoolPsychologist: true } as never)).toBe(
      false,
    );
  });
});

describe("isCaseInvestigator — admin tier + BS/MTSS/Dean (DV-02)", () => {
  it("admits the admin tier", () => {
    expect(isCaseInvestigator({ isAdmin: true })).toBe(true);
  });
  it("admits Behavior Specialist, MTSS Coordinator and Dean", () => {
    expect(isCaseInvestigator({ isBehaviorSpecialist: true })).toBe(true);
    expect(isCaseInvestigator({ isMtssCoordinator: true })).toBe(true);
    expect(isCaseInvestigator({ isDean: true })).toBe(true);
  });
  it("excludes School Psychologist and Counselor (outside the discipline chain)", () => {
    expect(isCaseInvestigator({ isSchoolPsychologist: true } as never)).toBe(
      false,
    );
    expect(isCaseInvestigator({ isCounselor: true } as never)).toBe(false);
    expect(isCaseInvestigator({})).toBe(false);
  });
});

describe("canEditSafetyPlan — Guidance Counselor OR Core Team (DV-02)", () => {
  it("admits a plain Guidance Counselor (not otherwise Core Team)", () => {
    expect(canEditSafetyPlan({ isGuidanceCounselor: true })).toBe(true);
  });
  it("admits Core Team members", () => {
    expect(canEditSafetyPlan({ isBehaviorSpecialist: true })).toBe(true);
  });
  it("denies a generic (non-guidance) counselor and empty staff", () => {
    expect(canEditSafetyPlan({} as never)).toBe(false);
  });
});

// scope.ts imports @workspace/db, which throws at import when DATABASE_URL is
// unset. Stub a dummy URL (the pool is lazy — nothing connects) and load the
// module dynamically so these pure predicates can be characterized DB-free.
describe("scope.ts district/import tier gates (DV-02)", () => {
  let scope: typeof import("../lib/scope");
  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://stub@localhost:5432/stub");
    scope = await import("../lib/scope");
  });

  it("canActAsDistrict: SuperUser + District Admin only (NOT school Admin)", () => {
    expect(scope.canActAsDistrict({ isSuperUser: true })).toBe(true);
    expect(scope.canActAsDistrict({ isDistrictAdmin: true })).toBe(true);
    expect(scope.canActAsDistrict({ isAdmin: true } as never)).toBe(false);
    expect(scope.canActAsDistrict({})).toBe(false);
  });

  it("canImportSchoolData: admits the full admin tier (SU/DA/Admin)", () => {
    expect(scope.canImportSchoolData({ isAdmin: true })).toBe(true);
    expect(scope.canImportSchoolData({ isDistrictAdmin: true })).toBe(true);
    expect(scope.canImportSchoolData({ isSuperUser: true })).toBe(true);
    expect(scope.canImportSchoolData({})).toBe(false);
  });

  it("canImportDistrictData: excludes school Admin (no authority over siblings)", () => {
    expect(scope.canImportDistrictData({ isAdmin: true } as never)).toBe(false);
    expect(scope.canImportDistrictData({ isDistrictAdmin: true })).toBe(true);
  });

  it("canImportKind: admins bypass; a delegated clerk is scoped to its cap", () => {
    // Admin bypasses for any kind.
    expect(scope.canImportKind({ isAdmin: true }, "gradebook")).toBe(true);
    // Grades clerk: yes for gradebook, no for an iReady kind.
    const gradesClerk = { capImportGrades: true };
    expect(scope.canImportKind(gradesClerk, "gradebook")).toBe(true);
    expect(scope.canImportKind(gradesClerk, "assessments")).toBe(false);
    // Non-delegable kind (rosters) stays admin-only.
    expect(scope.canImportKind(gradesClerk, "rosters")).toBe(false);
  });
});
