import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decryptField,
  encryptField,
  isEncryptedField,
} from "@workspace/db/crypto";

// Section 10.6 — field-level encryption for highly sensitive records.
// These tests exercise the crypto primitive that backs the encryptedText /
// encryptedJsonb Drizzle column types (which are thin wrappers over it).

const SAMPLES = [
  "Clear backpack, no sharp objects, escort to bathroom",
  "Talked to Marcus's mom re: bus 14 seating",
  "Student disclosed self-harm ideation — counselor notified",
  "", // empty string (column default case)
  "  leading/trailing space  ",
  "unicode: café ✓ 学生 🚸 — naïve",
  "a".repeat(5000), // long free-text note
  JSON.stringify({ nested: "json-looking string", n: 1 }),
];

describe("fieldCrypto", () => {
  let savedDataKey: string | undefined;
  let savedSession: string | undefined;

  beforeEach(() => {
    savedDataKey = process.env.DATA_ENC_KEY;
    savedSession = process.env.SESSION_SECRET;
  });
  afterEach(() => {
    if (savedDataKey === undefined) delete process.env.DATA_ENC_KEY;
    else process.env.DATA_ENC_KEY = savedDataKey;
    if (savedSession === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = savedSession;
  });

  describe("with a dedicated DATA_ENC_KEY (production posture)", () => {
    beforeEach(() => {
      process.env.DATA_ENC_KEY =
        "unit-test-dedicated-key-0123456789-abcdefghij";
    });

    it("round-trips every sample exactly", () => {
      for (const s of SAMPLES) {
        expect(decryptField(encryptField(s))).toBe(s);
      }
    });

    it("produces the dedicated 'data1:' envelope, not plaintext", () => {
      const enc = encryptField("safety plan notes");
      expect(enc.startsWith("data1:")).toBe(true);
      expect(enc).not.toContain("safety plan notes");
      expect(isEncryptedField(enc)).toBe(true);
    });

    it("is non-deterministic (fresh IV per call)", () => {
      const a = encryptField("same input");
      const b = encryptField("same input");
      expect(a).not.toBe(b); // different IV → different ciphertext
      expect(decryptField(a)).toBe("same input");
      expect(decryptField(b)).toBe("same input");
    });

    it("fails closed on tampering (GCM auth tag)", () => {
      const enc = encryptField("investigation body");
      const parts = enc.split(":");
      // Flip a byte in the ciphertext segment.
      const buf = Buffer.from(parts[2], "base64");
      buf[0] = buf[0] ^ 0xff;
      const tampered = `${parts[0]}:${parts[1]}:${buf.toString("base64")}`;
      expect(() => decryptField(tampered)).toThrow();
    });
  });

  describe("without DATA_ENC_KEY (dev/test fallback)", () => {
    beforeEach(() => {
      delete process.env.DATA_ENC_KEY;
      process.env.SESSION_SECRET = "unit-test-session-secret";
    });

    it("uses the distinct 'dataf1:' prefix and round-trips", () => {
      const enc = encryptField("fallback note");
      expect(enc.startsWith("dataf1:")).toBe(true);
      expect(decryptField(enc)).toBe("fallback note");
    });

    it("fallback-written values still decrypt AFTER DATA_ENC_KEY is set", () => {
      // Simulates the real migration: rows written in dev (fallback) must not
      // orphan once production sets the dedicated key. The prefix records which
      // key path produced each value.
      const encFallback = encryptField("written before key was set");
      expect(encFallback.startsWith("dataf1:")).toBe(true);

      process.env.DATA_ENC_KEY = "now-a-dedicated-key-is-present-xxxxxxxx";
      // Old fallback row still decrypts...
      expect(decryptField(encFallback)).toBe("written before key was set");
      // ...and new writes now use the dedicated envelope.
      const encDedicated = encryptField("written after key was set");
      expect(encDedicated.startsWith("data1:")).toBe(true);
      expect(decryptField(encDedicated)).toBe("written after key was set");
    });
  });

  describe("backwards compatibility", () => {
    it("returns legacy plaintext (no prefix) unchanged", () => {
      // Rows that predate encryption, and empty-string column defaults.
      expect(decryptField("legacy plaintext row")).toBe("legacy plaintext row");
      expect(decryptField("")).toBe("");
      expect(isEncryptedField("legacy plaintext row")).toBe(false);
    });
  });
});
