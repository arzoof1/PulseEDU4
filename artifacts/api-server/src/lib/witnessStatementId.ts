import { and, eq, sql } from "drizzle-orm";
import {
  witnessStatementsTable,
  interactionCasesTable,
  type WitnessStatementRow,
} from "@workspace/db";
import { formatCaseNumber } from "./schoolYear.js";
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
