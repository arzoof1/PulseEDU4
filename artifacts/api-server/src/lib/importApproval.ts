// Roster-import approval / segregation-of-duties gate (Section 15.5). Pure +
// unit-tested (no DB), same split pattern as tenantScope / parentAccess.
//
// When a school enables import_requires_approval, a roster import may not be
// committed by one person alone: the commit request must name a DIFFERENT
// administrator as the approver, and the server validates that named approver
// really is an admin/SuperUser in the same school. This prevents a single
// account from unilaterally overwriting a school's roster, and every approved
// commit is audited. (Dormant by default — when the setting is off, imports
// behave exactly as before.)

export type ImportApprovalInput = {
  // school_settings.import_requires_approval for the committing school.
  requiresApproval: boolean;
  // The admin named as approver in the commit request (or null if none given).
  approverStaffId: number | null;
  // Whether that named approver resolved to an active admin/SuperUser in the
  // same school (validated against the DB by the caller).
  approverIsAdmin: boolean;
  // The staff performing the import.
  uploaderStaffId: number;
};

export type ImportApprovalDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

export function evaluateImportApproval(
  i: ImportApprovalInput,
): ImportApprovalDecision {
  if (!i.requiresApproval) return { allowed: true };
  if (i.approverStaffId == null) {
    return { allowed: false, reason: "approval_required" };
  }
  if (i.approverStaffId === i.uploaderStaffId) {
    return { allowed: false, reason: "self_approval_forbidden" };
  }
  if (!i.approverIsAdmin) {
    return { allowed: false, reason: "approver_not_admin" };
  }
  return { allowed: true };
}
