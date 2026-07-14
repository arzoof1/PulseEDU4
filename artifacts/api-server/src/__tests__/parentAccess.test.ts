import { describe, it, expect } from "vitest";
import {
  canParentAccessStudent,
  canParentBeMessaged,
} from "../lib/parentAccess.js";

// Parent custody / no-contact / revocation enforcement (Section 13.2/13.3/13.4).

describe("canParentAccessStudent (13.2 custody / 13.4 revocation)", () => {
  it("allows access with an active account and an existing link", () => {
    expect(
      canParentAccessStudent({ linkExists: true, parentActive: true }),
    ).toBe(true);
  });

  it("DENIES access once the parent_students link is removed (custody restriction)", () => {
    expect(
      canParentAccessStudent({ linkExists: false, parentActive: true }),
    ).toBe(false);
  });

  it("DENIES access once the parent account is deactivated (revocation)", () => {
    expect(
      canParentAccessStudent({ linkExists: true, parentActive: false }),
    ).toBe(false);
  });
});

describe("canParentBeMessaged (13.3 no-contact)", () => {
  it("allows messaging an active, non-flagged parent (default behavior)", () => {
    expect(canParentBeMessaged({ active: true, noContact: false })).toBe(true);
  });

  it("BLOCKS a parent flagged no-contact", () => {
    expect(canParentBeMessaged({ active: true, noContact: true })).toBe(false);
  });

  it("BLOCKS an inactive parent regardless of the no-contact flag", () => {
    expect(canParentBeMessaged({ active: false, noContact: false })).toBe(
      false,
    );
  });
});
