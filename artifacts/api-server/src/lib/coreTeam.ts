// Tier 2 / Tier 3 intervention "Core Team" gate. Mirrors the client-side
// `canManageInterventions` predicate in App.tsx — keep in sync if either
// definition changes.
//
// The Core Team is allowed to:
//   - read every staff member's tier2 / tier3 entries in the school
//   - write entries on behalf of any teacher
//   - edit / version Tier 3 goals
//   - view the Intervention Completion report
//   - manage the strategy catalog
//
// Members: SuperUser, District Admin, school Admin, Behavior Specialist,
// MTSS Coordinator, School Psychologist.
export function isCoreTeam(staff: {
  isSuperUser?: boolean | null;
  isDistrictAdmin?: boolean | null;
  isAdmin?: boolean | null;
  isBehaviorSpecialist?: boolean | null;
  isMtssCoordinator?: boolean | null;
  isSchoolPsychologist?: boolean | null;
}): boolean {
  return Boolean(
    staff.isSuperUser ||
      staff.isDistrictAdmin ||
      staff.isAdmin ||
      staff.isBehaviorSpecialist ||
      staff.isMtssCoordinator ||
      staff.isSchoolPsychologist,
  );
}

// Strict admin gate used by the admin-only case enhancement suite
// (mention insights, video evidence, AI consistency check, Case
// Insights dashboard). Excludes Behavior Specialist / MTSS / School
// Psych — those are Core Team for *intervention* purposes but should
// not see investigative video-evidence tooling.
export function isAdminOrSuperUser(staff: {
  isSuperUser?: boolean | null;
  isDistrictAdmin?: boolean | null;
  isAdmin?: boolean | null;
}): boolean {
  return Boolean(
    staff.isSuperUser || staff.isDistrictAdmin || staff.isAdmin,
  );
}

// "Case Investigator" gate — broader than admin but narrower than
// Core Team. Admits the admin tier plus the three roles that
// administration explicitly asked for on the case investigation
// workflow: Behavior Specialist, MTSS Coordinator, and Dean. They
// commonly run statement collection and footage review alongside
// admins. School Counselor and School Psychologist are intentionally
// excluded — they sit outside the discipline-investigation chain
// even though they are Core Team for intervention purposes.
export function isCaseInvestigator(staff: {
  isSuperUser?: boolean | null;
  isDistrictAdmin?: boolean | null;
  isAdmin?: boolean | null;
  isBehaviorSpecialist?: boolean | null;
  isMtssCoordinator?: boolean | null;
  isDean?: boolean | null;
}): boolean {
  return (
    isAdminOrSuperUser(staff) ||
    Boolean(
      staff.isBehaviorSpecialist ||
        staff.isMtssCoordinator ||
        staff.isDean,
    )
  );
}

// Safety Plan edit gate. Per spec: Admin, Guidance Counselor, and any
// Core Team member can create / edit / deactivate a student's safety
// plan and manage the school-wide item library.
export function canEditSafetyPlan(staff: {
  isSuperUser?: boolean | null;
  isDistrictAdmin?: boolean | null;
  isAdmin?: boolean | null;
  isBehaviorSpecialist?: boolean | null;
  isMtssCoordinator?: boolean | null;
  isSchoolPsychologist?: boolean | null;
  isGuidanceCounselor?: boolean | null;
}): boolean {
  return Boolean(staff.isGuidanceCounselor) || isCoreTeam(staff);
}

// Student photo manager gate. Per spec: admin / front-office staff /
// core team (BS, MTSS, school psych, district admin, super user) /
// counselor (school OR guidance) / social worker. We don't have a
// dedicated front-office boolean column today — front-office staff
// are typically flagged `isAdmin` in their staff record (they sit at
// the admin desk and run the kiosks). Bus drivers are intentionally
// excluded — they don't carry login devices and the camera/upload UX
// doesn't fit a driver workflow. Teachers are excluded too: photo
// management is an office-side onboarding task, not a classroom one.
export function canManageStudentPhoto(staff: {
  isSuperUser?: boolean | null;
  isDistrictAdmin?: boolean | null;
  isAdmin?: boolean | null;
  isBehaviorSpecialist?: boolean | null;
  isMtssCoordinator?: boolean | null;
  isSchoolPsychologist?: boolean | null;
  isGuidanceCounselor?: boolean | null;
  isCounselor?: boolean | null;
  isSocialWorker?: boolean | null;
}): boolean {
  return (
    canEditSafetyPlan(staff) ||
    Boolean(staff.isCounselor) ||
    Boolean(staff.isSocialWorker)
  );
}
