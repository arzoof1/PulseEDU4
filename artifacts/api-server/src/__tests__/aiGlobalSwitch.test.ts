import { afterEach, describe, expect, it } from "vitest";
import { isAiGloballyEnabled } from "../lib/aiGlobalSwitch";

describe("isAiGloballyEnabled", () => {
  const original = process.env.AI_FEATURES_ENABLED;

  afterEach(() => {
    if (original === undefined) delete process.env.AI_FEATURES_ENABLED;
    else process.env.AI_FEATURES_ENABLED = original;
  });

  it("defaults to enabled when unset or empty", () => {
    delete process.env.AI_FEATURES_ENABLED;
    expect(isAiGloballyEnabled()).toBe(true);
    process.env.AI_FEATURES_ENABLED = "";
    expect(isAiGloballyEnabled()).toBe(true);
  });

  it("disables on false-like values", () => {
    for (const v of ["false", "FALSE", "0", "no", "off"]) {
      process.env.AI_FEATURES_ENABLED = v;
      expect(isAiGloballyEnabled()).toBe(false);
    }
  });

  it("stays enabled on true-like values", () => {
    for (const v of ["true", "TRUE", "1", "yes"]) {
      process.env.AI_FEATURES_ENABLED = v;
      expect(isAiGloballyEnabled()).toBe(true);
    }
  });
});
