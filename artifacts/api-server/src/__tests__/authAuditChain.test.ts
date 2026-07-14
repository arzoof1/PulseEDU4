import { describe, it, expect } from "vitest";
import {
  GENESIS_HASH,
  canonicalize,
  computeEntryHash,
  verifyChain,
  type AuditChainRecord,
  type ChainRow,
} from "../lib/authAuditChain.js";

// Tamper-evidence hash chain for the auth audit log (Section 3.8). Pure — no DB.

function rec(id: number, over: Partial<AuditChainRecord> = {}): AuditChainRecord {
  return {
    id,
    schoolId: 1,
    action: "role_changed",
    actorStaffId: 10,
    actorName: "Admin",
    targetStaffId: 20,
    ip: "1.2.3.4",
    payload: { changesSummary: "isAdmin: off->on" },
    createdAtISO: `2026-07-14T10:0${id}:00.000Z`,
    ...over,
  };
}

// Build a valid chain from a list of records, exactly as the writer would.
function buildChain(records: AuditChainRecord[]): ChainRow[] {
  const rows: ChainRow[] = [];
  let prev: string = GENESIS_HASH;
  for (const r of records) {
    const entryHash = computeEntryHash(prev, r);
    rows.push({ ...r, prevHash: prev, entryHash });
    prev = entryHash;
  }
  return rows;
}

describe("canonicalize", () => {
  it("is stable regardless of key order in the payload", () => {
    const a = canonicalize({ b: 1, a: { d: 4, c: 3 } });
    const b = canonicalize({ a: { c: 3, d: 4 }, b: 1 });
    expect(a).toBe(b);
  });
});

describe("computeEntryHash", () => {
  it("is deterministic and sensitive to prevHash", () => {
    const r = rec(1);
    expect(computeEntryHash(GENESIS_HASH, r)).toBe(
      computeEntryHash(GENESIS_HASH, r),
    );
    expect(computeEntryHash(GENESIS_HASH, r)).not.toBe(
      computeEntryHash("other", r),
    );
  });
});

describe("verifyChain", () => {
  it("accepts a well-formed chain", () => {
    const rows = buildChain([rec(1), rec(2), rec(3)]);
    const res = verifyChain(rows);
    expect(res.ok).toBe(true);
    expect(res.checkedCount).toBe(3);
    expect(res.legacyCount).toBe(0);
    expect(res.brokenAtId).toBeNull();
  });

  it("verifies regardless of input row order (sorts by id)", () => {
    const rows = buildChain([rec(1), rec(2), rec(3)]);
    const res = verifyChain([rows[2], rows[0], rows[1]]);
    expect(res.ok).toBe(true);
  });

  it("detects an altered row (content no longer matches entry_hash)", () => {
    const rows = buildChain([rec(1), rec(2), rec(3)]);
    // Tamper with row 2's payload but keep its stored hash.
    rows[1] = { ...rows[1], ip: "9.9.9.9" };
    const res = verifyChain(rows);
    expect(res.ok).toBe(false);
    expect(res.brokenAtId).toBe(2);
  });

  it("detects a deleted middle row (prev_hash linkage breaks)", () => {
    const rows = buildChain([rec(1), rec(2), rec(3)]);
    const res = verifyChain([rows[0], rows[2]]); // drop row 2
    expect(res.ok).toBe(false);
    expect(res.brokenAtId).toBe(3);
  });

  it("counts legacy (unhashed) rows and still verifies the hashed tail", () => {
    const chained = buildChain([rec(2), rec(3)]);
    const legacy: ChainRow = { ...rec(1), prevHash: null, entryHash: null };
    const res = verifyChain([legacy, ...chained]);
    expect(res.ok).toBe(true);
    expect(res.legacyCount).toBe(1);
    expect(res.checkedCount).toBe(2);
  });

  it("treats an empty log as intact", () => {
    expect(verifyChain([]).ok).toBe(true);
  });
});
