// Parent bearer-token version revocation (DV-10). Mirrors staffBearerAuth:
// parent bearer tokens carry a version (`tv`) that is checked against
// parents.auth_token_version, so bumping the version (logout / password reset /
// admin revoke) invalidates every previously-issued token immediately instead
// of leaving it valid until its natural 12h expiry.
import { db, parentsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { issueParentAuthToken } from "./authToken.js";

// Production applies schema via app-time ensures (not drizzle migrations), so
// self-heal the column once per process before any version read/write. Cheap
// after the first call; kept off the session hot path by only calling it from
// the version helpers below (and the bearer branch of requireActiveParent).
let columnEnsured = false;
export async function ensureParentAuthTokenVersionColumn(): Promise<void> {
  if (columnEnsured) return;
  await db.execute(
    sql`ALTER TABLE parents ADD COLUMN IF NOT EXISTS auth_token_version INTEGER NOT NULL DEFAULT 0`,
  );
  columnEnsured = true;
}

/** Current version for a parent (0 if the row/column is missing). */
export async function parentAuthTokenVersion(parentId: number): Promise<number> {
  await ensureParentAuthTokenVersionColumn();
  const [row] = await db
    .select({ v: parentsTable.authTokenVersion })
    .from(parentsTable)
    .where(eq(parentsTable.id, parentId));
  return row?.v ?? 0;
}

/** Invalidate every existing parent bearer token by bumping the version. */
export async function bumpParentAuthTokenVersion(
  parentId: number,
): Promise<void> {
  await ensureParentAuthTokenVersionColumn();
  const [row] = await db
    .select({ v: parentsTable.authTokenVersion })
    .from(parentsTable)
    .where(eq(parentsTable.id, parentId));
  if (!row) return;
  await db
    .update(parentsTable)
    .set({ authTokenVersion: (row.v ?? 0) + 1 })
    .where(eq(parentsTable.id, parentId));
}

/**
 * Issue a parent bearer token stamped with the parent's CURRENT version, so a
 * token minted right after a bump (e.g. the new token handed back at the end of
 * a password reset) is valid while all older tokens are not.
 */
export async function issueParentBearerToken(parentId: number): Promise<string> {
  const version = await parentAuthTokenVersion(parentId);
  return issueParentAuthToken(parentId, version);
}
