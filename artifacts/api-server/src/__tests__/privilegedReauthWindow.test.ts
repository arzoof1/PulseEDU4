import { describe, it, expect } from "vitest";
import {
  hasFreshPrivilegedReauth,
  PRIVILEGED_REAUTH_WINDOW_MS,
} from "../lib/privilegedReauthWindow.js";

// Pure boundary tests for the step-up window (Section 1.15). No DB needed.
describe("hasFreshPrivilegedReauth", () => {
  const now = 1_700_000_000_000;

  it("is false when the session never reauthed", () => {
    expect(hasFreshPrivilegedReauth(undefined, now)).toBe(false);
    expect(hasFreshPrivilegedReauth(null, now)).toBe(false);
    expect(hasFreshPrivilegedReauth({}, now)).toBe(false);
  });

  it("is true at and within the window", () => {
    expect(hasFreshPrivilegedReauth({ privilegedReauthAt: now }, now)).toBe(true);
    expect(
      hasFreshPrivilegedReauth({ privilegedReauthAt: now - 1000 }, now),
    ).toBe(true);
    expect(
      hasFreshPrivilegedReauth(
        { privilegedReauthAt: now - (PRIVILEGED_REAUTH_WINDOW_MS - 1) },
        now,
      ),
    ).toBe(true);
  });

  it("is false once the window has elapsed", () => {
    expect(
      hasFreshPrivilegedReauth(
        { privilegedReauthAt: now - PRIVILEGED_REAUTH_WINDOW_MS },
        now,
      ),
    ).toBe(false);
    expect(
      hasFreshPrivilegedReauth(
        { privilegedReauthAt: now - PRIVILEGED_REAUTH_WINDOW_MS - 1 },
        now,
      ),
    ).toBe(false);
  });

  it("is false for a future timestamp (clock skew is not trusted)", () => {
    expect(
      hasFreshPrivilegedReauth({ privilegedReauthAt: now + 5000 }, now),
    ).toBe(false);
  });
});
