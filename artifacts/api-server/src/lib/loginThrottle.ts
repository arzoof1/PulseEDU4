import type { Request, Response } from "express";
import { db, loginThrottleTable, pool } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger.js";

export type LoginScope = "staff" | "parent";

export const LOGIN_RATE_LIMIT_MESSAGE =
  "Too many sign-in attempts. Try again later.";

// Exported so the login route can raise a security alert (Section 3.2) the
// moment a per-account or per-IP failure count crosses the lockout threshold.
export const WINDOW_MS = Number(
  process.env.LOGIN_RATE_WINDOW_MS ?? 15 * 60 * 1000,
);
const LOCKOUT_MS = Number(process.env.LOGIN_LOCKOUT_MS ?? 15 * 60 * 1000);
export const MAX_PER_IP = Number(process.env.LOGIN_RATE_MAX_PER_IP ?? 60);
export const MAX_PER_EMAIL = Number(process.env.LOGIN_RATE_MAX_PER_EMAIL ?? 8);

export const PARENT_LOGIN_MAX_BCRYPT_CHECKS = Number(
  process.env.PARENT_LOGIN_MAX_BCRYPT_CHECKS ?? 5,
);

let tableReady: Promise<void> | null = null;

function ensureLoginThrottleTable(): Promise<void> {
  if (!tableReady) {
    tableReady = pool
      .query(`
        CREATE TABLE IF NOT EXISTS login_throttle (
          throttle_key text PRIMARY KEY,
          fail_count integer NOT NULL DEFAULT 0,
          window_start timestamptz NOT NULL DEFAULT now(),
          locked_until timestamptz
        )
      `)
      .then(() => undefined)
      .catch((err) => {
        tableReady = null;
        throw err;
      });
  }
  return tableReady;
}

// Proxy-aware client IP. Relies on `app.set("trust proxy", 1)` so
// req.ip reflects the trusted proxy's view of the client rather than a
// raw, attacker-spoofable X-Forwarded-For header.
export function clientIp(req: Request): string {
  const ip = req.ip?.trim();
  return ip && ip.length > 0 ? ip : "unknown";
}

function emailKey(scope: LoginScope, normalizedEmail: string): string {
  return `${scope}-email:${normalizedEmail}`;
}

function ipKey(scope: LoginScope, ip: string): string {
  return `${scope}-ip:${ip}`;
}

function maxForKey(key: string): number {
  return key.includes("-ip:") ? MAX_PER_IP : MAX_PER_EMAIL;
}

export type LoginThrottleBlocked = {
  retryAfterSec: number;
};

async function loadRow(key: string) {
  await ensureLoginThrottleTable();
  const [row] = await db
    .select()
    .from(loginThrottleTable)
    .where(eq(loginThrottleTable.throttleKey, key));
  return row ?? null;
}

function retryAfterSeconds(lockedUntil: Date): number {
  const sec = Math.ceil((lockedUntil.getTime() - Date.now()) / 1000);
  return Math.max(1, sec);
}

async function checkKey(
  key: string,
  max: number = maxForKey(key),
  windowMs: number = WINDOW_MS,
  lockoutMs: number = LOCKOUT_MS,
): Promise<LoginThrottleBlocked | null> {
  const row = await loadRow(key);
  if (!row) return null;

  const now = Date.now();
  if (row.lockedUntil && row.lockedUntil.getTime() > now) {
    return { retryAfterSec: retryAfterSeconds(row.lockedUntil) };
  }

  const windowAge = now - row.windowStart.getTime();
  if (windowAge <= windowMs && row.failCount >= max) {
    const lockedUntil = new Date(now + lockoutMs);
    await db
      .update(loginThrottleTable)
      .set({ lockedUntil })
      .where(eq(loginThrottleTable.throttleKey, key));
    return { retryAfterSec: retryAfterSeconds(lockedUntil) };
  }

  return null;
}

/** Returns block info if the IP or email is rate-limited / locked out. */
export async function checkLoginAllowed(
  req: Request,
  scope: LoginScope,
  normalizedEmail: string,
): Promise<LoginThrottleBlocked | null> {
  const ip = clientIp(req);
  const blockedIp = await checkKey(ipKey(scope, ip));
  if (blockedIp) {
    logger.info({ scope, ip }, "login rate limit (ip)");
    return blockedIp;
  }
  const blockedEmail = await checkKey(emailKey(scope, normalizedEmail));
  if (blockedEmail) {
    logger.info({ scope }, "login rate limit (email)");
    return blockedEmail;
  }
  return null;
}

export function sendLoginRateLimited(
  res: Response,
  blocked: LoginThrottleBlocked,
): void {
  res.setHeader("Retry-After", String(blocked.retryAfterSec));
  res.status(429).json({ error: LOGIN_RATE_LIMIT_MESSAGE });
}

