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
//
// Production runs with RUN_BOOT_SEED disabled, so the boot migrations do NOT
// auto-apply schema. To make this feature deploy-safe without a manual DB step,
// the chain columns are ensured lazily (ADD COLUMN IF NOT EXISTS) on first use,
// once per process. And if the chained write ever fails for any reason, we fall
// back to a plain (legacy, unchained) insert so audit logging can never
// regress — a missing audit row is a worse outcome than an unchained one.

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

let chainColumnsEnsured = false;

// Idempotent, once-per-process. Adds the hash-chain columns if the running DB
// predates 3.8. Cheap (metadata-only for nullable columns); the flag prevents
// repeat DDL on the hot path once it has succeeded.
export async function ensureAuthAuditChainColumns(): Promise<void> {
  if (chainColumnsEnsured) return;
  await db.execute(
    sql`ALTER TABLE auth_audit_log ADD COLUMN IF NOT EXISTS prev_hash TEXT`,
  );
  await db.execute(
    sql`ALTER TABLE auth_audit_log ADD COLUMN IF NOT EXISTS entry_hash TEXT`,
  );
  chainColumnsEnsured = true;
}

function baseValues(ev: AuthAuditEvent) {
  return {
    action: ev.action,
    schoolId: ev.schoolId ?? null,
    actorStaffId: ev.actorStaffId ?? null,
    actorName: ev.actorName ?? null,
    targetStaffId: ev.targetStaffId ?? null,
    ip: ev.ip ?? null,
    payload: ev.payload ?? {},
  };
}

export async function writeAuthAudit(ev: AuthAuditEvent): Promise<void> {
  try {
    await ensureAuthAuditChainColumns();
    await writeChainedRow(ev);
  } catch (err) {
    // Chain path failed (e.g. columns still absent, or a lock/DDL error).
    // Never lose the audit event: record it as a plain, unchained row.
    logger.error(
      { err, action: ev.action },
      "[authAudit] chained write failed; falling back to plain insert",
    );
    try {
      await db.insert(authAuditLogTable).values(baseValues(ev));
    } catch (err2) {
      logger.error(
        { err: err2, action: ev.action },
        "[authAudit] plain audit write also failed",
      );
    }
  }
}

async function writeChainedRow(ev: AuthAuditEvent): Promise<void> {
  await db.transaction(async (tx) => {
    // Serialize appends: two concurrent writers must not read the same
    // previous hash and fork the chain. Released automatically at tx end.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK})`);

    // Previous chained row's entry_hash. Legacy rows (pre-3.8, or written
    // during the fallback path) have NULL hashes and are skipped so the chain
    // anchors on the first hashed row.
    const prevRows = await tx
      .select({ entryHash: authAuditLogTable.entryHash })
      .from(authAuditLogTable)
      .where(isNotNull(authAuditLogTable.entryHash))
      .orderBy(desc(authAuditLogTable.id))
      .limit(1);
    const prevHash = prevRows[0]?.entryHash ?? GENESIS_HASH;

    const createdAt = new Date();
    const values = baseValues(ev);

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
}
