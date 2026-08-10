import { describe, it, expect } from "vitest";
import { evaluateImportApproval } from "../lib/importApproval.js";

// Roster-import approval / segregation-of-duties (Section 15.5).

describe("evaluateImportApproval", () => {
  it("allows the commit when approval is not required (dormant default)", () => {
    expect(
      evaluateImportApproval({
        requiresApproval: false,
        approverStaffId: null,
        approverIsAdmin: false,
        uploaderStaffId: 10,
      }),
    ).toEqual({ allowed: true });
  });

  it("blocks when approval is required but none is named", () => {
    expect(
      evaluateImportApproval({
        requiresApproval: true,
        approverStaffId: null,
        approverIsAdmin: false,
        uploaderStaffId: 10,
      }),
    ).toEqual({ allowed: false, reason: "approval_required" });
  });

  it("forbids self-approval (uploader == approver)", () => {
    expect(
      evaluateImportApproval({
        requiresApproval: true,
        approverStaffId: 10,
        approverIsAdmin: true,
        uploaderStaffId: 10,
      }),
    ).toEqual({ allowed: false, reason: "self_approval_forbidden" });
  });

  it("rejects a named approver who is not an admin", () => {
    expect(
      evaluateImportApproval({
        requiresApproval: true,
        approverStaffId: 20,
        approverIsAdmin: false,
        uploaderStaffId: 10,
      }),
    ).toEqual({ allowed: false, reason: "approver_not_admin" });
  });

  it("allows the commit with a valid, different, admin approver", () => {
    expect(
      evaluateImportApproval({
        requiresApproval: true,
        approverStaffId: 20,
        approverIsAdmin: true,
        uploaderStaffId: 10,
      }),
    ).toEqual({ allowed: true });
  });
});
