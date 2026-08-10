import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { mfaEnrollmentGate } from "../lib/mfaEnrollmentGate";

// Build a minimal Express-ish req/res/next. Mounted at "/api", so req.baseUrl
// carries the mount and req.path is the remainder (e.g. "/students").
function harness(overrides: Partial<Request> = {}) {
  const req = {
    baseUrl: "/api",
    path: "/students",
    mfaEnrollmentRequired: false,
    ...overrides,
  } as unknown as Request;

  const res = {
    statusCode: 0,
    body: null as unknown,
    status(code: number) {
      (this as { statusCode: number }).statusCode = code;
      return this;
    },
    json(payload: unknown) {
      (this as { body: unknown }).body = payload;
      return this;
    },
  } as unknown as Response & { statusCode: number; body: unknown };

  const next = vi.fn();
  return { req, res, next };
}

describe("mfaEnrollmentGate", () => {
  it("passes through when enrollment is not required", () => {
    const { req, res, next } = harness({ mfaEnrollmentRequired: false, path: "/students" });
    mfaEnrollmentGate(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(0);
  });

  it("blocks a protected route with 403 when required", () => {
    const { req, res, next } = harness({ mfaEnrollmentRequired: true, path: "/students" });
    mfaEnrollmentGate(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: "mfa_enrollment_required" });
  });

  it.each([
    "/auth/me",
    "/auth/logout",
    "/auth/mfa/status",
    "/auth/mfa/setup",
    "/auth/mfa/verify-setup",
  ])("allows allowlisted route %s even when required", (path) => {
    const { req, res, next } = harness({ mfaEnrollmentRequired: true, path });
    mfaEnrollmentGate(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(0);
  });

  it("blocks non-allowlisted /auth/mfa routes (disable, regenerate) when required", () => {
    for (const path of ["/auth/mfa/disable", "/auth/mfa/recovery-codes/regenerate"]) {
      const { req, res, next } = harness({ mfaEnrollmentRequired: true, path });
      mfaEnrollmentGate(req, res, next);
      expect(next, path).not.toHaveBeenCalled();
      expect(res.statusCode, path).toBe(403);
    }
  });

  it("resolves the /api path even when mounted globally (path already has /api)", () => {
    const { req, res, next } = harness({
      mfaEnrollmentRequired: true,
      baseUrl: "",
      path: "/api/auth/me",
    });
    mfaEnrollmentGate(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
