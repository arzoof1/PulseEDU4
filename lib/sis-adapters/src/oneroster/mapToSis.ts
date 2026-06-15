import type {
  SisClassSection,
  SisEnrollment,
  SisRoomAssignment,
  SisSchoolOrg,
  SisStaff,
  SisStudent,
} from "../types.js";
import { mapStudentDemographics } from "./demographicsMap.js";
import { buildSchoolOrgIndex } from "./schoolMapping.js";
import type {
  OneRosterClass,
  OneRosterEnrollment,
  OneRosterFixtureBundle,
  OneRosterOrg,
  OneRosterUser,
} from "./types.js";

const STAFF_ROLES = new Set([
  "teacher",
  "administrator",
  "aide",
  "proctor",
]);

function isActive(status: string | undefined): boolean {
  return (status ?? "active").toLowerCase() === "active";
}

function districtStudentId(user: OneRosterUser): string {
  const fed = user.userIds?.find((u) => u.type.toLowerCase() === "fed");
  if (fed?.identifier?.trim()) return fed.identifier.trim();
  if (user.identifier?.trim()) return user.identifier.trim();
  return user.sourcedId;
}

function gradeLevel(user: OneRosterUser): string | null {
  const g = user.grades?.[0];
  if (!g?.trim()) return null;
  const n = parseInt(g, 10);
  if (!Number.isNaN(n)) return String(n);
  return g.trim();
}

function belongsToSchool(user: OneRosterUser, schoolOrgSourcedId: string): boolean {
  return (
    user.orgs?.some((o) => o.sourcedId === schoolOrgSourcedId) ?? false
  );
}

function classById(
  classes: OneRosterClass[],
): Map<string, OneRosterClass> {
  return new Map(classes.map((c) => [c.sourcedId, c]));
}

function isTruthyPrimary(value: string | boolean | undefined): boolean {
  if (value === true) return true;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return false;
}

function demographicsByUserId(
  bundle: OneRosterFixtureBundle,
): Map<string, import("./types.js").OneRosterDemographics> {
  return new Map(
    bundle.demographics
      .filter((d) => isActive(d.status))
      .map((d) => [d.sourcedId, d]),
  );
}

function usersBySourcedId(
  users: OneRosterUser[],
): Map<string, OneRosterUser> {
  return new Map(users.map((u) => [u.sourcedId, u]));
}

function parsePeriod(raw: string | undefined): number | null {
  if (!raw?.trim()) return null;
  const n = parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function mapOneRosterSchoolOrgs(orgs: OneRosterOrg[]): SisSchoolOrg[] {
  const index = buildSchoolOrgIndex(orgs);
  return index.schools.map((org) => ({
    sourcedId: org.sourcedId,
    identifier: org.identifier?.trim() ?? null,
    name: org.name,
    type: org.type,
  }));
}

export function mapOneRosterStudents(
  bundle: OneRosterFixtureBundle,
  schoolOrgSourcedId?: string,
): SisStudent[] {
  const demoMap = demographicsByUserId(bundle);
  return bundle.users
    .filter(
      (u) =>
        u.role === "student" &&
        isActive(u.status) &&
        (!schoolOrgSourcedId || belongsToSchool(u, schoolOrgSourcedId)),
    )
    .map((u) => ({
      externalId: u.sourcedId,
      studentId: districtStudentId(u),
      firstName: u.givenName.trim(),
      lastName: u.familyName.trim(),
      gradeLevel: gradeLevel(u),
      ...mapStudentDemographics(u, demoMap.get(u.sourcedId)),
    }));
}

export function mapOneRosterStaff(
  bundle: OneRosterFixtureBundle,
  schoolOrgSourcedId?: string,
): SisStaff[] {
  return bundle.users
    .filter(
      (u) =>
        STAFF_ROLES.has(u.role) &&
        isActive(u.status) &&
        (!schoolOrgSourcedId || belongsToSchool(u, schoolOrgSourcedId)),
    )
    .map((u) => ({
      externalId: u.sourcedId,
      email: (u.email ?? "").trim(),
      displayName: `${u.givenName.trim()} ${u.familyName.trim()}`.trim(),
      primaryRoom: null,
    }));
}

/** Teacher primary-class location → staff default room (first primary enrollment). */
export function mapOneRosterRoomAssignments(
  bundle: OneRosterFixtureBundle,
  schoolOrgSourcedId?: string,
): SisRoomAssignment[] {
  const classes = classById(bundle.classes);
  const teacherEnrollments = bundle.enrollments.filter(
    (e) =>
      e.role === "teacher" &&
      isActive(e.status) &&
      (!schoolOrgSourcedId || e.school.sourcedId === schoolOrgSourcedId),
  );

  const roomByStaff = new Map<string, string>();

  for (const enr of teacherEnrollments) {
    if (!isTruthyPrimary(enr.primary)) continue;
    const staffId = enr.user.sourcedId;
    if (roomByStaff.has(staffId)) continue;
    const cls = classes.get(enr.class.sourcedId);
    const room = cls?.location?.trim();
    if (room) roomByStaff.set(staffId, room);
  }

  for (const enr of teacherEnrollments) {
    const staffId = enr.user.sourcedId;
    if (roomByStaff.has(staffId)) continue;
    const cls = classes.get(enr.class.sourcedId);
    const room = cls?.location?.trim();
    if (room) roomByStaff.set(staffId, room);
  }

  return [...roomByStaff.entries()].map(([staffExternalId, room]) => ({
    staffExternalId,
    room,
  }));
}

function primaryTeacherForClass(
  classSourcedId: string,
  enrollments: OneRosterEnrollment[],
): string | null {
  const forClass = enrollments.filter(
    (e) =>
      e.role === "teacher" &&
      isActive(e.status) &&
      e.class.sourcedId === classSourcedId,
  );
  const primary = forClass.find((e) => isTruthyPrimary(e.primary));
  const pick = primary ?? forClass[0];
  return pick?.user.sourcedId ?? null;
}

export function mapOneRosterClassSections(
  bundle: OneRosterFixtureBundle,
  schoolOrgSourcedId?: string,
): SisClassSection[] {
  const out: SisClassSection[] = [];
  for (const cls of bundle.classes) {
    if (!isActive(cls.status)) continue;
    if (schoolOrgSourcedId && cls.school?.sourcedId !== schoolOrgSourcedId) {
      continue;
    }
    const teacherExternalId = primaryTeacherForClass(
      cls.sourcedId,
      bundle.enrollments,
    );
    if (!teacherExternalId) continue;
    const period =
      parsePeriod(cls.periods?.[0]) ??
      (cls.classType === "homeroom" ? 0 : null);
    if (period == null) continue;
    out.push({
      externalId: cls.sourcedId,
      teacherExternalId,
      period,
      courseName: cls.title.trim() || cls.classCode?.trim() || "Class",
      isPlanning: false,
    });
  }
  return out;
}

export function mapOneRosterEnrollments(
  bundle: OneRosterFixtureBundle,
  schoolOrgSourcedId?: string,
): SisEnrollment[] {
  const users = usersBySourcedId(bundle.users);
  const out: SisEnrollment[] = [];
  for (const enr of bundle.enrollments) {
    if (enr.role !== "student" || !isActive(enr.status)) continue;
    if (schoolOrgSourcedId && enr.school.sourcedId !== schoolOrgSourcedId) {
      continue;
    }
    const user = users.get(enr.user.sourcedId);
    if (!user || user.role !== "student") continue;
    out.push({
      classExternalId: enr.class.sourcedId,
      studentId: districtStudentId(user),
    });
  }
  return out;
}
