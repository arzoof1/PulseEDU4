import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  caseMentionsTable,
  interactionsTable,
  witnessStatementsTable,
} from "@workspace/db";

// Token format embedded in free-text bodies:
//   @[Display Name|STUDENTID]
// The brackets and pipe are deliberate — neither shows up in normal
// dictation, so accidental collisions with prose are extremely unlikely.
// Display name may contain spaces but never `|` or `]` (the picker
// strips them).
const MENTION_RE = /@\[([^|\]]+)\|([A-Za-z0-9_-]+)\]/g;

export interface ParsedMention {
  studentId: string;
  displayNameAtTime: string;
  position: number;
}

// Pull every chip token out of a free-text body. Pure function — no DB.
// Position is the char offset of the leading `@` so the renderer / AI
// consistency check can show "the mention happened in this neighborhood".
export function parseMentions(body: string): ParsedMention[] {
  if (!body) return [];
  const out: ParsedMention[] = [];
  for (const m of body.matchAll(MENTION_RE)) {
    const display = (m[1] ?? "").trim().slice(0, 200);
    const sid = (m[2] ?? "").trim().slice(0, 60);
    if (!display || !sid) continue;
    out.push({
      displayNameAtTime: display,
      studentId: sid,
      position: m.index ?? 0,
    });
  }
  return out;
}

// Replace the index for a (sourceKind, sourceId) pair with the freshly
// parsed mentions. Idempotent — safe to call on every save / complete.
//
// We don't try to diff and patch; deleting and re-inserting is simpler,
// and the row counts per statement are tiny (rarely > 5). The body itself
// is the source of truth, so wiping the index never loses information.
export async function syncMentions(opts: {
  schoolId: number;
  sourceKind: "witness_statement" | "case_note" | "video_evidence_note";
  sourceId: number;
  caseId: number | null;
  body: string;
}) {
  await db
    .delete(caseMentionsTable)
    .where(
      and(
        eq(caseMentionsTable.schoolId, opts.schoolId),
        eq(caseMentionsTable.sourceKind, opts.sourceKind),
        eq(caseMentionsTable.sourceId, opts.sourceId),
      ),
    );
  const parsed = parseMentions(opts.body);
  if (parsed.length === 0) return;
  // Dedupe by studentId — multiple mentions of the same student in one
  // statement should still index once per occurrence (so position-based
  // neighborhood lookups work later), so we DO NOT dedupe here.
  await db.insert(caseMentionsTable).values(
    parsed.map((p) => ({
      schoolId: opts.schoolId,
      sourceKind: opts.sourceKind,
      sourceId: opts.sourceId,
      caseId: opts.caseId,
      studentId: p.studentId,
      displayNameAtTime: p.displayNameAtTime,
      position: p.position,
    })),
  );
}

// Re-point every existing mention row attached to an interaction's
// witness statements at a new case_id. Called when an interaction is
// attached to / detached from a case, or promoted to a brand new case —
// the canonical body text doesn't change, so we can avoid re-parsing
// and just patch the denormalised pointer in place.
export async function updateMentionCaseIdForInteraction(opts: {
  schoolId: number;
  interactionId: number;
  newCaseId: number | null;
}) {
  const stmts = await db
    .select({ id: witnessStatementsTable.id })
    .from(witnessStatementsTable)
    .where(
      and(
        eq(witnessStatementsTable.interactionId, opts.interactionId),
        eq(witnessStatementsTable.schoolId, opts.schoolId),
      ),
    );
  if (stmts.length === 0) return;
  const ids = stmts.map((s) => s.id);
  await db
    .update(caseMentionsTable)
    .set({ caseId: opts.newCaseId })
    .where(
      and(
        eq(caseMentionsTable.schoolId, opts.schoolId),
        eq(caseMentionsTable.sourceKind, "witness_statement"),
        inArray(caseMentionsTable.sourceId, ids),
      ),
    );
}

// Convenience for the witness-statement endpoints: look up the owning
// case from the statement → interaction chain and sync.
export async function syncWitnessStatementMentions(opts: {
  schoolId: number;
  statementId: number;
  body: string;
}) {
  const [stmt] = await db
    .select({ interactionId: witnessStatementsTable.interactionId })
    .from(witnessStatementsTable)
    .where(
      and(
        eq(witnessStatementsTable.id, opts.statementId),
        eq(witnessStatementsTable.schoolId, opts.schoolId),
      ),
    );
  if (!stmt) return;
  const [inter] = await db
    .select({ caseId: interactionsTable.caseId })
    .from(interactionsTable)
    .where(
      and(
        eq(interactionsTable.id, stmt.interactionId),
        eq(interactionsTable.schoolId, opts.schoolId),
      ),
    );
  await syncMentions({
    schoolId: opts.schoolId,
    sourceKind: "witness_statement",
    sourceId: opts.statementId,
    caseId: inter?.caseId ?? null,
    body: opts.body,
  });
}

