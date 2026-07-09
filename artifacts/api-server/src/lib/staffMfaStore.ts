import { and, eq, isNull, sql } from "drizzle-orm";
import { db, staffMfaRecoveryCodesTable } from "@workspace/db";
import { bcryptHash, bcryptCompare } from "./bcrypt.js";
import { normalizeRecoveryCode } from "./staffMfa.js";

// DB-backed storage for staff MFA recovery codes. Codes are stored as bcrypt
// hashes (never plaintext), one row per code, so a DB read can't reveal a
// usable code and single-use is tracked via used_at.

// Replace a staff member's entire recovery-code set with fresh bcrypt hashes.
export async function storeRecoveryCodes(
  staffId: number,
  codes: string[],
): Promise<void> {
  await db
    .delete(staffMfaRecoveryCodesTable)
    .where(eq(staffMfaRecoveryCodesTable.staffId, staffId));
  const hashes = await Promise.all(
    codes.map((c) => bcryptHash(normalizeRecoveryCode(c))),
  );
  await db
    .insert(staffMfaRecoveryCodesTable)
    .values(hashes.map((codeHash) => ({ staffId, codeHash })));
}

// Verify a recovery code and, if it matches an unused one, mark it consumed.
export async function consumeRecoveryCode(
  staffId: number,
  code: string,
): Promise<boolean> {
  const normalized = normalizeRecoveryCode(code);
  if (!normalized) return false;
  const rows = await db
    .select()
    .from(staffMfaRecoveryCodesTable)
    .where(
      and(
        eq(staffMfaRecoveryCodesTable.staffId, staffId),
        isNull(staffMfaRecoveryCodesTable.usedAt),
      ),
    );
  for (const row of rows) {
    if (await bcryptCompare(normalized, row.codeHash)) {
      await db
        .update(staffMfaRecoveryCodesTable)
        .set({ usedAt: new Date() })
        .where(eq(staffMfaRecoveryCodesTable.id, row.id));
      return true;
    }
  }
  return false;
}

export async function countUnusedRecoveryCodes(
  staffId: number,
): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(staffMfaRecoveryCodesTable)
    .where(
      and(
        eq(staffMfaRecoveryCodesTable.staffId, staffId),
        isNull(staffMfaRecoveryCodesTable.usedAt),
      ),
    );
  return rows[0]?.n ?? 0;
}
