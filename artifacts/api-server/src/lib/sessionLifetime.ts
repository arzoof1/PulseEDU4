// Pure session-lifetime policy (DV-07), split out from app.ts so it can be
// unit-tested without booting the app / DB layer.
//
// express-session is configured with `rolling: true` + a 14-day cookie, which
// gives a single 14-day idle window for EVERYONE and no absolute cap. This adds
// two server-side bounds on top of the cookie:
//   - idle timeout     — re-auth after a period of inactivity
//   - absolute timeout — re-auth a fixed time after sign-in regardless of activity
// with a much tighter pair for privileged (Admin / District Admin / SuperUser)
// sessions. All four values are env-overridable so the district's approved
// durations (tracker dependency for DV-07) can be set without a code change.

export interface SessionLifetimeCaps {
  /** Max time since last activity before re-auth is required. */
  idleMs: number;
  /** Max time since sign-in before re-auth is required, regardless of activity. */
  absoluteMs: number;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Defaults. Regular users keep close to the prior 14-day feel (idle 14d) with a
// 30-day absolute backstop. Privileged sessions are deliberately short: an 8h
// idle window (a work day) and a 24h absolute cap force daily privileged re-auth.
export const DEFAULT_REGULAR_CAPS: SessionLifetimeCaps = {
  idleMs: 14 * DAY,
  absoluteMs: 30 * DAY,
};
export const DEFAULT_PRIVILEGED_CAPS: SessionLifetimeCaps = {
  idleMs: 8 * HOUR,
  absoluteMs: 24 * HOUR,
};

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function regularCaps(): SessionLifetimeCaps {
  return {
    idleMs: envMs("SESSION_IDLE_MS", DEFAULT_REGULAR_CAPS.idleMs),
    absoluteMs: envMs("SESSION_ABSOLUTE_MS", DEFAULT_REGULAR_CAPS.absoluteMs),
  };
}

export function privilegedCaps(): SessionLifetimeCaps {
  return {
    idleMs: envMs("SESSION_PRIV_IDLE_MS", DEFAULT_PRIVILEGED_CAPS.idleMs),
    absoluteMs: envMs(
      "SESSION_PRIV_ABSOLUTE_MS",
      DEFAULT_PRIVILEGED_CAPS.absoluteMs,
    ),
  };
}

export function capsFor(isPrivileged: boolean): SessionLifetimeCaps {
  return isPrivileged ? privilegedCaps() : regularCaps();
}

// Master activation flag. Default OFF so deploying the mechanism changes NOTHING
// (sessions keep the existing rolling-cookie behavior). Set true once the
// district's session durations are approved to begin enforcing idle/absolute
// timeouts. Mirrors the inert-until-activated posture of the RLS work.
export function isStaffSessionTimeoutEnabled(): boolean {
  const raw = process.env.STAFF_SESSION_TIMEOUT_ENABLED?.trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}

export interface SessionTimestamps {
  /** Epoch ms when the session was established (first authenticated request). */
  createdAt?: number;
  /** Epoch ms of the previous authenticated request. */
  lastSeenAt?: number;
  isPrivileged?: boolean;
}

export type SessionExpiry =
  | { expired: false }
  | { expired: true; reason: "idle" | "absolute" };

/**
 * Decide whether a session has exceeded its idle or absolute lifetime.
 *
 * Fail-open when a timestamp is missing (a freshly-initialized session hasn't
 * recorded one yet) — the caller stamps them, so the bound applies from the
 * next request on. Negative ages (clock skew / future timestamps) are treated
 * as not-expired rather than trusting a timestamp ahead of `now`.
 */
export function evaluateSession(
  session: SessionTimestamps,
  now: number = Date.now(),
  caps: SessionLifetimeCaps = capsFor(session.isPrivileged === true),
): SessionExpiry {
  const { createdAt, lastSeenAt } = session;

  if (typeof createdAt === "number") {
    const age = now - createdAt;
    if (age >= caps.absoluteMs) return { expired: true, reason: "absolute" };
  }
  if (typeof lastSeenAt === "number") {
    const idle = now - lastSeenAt;
    if (idle >= caps.idleMs) return { expired: true, reason: "idle" };
  }
  return { expired: false };
}
