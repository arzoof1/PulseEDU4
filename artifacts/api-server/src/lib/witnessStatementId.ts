import { and, eq, sql } from "drizzle-orm";
import {
  db,
  witnessStatementsTable,
  interactionsTable,
  interactionCasesTable,
  type WitnessStatementRow,
} from "@workspace/db";
import { formatCaseNumber } from "./schoolYear.js";
import { logger } from "./logger.js";
import type { db as DbType } from "@workspace/db";

// CASE-26-27-0042-WS-03. Per-case sequence rather than a global
// counter (admins look up by case first, and a global counter just
// duplicates the cross-reference work the case number already does).
export function formatWitnessStatementId(args: {
  schoolYearLabel: string;
  caseNumber: number;
  wsSeq: number;
}): string {
  const caseId = formatCaseNumber({
    schoolYearLabel: args.schoolYearLabel,
    caseNumber: args.caseNumber,
  });
  return `CASE-${caseId}-WS-${String(args.wsSeq).padStart(2, "0")}`;
}

// Assign `ws_seq` to every witness_statements row owned by `interactionId`
// that doesn't yet have one, sequentially after the case's current MAX.
// Idempotent: rows that already have a wsSeq are left untouched.
// Must be called inside a transaction — locks the case row FOR UPDATE
// so two concurrent attaches against the same case can't collide.
export async function assignWitnessSeqForInteraction(
  tx: Parameters<Parameters<typeof DbType.transaction>[0]>[0],
  args: { schoolId: number; caseId: number; interactionId: number },
): Promise<void> {
  // 1. Lock the case row. Two concurrent promote/attach operations
  //    against the same case will serialize on this row.
  await tx.execute(sql`
    SELECT id FROM interaction_cases
     WHERE id = ${args.caseId} AND school_id = ${args.schoolId}
     FOR UPDATE
  `);

  // 2. Current high-water mark for ws_seq within this case.
  const { rows } = await tx.execute(sql`
    SELECT COALESCE(MAX(ws_seq), 0) AS "max"
      FROM witness_statements
     WHERE school_id = ${args.schoolId}
       AND interaction_id IN (
         SELECT id FROM interactions
          WHERE case_id = ${args.caseId}
            AND school_id = ${args.schoolId}
       )
  `);
  let next = Number((rows[0] as { max: number | string } | undefined)?.max ?? 0);

  // 3. Pull this interaction's un-numbered statements, oldest first,
  //    and assign sequential numbers.
  const toAssign = await tx
    .select({ id: witnessStatementsTable.id })
    .from(witnessStatementsTable)
    .where(
      and(
        eq(witnessStatementsTable.schoolId, args.schoolId),
        eq(witnessStatementsTable.interactionId, args.interactionId),
        sql`${witnessStatementsTable.wsSeq} IS NULL`,
      ),
    )
    .orderBy(witnessStatementsTable.requestedAt);

  for (const r of toAssign) {
    next += 1;
    await tx
      .update(witnessStatementsTable)
      .set({ wsSeq: next })
      .where(eq(witnessStatementsTable.id, r.id));
  }
}

// Convenience: enrich a witness statement row with its formatted ID,
// looking up the owning case if it has been promoted. Returns the
// row plus a `formattedId` field (null if statement hasn't been
// attached to a case yet).
export type WitnessStatementWithFormattedId = WitnessStatementRow & {
  formattedId: string | null;
};

// Look up the formatted CASE-XX-WS-NN id for a single statement.
// Returns null when the statement is unattached, has no ws_seq, or
// the owning case can't be resolved — callers should treat null as
// "no surfaceable id yet" and render a generic label instead.
// Used by route handlers building audit payloads and response rows.
export async function formattedIdForStatement(args: {
  schoolId: number;
  interactionId: number;
  wsSeq: number | null;
}): Promise<string | null> {
  if (args.wsSeq == null) return null;
  const [row] = await db
    .select({
      caseNumber: interactionCasesTable.caseNumber,
      schoolYearLabel: interactionCasesTable.schoolYearLabel,
    })
    .from(interactionsTable)
    .innerJoin(
      interactionCasesTable,
      and(
        eq(interactionCasesTable.id, interactionsTable.caseId),
        eq(interactionCasesTable.schoolId, args.schoolId),
      ),
    )
    .where(
      and(
        eq(interactionsTable.id, args.interactionId),
        eq(interactionsTable.schoolId, args.schoolId),
      ),
    );
  if (!row?.caseNumber || !row?.schoolYearLabel) return null;
  return formatWitnessStatementId({
    schoolYearLabel: row.schoolYearLabel,
    caseNumber: row.caseNumber,
    wsSeq: args.wsSeq,
  });
}

