import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import {
  applySecurityHeaders,
  permissionsPolicyValue,
} from "../lib/securityHeaders";

function makeApp(isProduction: boolean) {
  const app = express();
  applySecurityHeaders(app, isProduction);
  app.get("/probe", (_req, res) => res.json({ ok: true }));
  return app;
}

describe("applySecurityHeaders (DO-11)", () => {
  const originalPermissions = process.env.PERMISSIONS_POLICY;

  afterEach(() => {
    if (originalPermissions === undefined) delete process.env.PERMISSIONS_POLICY;
    else process.env.PERMISSIONS_POLICY = originalPermissions;
  });

  describe("production", () => {
    it("sends HSTS with 1y max-age, includeSubDomains and preload", async () => {
      const res = await request(makeApp(true)).get("/probe");
      const hsts = res.headers["strict-transport-security"];
      expect(hsts).toContain("max-age=31536000");
      expect(hsts).toContain("includeSubDomains");
      expect(hsts).toContain("preload");
    });

    it("sends a strict Content-Security-Policy", async () => {
      const res = await request(makeApp(true)).get("/probe");
      const csp = res.headers["content-security-policy"];
      expect(csp).toBeTruthy();
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("frame-ancestors");
      // No script-src eval — strict script policy.
      expect(csp).not.toContain("'unsafe-eval'");
    });

    it("sends Referrer-Policy and hides X-Powered-By", async () => {
      const res = await request(makeApp(true)).get("/probe");
      expect(res.headers["referrer-policy"]).toBe(
        "strict-origin-when-cross-origin",
      );
      expect(res.headers["x-powered-by"]).toBeUndefined();
    });

    it("sends X-Content-Type-Options: nosniff (helmet default)", async () => {
      const res = await request(makeApp(true)).get("/probe");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
    });
  });

  describe("Permissions-Policy", () => {
    it("is sent in both production and development", async () => {
      const prod = await request(makeApp(true)).get("/probe");
      const dev = await request(makeApp(false)).get("/probe");
      const expected = permissionsPolicyValue();
      expect(prod.headers["permissions-policy"]).toBe(expected);
      expect(dev.headers["permissions-policy"]).toBe(expected);
    });

    it("denies camera, microphone and geolocation by default", async () => {
      const res = await request(makeApp(true)).get("/probe");
      const pp = res.headers["permissions-policy"];
      expect(pp).toContain("camera=()");
      expect(pp).toContain("microphone=()");
      expect(pp).toContain("geolocation=()");
    });

    it("honors the PERMISSIONS_POLICY override", async () => {
      process.env.PERMISSIONS_POLICY = "camera=(self)";
      expect(permissionsPolicyValue()).toBe("camera=(self)");
    });
  });

  describe("development", () => {
    it("disables CSP and HSTS so dev tooling is not broken", async () => {
      const res = await request(makeApp(false)).get("/probe");
      expect(res.headers["content-security-policy"]).toBeUndefined();
      expect(res.headers["strict-transport-security"]).toBeUndefined();
    });
  });
});
