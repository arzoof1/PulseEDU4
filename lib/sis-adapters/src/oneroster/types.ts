// OneRoster v1.1 JSON shapes (subset used by PulseEDU roster sync).
// See lib/sis-adapters/fixtures/oneroster-v1p1/ for sample payloads.

export interface OneRosterLink {
  href: string;
  sourcedId: string;
  type: string;
}

export interface OneRosterOrg {
  sourcedId: string;
  status: "active" | "tobedeleted" | string;
  dateLastModified?: string;
  name: string;
  type: "district" | "school" | "local" | "state" | "national" | string;
  identifier?: string;
  parent?: OneRosterLink;
}

export interface OneRosterUserId {
  type: string;
  identifier: string;
}

export interface OneRosterUser {
  sourcedId: string;
  status: "active" | "tobedeleted" | string;
  dateLastModified?: string;
  username?: string;
  userIds?: OneRosterUserId[];
  enabledUser?: string | boolean;
  givenName: string;
  familyName: string;
  middleName?: string;
  /** ClassLink / vendor extensions (ELL, ESE, 504 flags may appear here). */
  metadata?: Record<string, unknown>;
  role:
    | "student"
    | "teacher"
    | "administrator"
    | "parent"
    | "guardian"
    | "aide"
    | "proctor"
    | string;
  identifier?: string;
  email?: string;
  phone?: string;
  sms?: string;
  grades?: string[];
  orgs?: OneRosterLink[];
}

export interface OneRosterCourse {
  sourcedId: string;
  status: string;
  dateLastModified?: string;
  title: string;
  courseCode?: string;
  grades?: string[];
  subjects?: string[];
  org?: OneRosterLink;
  schoolYear?: OneRosterLink;
}

export interface OneRosterClass {
  sourcedId: string;
  status: string;
  dateLastModified?: string;
  title: string;
  classCode?: string;
  classType?: "homeroom" | "scheduled" | string;
  location?: string;
  grades?: string[];
  subjects?: string[];
  subjectCodes?: string[];
  periods?: string[];
  course?: OneRosterLink;
  school?: OneRosterLink;
  terms?: OneRosterLink[];
}

export interface OneRosterEnrollment {
  sourcedId: string;
  status: string;
  dateLastModified?: string;
  role: "student" | "teacher" | "administrator" | "proctor" | string;
  primary?: string | boolean;
  user: OneRosterLink;
  class: OneRosterLink;
  school: OneRosterLink;
  beginDate?: string;
  endDate?: string;
}

export interface OneRosterDemographics {
  sourcedId: string;
  status: string;
  dateLastModified?: string;
  birthDate?: string;
  sex?: string;
  americanIndianOrAlaskaNative?: string | boolean;
  asian?: string | boolean;
  blackOrAfricanAmerican?: string | boolean;
  nativeHawaiianOrOtherPacificIslander?: string | boolean;
  white?: string | boolean;
  demographicRaceTwoOrMoreRaces?: string | boolean;
  hispanicOrLatinoEthnicity?: string | boolean;
  countryOfBirthCode?: string;
  stateOfBirthAbbreviation?: string;
  cityOfBirth?: string;
  /** Vendor extension — English Language Learner flag when exposed on demographics. */
  ell?: string | boolean;
  englishLanguageLearner?: string | boolean;
  /** Vendor extension — Exceptional Student Education / special education. */
  ese?: string | boolean;
  specialEducation?: string | boolean;
  /** Vendor extension — Section 504 plan. */
  is504?: string | boolean;
  section504?: string | boolean;
}

export interface OneRosterOrgsResponse {
  orgs: OneRosterOrg[];
}

export interface OneRosterUsersResponse {
  users: OneRosterUser[];
}

export interface OneRosterCoursesResponse {
  courses: OneRosterCourse[];
}

export interface OneRosterClassesResponse {
  classes: OneRosterClass[];
}

export interface OneRosterEnrollmentsResponse {
  enrollments: OneRosterEnrollment[];
}

export interface OneRosterDemographicsResponse {
  demographics: OneRosterDemographics[];
}

/** Full bundled fixture set for mock / offline development. */
export interface OneRosterFixtureBundle {
  baseUrl: string;
  orgs: OneRosterOrg[];
  users: OneRosterUser[];
  courses: OneRosterCourse[];
  classes: OneRosterClass[];
  enrollments: OneRosterEnrollment[];
  demographics: OneRosterDemographics[];
}