// Batch-fetch formatted ids for a list of statements by their owning
// interactions. Returns a Map keyed by statementId. Single query
// instead of N round-trips; called by the list/detail endpoints that
// hydrate many statements at once.
export async function formattedIdsForStatements(args: {
  schoolId: number;
  statements: Array<{ id: number; interactionId: number; wsSeq: number | null }>;
}): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const eligible = args.statements.filter((s) => s.wsSeq != null);
  if (eligible.length === 0) return out;
  const ids = [...new Set(eligible.map((s) => s.interactionId))];
  const rows = await db
    .select({
      interactionId: interactionsTable.id,
      caseNumber: interactionCasesTable.caseNumber,
      schoolYearLabel: interactionCasesTable.schoolYearLabel,
    })
    .from(interactionsTable)
    .innerJoin(
      interactionCasesTable,
      and(
        eq(interactionCasesTable.id, interactionsTable.caseId),
        eq(interactionCasesTable.schoolId, args.schoolId),
      ),
    )
    .where(
      and(
        eq(interactionsTable.schoolId, args.schoolId),
        sql`${interactionsTable.id} = ANY(${ids})`,
      ),
    );
  const caseByInteraction = new Map<
    number,
    { caseNumber: number; schoolYearLabel: string }
  >();
  for (const r of rows) {
    if (r.caseNumber != null && r.schoolYearLabel) {
      caseByInteraction.set(r.interactionId, {
        caseNumber: r.caseNumber,
        schoolYearLabel: r.schoolYearLabel,
      });
    }
  }
  for (const s of eligible) {
    const c = caseByInteraction.get(s.interactionId);
    if (!c) continue;
    out.set(
      s.id,
      formatWitnessStatementId({
        schoolYearLabel: c.schoolYearLabel,
        caseNumber: c.caseNumber,
        wsSeq: s.wsSeq!,
      }),
    );
  }
  return out;
}

// One-shot backfill: every promoted-to-case witness statement that
// hasn't been numbered yet gets a sequential ws_seq, ordered by
// `requestedAt` per case. Called once during server boot — idempotent,
// so a second call is a no-op. Statements still attached to dismissed
// or detached interactions are skipped (no caseId, no number).
export async function backfillWitnessSequences(): Promise<{
  cases: number;
  statements: number;
}> {
  // Find every (school, case) that has at least one NULL ws_seq
  // statement attached. Limits the work to cases that actually need
  // backfill — typical post-boot result is `{cases: 0, statements: 0}`.
  const targets = await db
    .select({
      schoolId: interactionsTable.schoolId,
      caseId: interactionsTable.caseId,
    })
    .from(witnessStatementsTable)
    .innerJoin(
      interactionsTable,
      and(
        eq(interactionsTable.id, witnessStatementsTable.interactionId),
        eq(interactionsTable.schoolId, witnessStatementsTable.schoolId),
      ),
    )
    .where(
      and(
        sql`${witnessStatementsTable.wsSeq} IS NULL`,
        sql`${interactionsTable.caseId} IS NOT NULL`,
      ),
    )
    .groupBy(interactionsTable.schoolId, interactionsTable.caseId);

  let stmtCount = 0;
  for (const t of targets) {
    if (t.caseId == null) continue;
    // For each case, iterate its interactions oldest-first and
    // assign — `assignWitnessSeqForInteraction` is per-interaction
    // but the helper preserves the case-level monotonic count.
    const interactions = await db
      .select({ id: interactionsTable.id })
      .from(interactionsTable)
      .where(
        and(
          eq(interactionsTable.schoolId, t.schoolId),
          eq(interactionsTable.caseId, t.caseId),
        ),
      )
      .orderBy(interactionsTable.createdAt);
    for (const inter of interactions) {
      try {
        await db.transaction(async (tx) => {
          await assignWitnessSeqForInteraction(tx, {
            schoolId: t.schoolId,
            caseId: t.caseId!,
            interactionId: inter.id,
          });
        });
        stmtCount += 1;
      } catch (err) {
        logger.warn(
          { err, schoolId: t.schoolId, caseId: t.caseId, interactionId: inter.id },
          "witness ws_seq backfill failed for interaction",
        );
      }
    }
  }
  return { cases: targets.length, statements: stmtCount };
}
