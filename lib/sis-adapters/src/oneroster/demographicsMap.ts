import type { SisStudent } from "../types.js";
import type { OneRosterDemographics, OneRosterUser } from "./types.js";

export type MappedStudentDemographics = Pick<
  SisStudent,
  "gender" | "ell" | "ese" | "is504" | "race" | "ethnicity"
>;

function isTruthyFlag(value: string | boolean | undefined): boolean {
  if (value === true) return true;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    return v === "true" || v === "t" || v === "y" || v === "yes" || v === "1";
  }
  return false;
}

function isFalsyFlag(value: string | boolean | undefined): boolean {
  if (value === false) return true;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    return v === "false" || v === "f" || v === "n" || v === "no" || v === "0";
  }
  return false;
}

/**
 * Parse a roster flag when the feed explicitly provides a value.
 * Returns `undefined` when the field is absent so upsert can preserve DB values.
 */
export function parseOptionalBoolFlag(
  raw: unknown,
): boolean | undefined {
  if (raw == null) return undefined;
  if (typeof raw === "boolean") return raw;
  const s = String(raw).trim();
  if (!s) return undefined;
  if (isTruthyFlag(s)) return true;
  if (isFalsyFlag(s)) return false;
  return undefined;
}

function readMetadataFlag(
  metadata: Record<string, unknown> | undefined,
  keys: string[],
): boolean | undefined {
  if (!metadata) return undefined;
  for (const key of keys) {
    if (key in metadata) {
      const parsed = parseOptionalBoolFlag(metadata[key]);
      if (parsed !== undefined) return parsed;
    }
  }
  return undefined;
}

function mapGender(sex: string | undefined): string | null | undefined {
  if (sex == null || !String(sex).trim()) return undefined;
  const s = String(sex).trim().toLowerCase();
  if (s === "male" || s === "m") return "male";
  if (s === "female" || s === "f") return "female";
  return s;
}

function mapEthnicity(
  demo: OneRosterDemographics | undefined,
): string | null | undefined {
  if (!demo) return undefined;
  if (isTruthyFlag(demo.hispanicOrLatinoEthnicity)) return "hispanic";
  if (isFalsyFlag(demo.hispanicOrLatinoEthnicity)) return "non_hispanic";
  return undefined;
}

function mapRace(
  demo: OneRosterDemographics | undefined,
): string | null | undefined {
  if (!demo) return undefined;
  if (isTruthyFlag(demo.demographicRaceTwoOrMoreRaces)) return "multi";
  if (isTruthyFlag(demo.blackOrAfricanAmerican)) return "black";
  if (isTruthyFlag(demo.white)) return "white";
  if (isTruthyFlag(demo.asian)) return "asian";
  if (isTruthyFlag(demo.americanIndianOrAlaskaNative)) return "native";
  if (isTruthyFlag(demo.nativeHawaiianOrOtherPacificIslander)) return "pacific";
  // K-12 feeds sometimes bucket Hispanic under race; ethnicity field is separate.
  if (isTruthyFlag(demo.hispanicOrLatinoEthnicity)) return "hispanic";
  return undefined;
}

function mapProgramFlags(
  user: OneRosterUser,
  demo: OneRosterDemographics | undefined,
): Pick<MappedStudentDemographics, "ell" | "ese" | "is504"> {
  const meta = user.metadata;

  const ell =
    readMetadataFlag(meta, [
      "ell",
      "englishLearner",
      "english_learner",
      "lep",
      "el",
    ]) ??
    parseOptionalBoolFlag(demo?.ell) ??
    parseOptionalBoolFlag(demo?.englishLanguageLearner);

  const ese =
    readMetadataFlag(meta, [
      "ese",
      "sped",
      "swd",
      "iep",
      "exceptionalStudent",
      "exceptional_student",
    ]) ??
    parseOptionalBoolFlag(demo?.ese) ??
    parseOptionalBoolFlag(demo?.specialEducation);

  const is504 =
    readMetadataFlag(meta, [
      "504",
      "is504",
      "is_504",
      "section504",
      "section_504",
      "fivezerofour",
    ]) ??
    parseOptionalBoolFlag(demo?.is504) ??
    parseOptionalBoolFlag(demo?.section504);

  return { ell, ese, is504 };
}

/** Map OneRoster user + demographics row into PulseEDU student demographic columns. */
export function mapStudentDemographics(
  user: OneRosterUser,
  demo: OneRosterDemographics | undefined,
): MappedStudentDemographics {
  const programs = mapProgramFlags(user, demo);
  return {
    gender: mapGender(demo?.sex),
    race: mapRace(demo),
    ethnicity: mapEthnicity(demo),
    ...programs,
  };
}
