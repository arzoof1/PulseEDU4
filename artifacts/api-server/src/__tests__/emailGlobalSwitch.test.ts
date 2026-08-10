import { afterEach, describe, expect, it } from "vitest";
import { isEmailGloballyEnabled } from "../lib/emailGlobalSwitch";

describe("isEmailGloballyEnabled", () => {
  const original = process.env.EMAIL_ENABLED;

  afterEach(() => {
    if (original === undefined) delete process.env.EMAIL_ENABLED;
    else process.env.EMAIL_ENABLED = original;
  });

  it("defaults to enabled when unset or empty", () => {
    delete process.env.EMAIL_ENABLED;
    expect(isEmailGloballyEnabled()).toBe(true);
    process.env.EMAIL_ENABLED = "";
    expect(isEmailGloballyEnabled()).toBe(true);
  });

  it("disables on false-like values", () => {
    for (const v of ["false", "FALSE", "0", "no", "off"]) {
      process.env.EMAIL_ENABLED = v;
      expect(isEmailGloballyEnabled()).toBe(false);
    }
  });

  it("stays enabled on true-like values", () => {
    for (const v of ["true", "TRUE", "1", "yes"]) {
      process.env.EMAIL_ENABLED = v;
      expect(isEmailGloballyEnabled()).toBe(true);
    }
  });
});
