// Student program-flag mapping (ESE / 504 / ELL) from the OneRoster feed.
//
// These pin a real production defect. Hernando County's ClassLink feed sends
// program flags in user.metadata as UPPERCASE keys:
//
//   { "FLEID": "...", "TCHID": "", "ELL": "Y", "FRL": "", "SWD": "Y", "ELLcode": "LA" }
//
// The lookup matched keys case-SENSITIVELY against lowercase aliases, so
// "ell" in { ELL: "Y" } was false and the value was never even read. Result:
// ~469 ESE and ~102 ELL students (of 4,000 sampled live) all stored as false,
// and every Teacher Roster Programs cell rendered an em-dash. The value parser
// was always fine — "Y" parses correctly; we simply never reached it.
//
// Feed vocabulary note: Florida districts report ESE as SWD ("Students With
// Disabilities"). The two are near-synonyms, so SWD maps to ese.
//
// No 504 equivalent exists anywhere in this feed (verified against the live
// API on 2026-08-12) — that flag stays false until the district adds it, which
// is a district-side gap rather than a mapping bug.

import { describe, it, expect } from "vitest";
import { mapStudentDemographics } from "@workspace/sis-adapters";

type User = Parameters<typeof mapStudentDemographics>[0];

/** A student row shaped exactly like the live Hernando feed. */
function student(metadata: Record<string, unknown>): User {
  return {
    sourcedId: "USRstudent10051",
    status: "active",
    givenName: "Test",
    familyName: "Student",
    role: "student",
    metadata,
  } as User;
}

describe("mapStudentDemographics — program flags", () => {
  it("reads the uppercase keys the live ClassLink feed actually sends", () => {
    const out = mapStudentDemographics(
      student({
        FLEID: "FL000007970575",
        TCHID: "",
        ELL: "Y",
        FRL: "Y",
        SWD: "Y",
        ELLcode: "LA",
      }),
      undefined,
    );
    expect(out.ell).toBe(true);
    // Florida reports ESE as SWD.
    expect(out.ese).toBe(true);
  });

  it("still reads lowercase keys (other districts / fixtures)", () => {
    const out = mapStudentDemographics(
      student({ ell: "true", ese: "true" }),
      undefined,
    );
    expect(out.ell).toBe(true);
    expect(out.ese).toBe(true);
  });

  it("handles mixed-case and underscored variants", () => {
    const out = mapStudentDemographics(
      student({ Ell: "yes", Sped: "1", Section_504: "Y" }),
      undefined,
    );
    expect(out.ell).toBe(true);
    expect(out.ese).toBe(true);
    expect(out.is504).toBe(true);
  });

  it("treats an empty string as 'not provided', not as false", () => {
    // The live feed sends "" for the ~95% of students who carry no flag.
    // Returning undefined (rather than false) matters: the sync's patch
    // builder only writes fields that are !== undefined, so an unflagged
    // student must not clobber a value set by another source.
    const out = mapStudentDemographics(
      student({ ELL: "", SWD: "", ELLcode: "" }),
      undefined,
    );
    expect(out.ell).toBeUndefined();
    expect(out.ese).toBeUndefined();
    expect(out.is504).toBeUndefined();
  });

  it("maps an explicit negative to false", () => {
    const out = mapStudentDemographics(
      student({ ELL: "N", SWD: "false" }),
      undefined,
    );
    expect(out.ell).toBe(false);
    expect(out.ese).toBe(false);
  });

  it("leaves 504 unset when the feed carries no 504 field at all", () => {
    const out = mapStudentDemographics(
      student({ ELL: "Y", SWD: "Y" }),
      undefined,
    );
    expect(out.is504).toBeUndefined();
  });

  it("does not confuse FRL (free/reduced lunch) with a program flag", () => {
    // FRL is populated for ~47% of students and is NOT an ESE/504/ELL signal.
    const out = mapStudentDemographics(
      student({ FRL: "Y", ELL: "", SWD: "" }),
      undefined,
    );
    expect(out.ell).toBeUndefined();
    expect(out.ese).toBeUndefined();
    expect(out.is504).toBeUndefined();
  });

  it("falls back to the demographics collection when metadata has nothing", () => {
    const out = mapStudentDemographics(student({}), {
      sourcedId: "USRstudent10051",
      status: "active",
      ell: "true",
    } as never);
    expect(out.ell).toBe(true);
  });
});
