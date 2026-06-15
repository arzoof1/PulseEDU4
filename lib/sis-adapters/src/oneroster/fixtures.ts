import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  OneRosterClassesResponse,
  OneRosterCoursesResponse,
  OneRosterDemographicsResponse,
  OneRosterEnrollmentsResponse,
  OneRosterFixtureBundle,
  OneRosterOrgsResponse,
  OneRosterUsersResponse,
} from "./types.js";

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "oneroster-v1p1",
);

export const ONEROSTER_FIXTURE_BASE_URL =
  "https://demo.classlink.com/oneroster/v1p1";

function readJson<T>(filename: string): T {
  const raw = readFileSync(join(FIXTURE_DIR, filename), "utf8");
  return JSON.parse(raw) as T;
}

/** Load the full Parrott Middle School pilot fixture bundle from disk. */
export function loadOneRosterFixtures(): OneRosterFixtureBundle {
  const orgs = readJson<OneRosterOrgsResponse>("orgs.json").orgs;
  const users = readJson<OneRosterUsersResponse>("users.json").users;
  const courses = readJson<OneRosterCoursesResponse>("courses.json").courses;
  const classes = readJson<OneRosterClassesResponse>("classes.json").classes;
  const enrollments =
    readJson<OneRosterEnrollmentsResponse>("enrollments.json").enrollments;
  const demographics =
    readJson<OneRosterDemographicsResponse>("demographics.json").demographics;

  return {
    baseUrl: ONEROSTER_FIXTURE_BASE_URL,
    orgs,
    users,
    courses,
    classes,
    enrollments,
    demographics,
  };
}

/** Path to on-disk fixture directory (for tests or documentation). */
export function oneRosterFixtureDir(): string {
  return FIXTURE_DIR;
}
