import { db, authAuditLogTable } from "@workspace/db";
import { desc, eq, isNotNull, sql } from "drizzle-orm";
import { logger } from "./logger.js";
import {
  GENESIS_HASH,
  computeEntryHash,
  type AuditChainRecord,
} from "./authAuditChain.js";

// Best-effort writer for the authentication / privileged-identity audit trail
// (Gate A / items 2.5, 3.6). Never throws into the caller: an audit-write
// failure is logged but must not break the security action it records.
//
// Section 3.8: every row is linked into an append-only, tamper-evident hash
// chain (prev_hash -> entry_hash). Writes are serialized with a transaction-
// scoped advisory lock so concurrent appends cannot fork the chain. The chain
// math lives in authAuditChain.ts (pure + unit-tested); this module only wires
// it to the database.

export type AuthAuditEvent = {
  action: string;
  schoolId?: number | null;
  actorStaffId?: number | null;
  actorName?: string | null;
  targetStaffId?: number | null;
  ip?: string | null;
  payload?: Record<string, unknown>;
};

// Arbitrary stable key for pg_advisory_xact_lock — serializes audit appends.
const AUDIT_CHAIN_LOCK = 0x41554449; // "AUDI"

export async function writeAuthAudit(ev: AuthAuditEvent): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      // Serialize appends: two concurrent writers must not read the same
      // previous hash and fork the chain. Released automatically at tx end.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK})`);

      // Previous chained row's entry_hash. Legacy rows (pre-3.8) have NULL
      // hashes and are skipped so the chain anchors on the first hashed row.
      const prevRows = await tx
        .select({ entryHash: authAuditLogTable.entryHash })
        .from(authAuditLogTable)
        .where(isNotNull(authAuditLogTable.entryHash))
        .orderBy(desc(authAuditLogTable.id))
        .limit(1);
      const prevHash = prevRows[0]?.entryHash ?? GENESIS_HASH;

      const createdAt = new Date();
      const values = {
        action: ev.action,
        schoolId: ev.schoolId ?? null,
        actorStaffId: ev.actorStaffId ?? null,
        actorName: ev.actorName ?? null,
        targetStaffId: ev.targetStaffId ?? null,
        ip: ev.ip ?? null,
        payload: ev.payload ?? {},
      };

      // Insert first to get the DB-assigned id, then commit the hash over the
      // full immutable content (id + createdAt included) in the same tx.
      const inserted = await tx
        .insert(authAuditLogTable)
        .values({ ...values, createdAt, prevHash })
        .returning({ id: authAuditLogTable.id });
      const id = inserted[0].id;

      const record: AuditChainRecord = {
        id,
        schoolId: values.schoolId,
        action: values.action,
        actorStaffId: values.actorStaffId,
        actorName: values.actorName,
        targetStaffId: values.targetStaffId,
        ip: values.ip,
        payload: values.payload,
        createdAtISO: createdAt.toISOString(),
      };
      const entryHash = computeEntryHash(prevHash, record);

      await tx
        .update(authAuditLogTable)
        .set({ entryHash })
        .where(eq(authAuditLogTable.id, id));
    });
  } catch (err) {
    logger.error(
      { err, action: ev.action },
      "[authAudit] failed to write audit row",
    );
  }
}
