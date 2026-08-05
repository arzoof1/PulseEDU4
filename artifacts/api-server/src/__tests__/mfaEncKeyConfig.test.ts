import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateMfaEncKeyConfig,
  isMfaEncKeyRequired,
} from "../lib/mfaCrypto";

describe("evaluateMfaEncKeyConfig (DO-07)", () => {
  it("reports 'configured' when a dedicated key is set", () => {
    const r = evaluateMfaEncKeyConfig({
      hasKey: true,
      mfaEnabled: true,
      isProduction: true,
      strict: true, // even strict never throws once the key exists
    });
    expect(r.status).toBe("configured");
    expect(r.shouldThrow).toBe(false);
    expect(r.level).toBe("info");
  });

  it("reports 'not_required' when MFA is disabled and no key is set", () => {
    const r = evaluateMfaEncKeyConfig({
      hasKey: false,
      mfaEnabled: false,
      isProduction: true,
      strict: true, // not required, so still no throw
    });
    expect(r.status).toBe("not_required");
    expect(r.shouldThrow).toBe(false);
  });

  it("SAFETY: prod + MFA on + no key does NOT throw by default (warn only)", () => {
    const r = evaluateMfaEncKeyConfig({
      hasKey: false,
      mfaEnabled: true,
      isProduction: true,
      strict: false,
    });
    expect(r.status).toBe("fallback");
    expect(r.shouldThrow).toBe(false); // must never crash prod on deploy
    expect(r.level).toBe("warn"); // but surfaces loudly
  });

  it("is quiet (info) about the fallback in non-production", () => {
    const r = evaluateMfaEncKeyConfig({
      hasKey: false,
      mfaEnabled: true,
      isProduction: false,
      strict: false,
    });
    expect(r.status).toBe("fallback");
    expect(r.level).toBe("info");
    expect(r.shouldThrow).toBe(false);
  });

  it("enforces (throws) ONLY when strict and the key is missing while required", () => {
    const r = evaluateMfaEncKeyConfig({
      hasKey: false,
      mfaEnabled: true,
      isProduction: true,
      strict: true,
    });
    expect(r.status).toBe("fallback");
    expect(r.shouldThrow).toBe(true);
  });

  describe("isMfaEncKeyRequired env parsing", () => {
    const original = process.env.MFA_ENC_KEY_REQUIRED;
    afterEach(() => {
      if (original === undefined) delete process.env.MFA_ENC_KEY_REQUIRED;
      else process.env.MFA_ENC_KEY_REQUIRED = original;
    });

    it("defaults to false when unset", () => {
      delete process.env.MFA_ENC_KEY_REQUIRED;
      expect(isMfaEncKeyRequired()).toBe(false);
    });

    it("is true only for truthy strings", () => {
      for (const v of ["true", "TRUE", "1", "yes", "on"]) {
        process.env.MFA_ENC_KEY_REQUIRED = v;
        expect(isMfaEncKeyRequired()).toBe(true);
      }
      for (const v of ["false", "0", "no", "off", ""]) {
        process.env.MFA_ENC_KEY_REQUIRED = v;
        expect(isMfaEncKeyRequired()).toBe(false);
      }
    });
  });
});
