import type { Request, Response } from "express";
import { db, loginThrottleTable, pool } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger.js";

export type LoginScope = "staff" | "parent";

export const LOGIN_RATE_LIMIT_MESSAGE =
  "Too many sign-in attempts. Try again later.";

const WINDOW_MS = Number(process.env.LOGIN_RATE_WINDOW_MS ?? 15 * 60 * 1000);
const LOCKOUT_MS = Number(process.env.LOGIN_LOCKOUT_MS ?? 15 * 60 * 1000);
const MAX_PER_IP = Number(process.env.LOGIN_RATE_MAX_PER_IP ?? 60);
const MAX_PER_EMAIL = Number(process.env.LOGIN_RATE_MAX_PER_EMAIL ?? 8);

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

function clientIp(req: Request): string {
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
): Promise<LoginThrottleBlocked | null> {
  const row = await loadRow(key);
  if (!row) return null;

  const now = Date.now();
  if (row.lockedUntil && row.lockedUntil.getTime() > now) {
    return { retryAfterSec: retryAfterSeconds(row.lockedUntil) };
  }

  const windowAge = now - row.windowStart.getTime();
  const max = maxForKey(key);
  if (windowAge <= WINDOW_MS && row.failCount >= max) {
    const lockedUntil = new Date(now + LOCKOUT_MS);
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

async function bumpFailureKey(key: string): Promise<void> {
  await ensureLoginThrottleTable();
  const now = new Date();
  const max = maxForKey(key);

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
      return;
    }

    let failCount = row.failCount;
    let windowStart = row.windowStart;
    if (now.getTime() - windowStart.getTime() > WINDOW_MS) {
      failCount = 1;
      windowStart = now;
    } else {
      failCount += 1;
    }

    let lockedUntil = row.lockedUntil;
    if (failCount >= max) {
      lockedUntil = new Date(now.getTime() + LOCKOUT_MS);
    }

    await tx
      .update(loginThrottleTable)
      .set({
        failCount,
        windowStart,
        lockedUntil,
      })
      .where(eq(loginThrottleTable.throttleKey, key));
  });
}

export async function recordLoginFailure(
  req: Request,
  scope: LoginScope,
  normalizedEmail: string,
): Promise<void> {
  const ip = clientIp(req);
  try {
    await bumpFailureKey(ipKey(scope, ip));
    await bumpFailureKey(emailKey(scope, normalizedEmail));
  } catch (err) {
    logger.warn({ err, scope }, "login throttle failure record failed");
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
