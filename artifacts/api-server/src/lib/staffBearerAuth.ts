import { db, staffTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { issueAuthToken, verifyAuthToken } from "./authToken.js";

/** Staff bearer tokens are opt-in (Replit iframe legacy). Production uses cookies only. */
export function isStaffBearerAuthEnabled(): boolean {
  return process.env.STAFF_BEARER_AUTH_ENABLED === "true";
}

export async function bumpStaffAuthTokenVersion(staffId: number): Promise<void> {
  const [row] = await db
    .select({ authTokenVersion: staffTable.authTokenVersion })
    .from(staffTable)
    .where(eq(staffTable.id, staffId));
  if (!row) return;
  await db
    .update(staffTable)
    .set({ authTokenVersion: (row.authTokenVersion ?? 0) + 1 })
    .where(eq(staffTable.id, staffId));
}

/**
 * Validates a bearer token (signature, expiry, kind) and checks auth_token_version.
 * Returns null when bearer auth is disabled or the token is revoked.
 */
export async function staffIdFromBearerToken(
  token: string,
): Promise<number | null> {
  if (!isStaffBearerAuthEnabled()) return null;

  const parsed = verifyAuthToken(token);
  if (!parsed) return null;

  const [staff] = await db
    .select({
      authTokenVersion: staffTable.authTokenVersion,
      active: staffTable.active,
    })
    .from(staffTable)
    .where(eq(staffTable.id, parsed.staffId));

  if (!staff?.active) return null;
  if (staff.authTokenVersion !== parsed.tokenVersion) return null;

  return parsed.staffId;
}

export async function issueStaffAuthTokenIfEnabled(
  staffId: number,
): Promise<string | undefined> {
  if (!isStaffBearerAuthEnabled()) return undefined;

  const [staff] = await db
    .select({ authTokenVersion: staffTable.authTokenVersion })
    .from(staffTable)
    .where(eq(staffTable.id, staffId));

  return issueAuthToken(staffId, staff?.authTokenVersion ?? 0);
}
