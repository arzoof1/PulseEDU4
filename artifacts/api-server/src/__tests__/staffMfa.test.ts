import { afterEach, describe, expect, it } from "vitest";
import { authenticator } from "otplib";
import { encryptMfaSecret, decryptMfaSecret } from "../lib/mfaCrypto";
import {
  generateTotpSecret,
  verifyTotp,
  generateRecoveryCodes,
  normalizeRecoveryCode,
} from "../lib/staffMfa";

describe("mfaCrypto", () => {
  const orig = process.env.MFA_ENC_KEY;
  afterEach(() => {
    if (orig === undefined) delete process.env.MFA_ENC_KEY;
    else process.env.MFA_ENC_KEY = orig;
  });

  it("round-trips under a dedicated MFA_ENC_KEY (versioned format)", () => {
    process.env.MFA_ENC_KEY = "a-dedicated-mfa-key-distinct-from-session";
    const enc = encryptMfaSecret("HELLOWORLDSECRET");
    expect(enc.startsWith("mfa1:")).toBe(true);
    expect(decryptMfaSecret(enc)).toBe("HELLOWORLDSECRET");
  });

  it("round-trips under the fallback when MFA_ENC_KEY is unset", () => {
    delete process.env.MFA_ENC_KEY;
    const enc = encryptMfaSecret("FALLBACKSECRET");
    expect(enc.startsWith("mfa1:")).toBe(false);
    expect(decryptMfaSecret(enc)).toBe("FALLBACKSECRET");
  });
});

describe("staff TOTP", () => {
  it("verifies a freshly generated token and rejects garbage", () => {
    const secret = generateTotpSecret();
    const code = authenticator.generate(secret);
    expect(verifyTotp(secret, code)).toBe(true);
    expect(verifyTotp(secret, "000000")).toBe(false);
    expect(verifyTotp(secret, "not-a-code")).toBe(false);
    expect(verifyTotp(secret, 123456)).toBe(false);
  });
});

describe("recovery codes", () => {
  it("generates the requested count in XXXXX-XXXXX format", () => {
    const codes = generateRecoveryCodes(10);
    expect(codes).toHaveLength(10);
    for (const c of codes) expect(c).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    expect(new Set(codes).size).toBe(10); // no dupes
  });

  it("normalizes user-entered codes (case, spaces, dashes)", () => {
    expect(normalizeRecoveryCode("  abcde-fghjk ")).toBe("ABCDEFGHJK");
    expect(normalizeRecoveryCode("abc de fgh")).toBe("ABCDEFGH");
  });
});
