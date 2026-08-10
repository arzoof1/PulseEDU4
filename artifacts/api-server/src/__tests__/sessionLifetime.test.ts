import { afterEach, describe, expect, it } from "vitest";
import {
  capsFor,
  DEFAULT_PRIVILEGED_CAPS,
  DEFAULT_REGULAR_CAPS,
  evaluateSession,
  privilegedCaps,
  regularCaps,
} from "../lib/sessionLifetime";

const T0 = 1_700_000_000_000; // fixed reference "now"
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("evaluateSession (DV-07)", () => {
  const envKeys = [
    "SESSION_IDLE_MS",
    "SESSION_ABSOLUTE_MS",
    "SESSION_PRIV_IDLE_MS",
    "SESSION_PRIV_ABSOLUTE_MS",
  ];
  const saved: Record<string, string | undefined> = {};
  for (const k of envKeys) saved[k] = process.env[k];
  afterEach(() => {
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("fails open when timestamps are missing", () => {
    expect(evaluateSession({}, T0)).toEqual({ expired: false });
    expect(evaluateSession({ isPrivileged: true }, T0)).toEqual({
      expired: false,
    });
  });

  it("keeps a fresh, recently-active session alive", () => {
    const s = { createdAt: T0 - HOUR, lastSeenAt: T0 - 60_000 };
    expect(evaluateSession(s, T0)).toEqual({ expired: false });
  });

  it("expires a privileged session on the 8h idle bound", () => {
    const s = {
      createdAt: T0 - 9 * HOUR,
      lastSeenAt: T0 - (8 * HOUR + 1),
      isPrivileged: true,
    };
    expect(evaluateSession(s, T0)).toEqual({ expired: true, reason: "idle" });
  });

  it("expires a privileged session on the 24h absolute bound even if active", () => {
    const s = {
      createdAt: T0 - (24 * HOUR + 1),
      lastSeenAt: T0 - 1000, // just used it
      isPrivileged: true,
    };
    expect(evaluateSession(s, T0)).toEqual({
      expired: true,
      reason: "absolute",
    });
  });

  it("does NOT apply the tight privileged bounds to a regular session", () => {
    // 12h idle / 12h old would kill a privileged session but not a regular one.
    const s = {
      createdAt: T0 - 12 * HOUR,
      lastSeenAt: T0 - 12 * HOUR,
      isPrivileged: false,
    };
    expect(evaluateSession(s, T0)).toEqual({ expired: false });
  });

  it("expires a regular session past the 30d absolute bound", () => {
    const s = { createdAt: T0 - (30 * DAY + 1), lastSeenAt: T0 - 1000 };
    expect(evaluateSession(s, T0)).toEqual({
      expired: true,
      reason: "absolute",
    });
  });

  it("treats clock skew (future timestamps) as not-expired", () => {
    const s = { createdAt: T0 + HOUR, lastSeenAt: T0 + HOUR, isPrivileged: true };
    expect(evaluateSession(s, T0)).toEqual({ expired: false });
  });

  it("prefers the absolute reason when both bounds are exceeded", () => {
    const s = {
      createdAt: T0 - 40 * DAY,
      lastSeenAt: T0 - 40 * DAY,
      isPrivileged: false,
    };
    expect(evaluateSession(s, T0)).toEqual({
      expired: true,
      reason: "absolute",
    });
  });

  it("honors env overrides for privileged caps", () => {
    process.env.SESSION_PRIV_IDLE_MS = String(30 * 60 * 1000); // 30m
    const caps = privilegedCaps();
    expect(caps.idleMs).toBe(30 * 60 * 1000);
    const s = {
      createdAt: T0 - HOUR,
      lastSeenAt: T0 - (31 * 60 * 1000),
      isPrivileged: true,
    };
    expect(evaluateSession(s, T0, caps)).toEqual({
      expired: true,
      reason: "idle",
    });
  });

  it("exposes sane defaults and selects caps by privilege", () => {
    expect(regularCaps()).toEqual(DEFAULT_REGULAR_CAPS);
    expect(privilegedCaps()).toEqual(DEFAULT_PRIVILEGED_CAPS);
    expect(capsFor(true)).toEqual(DEFAULT_PRIVILEGED_CAPS);
    expect(capsFor(false)).toEqual(DEFAULT_REGULAR_CAPS);
  });
});