// Returns the new failure count for this key within the current window.
async function bumpFailureKey(
  key: string,
  max: number = maxForKey(key),
  windowMs: number = WINDOW_MS,
  lockoutMs: number = LOCKOUT_MS,
): Promise<number> {
  await ensureLoginThrottleTable();
  const now = new Date();
  let resultCount = 1;

  await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(loginThrottleTable)
      .where(eq(loginThrottleTable.throttleKey, key));

    if (!row) {
      await tx.insert(loginThrottleTable).values({
        throttleKey: key,
        failCount: 1,
        windowStart: now,
        lockedUntil: null,
      });
      resultCount = 1;
      return;
    }

    let failCount = row.failCount;
    let windowStart = row.windowStart;
    if (now.getTime() - windowStart.getTime() > windowMs) {
      failCount = 1;
      windowStart = now;
    } else {
      failCount += 1;
    }

    let lockedUntil = row.lockedUntil;
    if (failCount >= max) {
      lockedUntil = new Date(now.getTime() + lockoutMs);
    }

    await tx
      .update(loginThrottleTable)
      .set({
        failCount,
        windowStart,
        lockedUntil,
      })
      .where(eq(loginThrottleTable.throttleKey, key));
    resultCount = failCount;
  });
  return resultCount;
}

// Records a failed attempt against both the IP and email keys and returns the
// resulting counts, so the caller can alert when a threshold is crossed.
export async function recordLoginFailure(
  req: Request,
  scope: LoginScope,
  normalizedEmail: string,
): Promise<{ ipCount: number; emailCount: number }> {
  const ip = clientIp(req);
  try {
    const ipCount = await bumpFailureKey(ipKey(scope, ip));
    const emailCount = await bumpFailureKey(emailKey(scope, normalizedEmail));
    return { ipCount, emailCount };
  } catch (err) {
    logger.warn({ err, scope }, "login throttle failure record failed");
    return { ipCount: 0, emailCount: 0 };
  }
}

// ---------------------------------------------------------------------
// Generic, DB-backed throttle primitives.
//
// These reuse the same `login_throttle` table (an arbitrary text PK) so
// callers outside the login flow — e.g. the unauthenticated kiosk PIN
// endpoint — can persist a failure counter that survives restarts and
// is shared across processes. Use a distinct key prefix per caller
// (e.g. "kioskpin:<schoolId>:<staffId>") to avoid collisions with the
// login IP/email keys.

export type ThrottleParams = {
  /** Fail count within the window at/after which the key is locked. */
  max: number;
  /** Sliding window (ms) over which failures accumulate. */
  windowMs?: number;
  /** Lockout duration (ms) applied once `max` is reached. */
  lockoutMs?: number;
};

/** Returns block info if `key` is currently rate-limited / locked out. */
export async function checkThrottleKey(
  key: string,
  params: ThrottleParams,
): Promise<LoginThrottleBlocked | null> {
  return checkKey(
    key,
    params.max,
    params.windowMs ?? WINDOW_MS,
    params.lockoutMs ?? LOCKOUT_MS,
  );
}

/** Records a failure against `key`, returning the resulting count. */
export async function recordThrottleKeyFailure(
  key: string,
  params: ThrottleParams,
): Promise<number> {
  try {
    return await bumpFailureKey(
      key,
      params.max,
      params.windowMs ?? WINDOW_MS,
      params.lockoutMs ?? LOCKOUT_MS,
    );
  } catch (err) {
    logger.warn({ err, key }, "throttle failure record failed");
    return 0;
  }
}

/** Clears the counter/lockout for `key` (e.g. after a successful use). */
export async function clearThrottleKey(key: string): Promise<void> {
  await ensureLoginThrottleTable();
  try {
    await db
      .update(loginThrottleTable)
      .set({ failCount: 0, lockedUntil: null, windowStart: new Date() })
      .where(eq(loginThrottleTable.throttleKey, key));
  } catch (err) {
    logger.warn({ err, key }, "throttle clear failed");
  }
}

export async function recordLoginSuccess(
  req: Request,
  scope: LoginScope,
  normalizedEmail: string,
): Promise<void> {
  await ensureLoginThrottleTable();
  const key = emailKey(scope, normalizedEmail);
  try {
    await db
      .update(loginThrottleTable)
      .set({
        failCount: 0,
        lockedUntil: null,
        windowStart: new Date(),
      })
      .where(eq(loginThrottleTable.throttleKey, key));
  } catch (err) {
    logger.warn({ err, scope }, "login throttle success record failed");
  }
  void req;
}
