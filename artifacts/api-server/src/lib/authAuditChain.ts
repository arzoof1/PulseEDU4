import { createHash } from "node:crypto";

// Tamper-evidence for the authentication audit trail (Section 3.8). Every
// auth_audit_log row is linked into an append-only hash chain: each row stores
// the hash of the row before it (prev_hash) and a hash of its own canonical
// content chained onto that (entry_hash). Deleting, reordering, or editing any
// row breaks the chain at that point, which verifyChain() detects and pinpoints.
//
// This module is intentionally pure (node:crypto only, no DB import) so the
// chain math is unit-tested without a DATABASE_URL — same split used by
// geoAnomalyMath.ts / privilegedReauthWindow.ts.

// Anchor for the very first chained row. Any fixed, well-known string works;
// it just has to be stable so verification and writing agree on the origin.
export const GENESIS_HASH = "GENESIS";

// The immutable content of an audit row that the hash commits to. id and
// created_at are included so a row cannot be silently renumbered or back-dated.
export type AuditChainRecord = {
  id: number;
  schoolId: number | null;
  action: string;
  actorStaffId: number | null;
  actorName: string | null;
  targetStaffId: number | null;
  ip: string | null;
  payload: unknown;
  createdAtISO: string;
};

// Deterministic serialization: object keys sorted recursively so two equal
// records always produce byte-identical input regardless of key insertion
// order (JSON.stringify otherwise preserves insertion order, which the DB
// round-trip does not guarantee for jsonb payloads).
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

// entry_hash = sha256(prevHash + "\n" + canonical(record)).
export function computeEntryHash(
  prevHash: string,
  record: AuditChainRecord,
): string {
  return createHash("sha256")
    .update(prevHash)
    .update("\n")
    .update(canonicalize(record))
    .digest("hex");
}

export type ChainRow = AuditChainRecord & {
  prevHash: string | null;
  entryHash: string | null;
};

export type ChainVerifyResult = {
  ok: boolean;
  // Number of hash-chained rows actually verified.
  checkedCount: number;
  // Rows written before 3.8 shipped carry no hash; reported, not an error.
  legacyCount: number;
  // First row id where the chain fails to verify, or null when intact.
  brokenAtId: number | null;
  reason: string | null;
};

// Walk rows in ascending id order and confirm the hash chain is intact.
// Legacy rows (entry_hash IS NULL, written before this feature) are counted
// and skipped; the chain is verified from the first hashed row onward.
export function verifyChain(rows: ChainRow[]): ChainVerifyResult {
  const ordered = [...rows].sort((a, b) => a.id - b.id);
  let prev: string | null = null; // entry_hash of the previous chained row
  let checked = 0;
  let legacy = 0;

  for (const row of ordered) {
    if (row.entryHash == null) {
      legacy++;
      continue;
    }
    const expectedPrev = prev ?? GENESIS_HASH;
    if ((row.prevHash ?? GENESIS_HASH) !== expectedPrev) {
      return {
        ok: false,
        checkedCount: checked,
        legacyCount: legacy,
        brokenAtId: row.id,
        reason: "prev_hash does not match the previous row's entry_hash",
      };
    }
    const recomputed = computeEntryHash(expectedPrev, chainRecord(row));
    if (recomputed !== row.entryHash) {
      return {
        ok: false,
        checkedCount: checked,
        legacyCount: legacy,
        brokenAtId: row.id,
        reason: "entry_hash does not match the row's content (row was altered)",
      };
    }
    prev = row.entryHash;
    checked++;
  }

  return {
    ok: true,
    checkedCount: checked,
    legacyCount: legacy,
    brokenAtId: null,
    reason: null,
  };
}

function chainRecord(row: ChainRow): AuditChainRecord {
  return {
    id: row.id,
    schoolId: row.schoolId,
    action: row.action,
    actorStaffId: row.actorStaffId,
    actorName: row.actorName,
    targetStaffId: row.targetStaffId,
    ip: row.ip,
    payload: row.payload,
    createdAtISO: row.createdAtISO,
  };
}
