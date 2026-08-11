// Forced-password-change gate: an account holding an admin-issued temp
// password (bulk generator or roster-sync placeholder) must be able to reach
// nothing except changing that password or signing out. Pure allow/deny logic,
// same harness shape as mfaEnrollmentGate.test.ts.

import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { passwordSetupGate } from "../lib/passwordSetupGate";

// Mounted at "/api", so req.baseUrl carries the mount and req.path is the
// remainder (e.g. "/students").
function harness(overrides: Partial<Request> = {}) {
  const req = {
    baseUrl: "/api",
    path: "/students",
    passwordSetupRequired: false,
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

describe("passwordSetupGate", () => {
  it("passes through when no password setup is pending", () => {
    const { req, res, next } = harness({ passwordSetupRequired: false });
    passwordSetupGate(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(0);
  });

  it("blocks a protected route with 403 when a reset is pending", () => {
    const { req, res, next } = harness({
      passwordSetupRequired: true,
      path: "/students",
    });
    passwordSetupGate(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: "password_setup_required" });
  });

  it("allows exactly the escape-hatch routes", () => {
    for (const path of ["/auth/me", "/auth/logout", "/auth/change-password"]) {
      const { req, res, next } = harness({
        passwordSetupRequired: true,
        path,
      });
      passwordSetupGate(req, res, next);
      expect(next, `${path} should pass`).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(0);
    }
  });

  it("does NOT allow the token-based reset routes", () => {
    // Those are for signed-OUT users following an emailed link; admitting them
    // here would let a walled session wander outside change-password.
    for (const path of ["/auth/reset", "/auth/reset-password"]) {
      const { req, res, next } = harness({
        passwordSetupRequired: true,
        path,
      });
      passwordSetupGate(req, res, next);
      expect(next, `${path} should be blocked`).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
    }
  });

  it("resolves the allowlist when mounted without a baseUrl", () => {
    const { req, res, next } = harness({
      passwordSetupRequired: true,
      baseUrl: "",
      path: "/api/auth/change-password",
    });
    passwordSetupGate(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
