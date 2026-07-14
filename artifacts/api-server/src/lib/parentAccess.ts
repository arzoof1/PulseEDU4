// Pure parent access-control decisions (Section 13.2 custody enforcement /
// 13.3 no-contact / 13.4 revocation), split DB-free so the rules are
// unit-testable without a database (same pattern as tenantScope / authAuditChain).

// A parent may access a student's data ONLY through an existing parent_students
// link AND while their account is active. This is the invariant the per-route
// parent authorization checks rely on: removing the link (13.2 custody
// restriction) or deactivating the account (13.4 revocation) denies access
// everywhere, because every parent-facing read re-checks the link + active flag.
export function canParentAccessStudent(input: {
  linkExists: boolean;
  parentActive: boolean;
}): boolean {
  return input.linkExists && input.parentActive;
}

// A parent may send or receive messages ONLY while active and not flagged
// no-contact (13.3). no_contact defaults false, so existing parents are
// unaffected until an admin explicitly flags a court-order / no-contact party.
export function canParentBeMessaged(input: {
  active: boolean;
  noContact: boolean;
}): boolean {
  return input.active && !input.noContact;
}
