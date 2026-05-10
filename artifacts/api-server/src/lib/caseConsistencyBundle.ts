// Bundle assembler for the case AI consistency check (Phase 3).
//
// Pulls every textual source on a case — confirmed-tier video evidence
// (the GROUND TRUTH anchor), inferred/possible video for context,
// witness statements, interactions, case notes — and emits a single
// JSON document the model can reason over.
//
// Privacy guardrail (the most important thing in this file): every
// student name is replaced with a stable per-case alias ("Student A",
// "Student B", …) BEFORE the bundle leaves the server. The model never
// sees real names, DOB, address, parent contacts, ESE/504/ELL flags,
// program flags, or photos. The client re-hydrates real names from the
// existing case roster when rendering findings to the Core Team.
//
// The bundle is also canonicalised — fields ordered, alias map sorted —
// so identical inputs produce identical JSON ⇒ identical SHA-256 hash.
// The runner uses that hash to skip duplicate AI calls inside the
// debounce window.

import { createHash } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  db,
  interactionCasesTable,
  interactionCaseNotesTable,
  interactionsTable,
  interactionParticipantsTable,
  witnessStatementsTable,
  caseVideoEvidenceTable,
  caseVideoEvidencePlayersTable,
  studentsTable,
} from "@workspace/db";

type InteractionRow = typeof interactionsTable.$inferSelect;
type InteractionParticipantRow = typeof interactionParticipantsTable.$inferSelect;
type WitnessStatementRow = typeof witnessStatementsTable.$inferSelect;
type VideoClipRow = typeof caseVideoEvidenceTable.$inferSelect;
type VideoPlayerRow = typeof caseVideoEvidencePlayersTable.$inferSelect;
type CaseNoteRow = typeof interactionCaseNotesTable.$inferSelect;

// ----- public types ----------------------------------------------------

export type ConsistencySourceRef =
  | { kind: "witness_statement"; id: number }
  | { kind: "interaction"; id: number }
  | { kind: "video_clip"; id: number }
  | { kind: "case_note"; id: number };

export type ConsistencyBundleParticipant = {
  alias: string; // "Student A"
  initials: string; // "M.J." — surfaced to admins client-side; safe-ish for prompt
  internalId: string; // students.studentId — used by client to re-hydrate
};

export type ConsistencyBundle = {
  case: {
    id: number;
    number: number;
    title: string;
    status: string;
    openedAt: string;
  };
  participants: ConsistencyBundleParticipant[];
  // Confirmed-tier clips first — these are GROUND TRUTH for the model.
  groundTruthVideo: Array<{
    id: number;
    cameraLabel: string;
    timestampStart: string;
    timestampEnd: string | null;
    notes: string;
    confirmedPlayers: string[]; // aliases
  }>;
  contextVideo: Array<{
    id: number;
    cameraLabel: string;
    timestampStart: string;
    timestampEnd: string | null;
    notes: string;
    inferredPlayers: string[]; // aliases (inferred + possible)
    tier: "inferred" | "possible";
  }>;
  witnessStatements: Array<{
    id: number;
    authorAlias: string | null;
    completedAt: string | null;
    body: string; // alias-substituted
  }>;
  interactions: Array<{
    id: number;
    occurredAt: string;
    kind: string;
    severity: number;
    location: string;
    summary: string; // alias-substituted
    detail: string; // alias-substituted
    participantAliases: string[];
  }>;
  notes: Array<{
    id: number;
    createdAt: string;
    authorName: string; // staff name OK to send (not a student)
    body: string; // alias-substituted
  }>;
};

export type AssembleResult = {
  bundle: ConsistencyBundle;
  promptHash: string;
  // Map alias → internalId. Stays SERVER-side. Used to translate the
  // model's `cited_source_refs` (which only contain row ids, not
  // aliases) and is exposed to the client through the bundle's
  // `participants` array, NOT through this map directly.
  aliasMap: Map<string, string>;
};

// ----- helpers ---------------------------------------------------------

function aliasFor(idx: number): string {
  // A..Z, then AA..ZZ — schools rarely have >26 students on one case
  // but the case enhancement suite has to survive a 30-person bus
  // fight without the prompt collapsing.
  if (idx < 26) return `Student ${String.fromCharCode(65 + idx)}`;
  const hi = Math.floor(idx / 26) - 1;
  const lo = idx % 26;
  return `Student ${String.fromCharCode(65 + hi)}${String.fromCharCode(65 + lo)}`;
}

function initialsFor(name: string): string {
  // "Marcus Johnson" → "M.J." — admin-side helper kept here so the
  // bundle includes a human hint for the AI ("Student A (M.J.)") without
  // sending the full name. Limit to first + last initial; ignore
  // middle to dodge edge cases.
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return "?";
  if (parts.length === 1) return `${parts[0][0]!.toUpperCase()}.`;
  return `${parts[0][0]!.toUpperCase()}.${parts[parts.length - 1]![0]!.toUpperCase()}.`;
}

// Replace every occurrence of any real student name (and any
// reasonably-distinguishing first-name token) with the alias. We try
// longest-first so "Marcus Johnson" is replaced before "Marcus" alone.
function buildRedactor(
  realNameToAlias: Map<string, string>,
): (text: string) => string {
  // Build a single regex with all keys, longest first, case-insensitive,
  // word-bounded. Escape special chars defensively.
  const keys = Array.from(realNameToAlias.keys()).sort(
    (a, b) => b.length - a.length,
  );
  if (keys.length === 0) return (s) => s;
  const escaped = keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`\\b(${escaped.join("|")})\\b`, "gi");
  return (text: string) => {
    if (!text) return text;
    return text.replace(re, (m) => {
      // Match against the canonical lower-cased map key.
      const alias = realNameToAlias.get(m) ?? realNameToAlias.get(m.toLowerCase());
      return alias ?? m;
    });
  };
}

function canonicalStringify(value: unknown): string {
  // Stable JSON: sort object keys recursively so the same logical
  // bundle always produces the same byte sequence ⇒ same hash.
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`)
    .join(",")}}`;
}

// ----- main ------------------------------------------------------------

/**
 * Build the redacted, deterministic input bundle for a case.
 *
 * Throws if the case doesn't exist or is from a different school —
 * the caller is the route handler which has already resolved
 * `req.schoolId` from the auth context.
 */
export async function assembleCaseBundle(
  caseId: number,
  schoolId: number,
): Promise<AssembleResult> {
  // 1. Case meta
  const [caseRow] = await db
    .select()
    .from(interactionCasesTable)
    .where(
      and(
        eq(interactionCasesTable.id, caseId),
        eq(interactionCasesTable.schoolId, schoolId),
      ),
    )
    .limit(1);
  if (!caseRow) throw new Error(`case ${caseId} not found in school ${schoolId}`);

  // 2. Pull all participants by union of interactions + video evidence
  //    players + statements. Student order is "first appearance" — sort
  //    by (earliest interaction occurredAt, then student_id). This makes
  //    alias assignment stable across re-runs.
  const interactionsForCase: InteractionRow[] = await db
    .select()
    .from(interactionsTable)
    .where(
      and(
        eq(interactionsTable.schoolId, schoolId),
        eq(interactionsTable.caseId, caseId),
      ),
    )
    .orderBy(asc(interactionsTable.occurredAt));

  const interactionIds = interactionsForCase.map((i) => i.id);

  const partsRows: InteractionParticipantRow[] = interactionIds.length
    ? await db
        .select()
        .from(interactionParticipantsTable)
        .where(
          and(
            eq(interactionParticipantsTable.schoolId, schoolId),
            inArray(interactionParticipantsTable.interactionId, interactionIds),
          ),
        )
    : [];

  const stmtRows: WitnessStatementRow[] = interactionIds.length
    ? await db
        .select()
        .from(witnessStatementsTable)
        .where(
          and(
            eq(witnessStatementsTable.schoolId, schoolId),
            inArray(witnessStatementsTable.interactionId, interactionIds),
          ),
        )
        .orderBy(asc(witnessStatementsTable.requestedAt))
    : [];

  const videoClips: VideoClipRow[] = await db
    .select()
    .from(caseVideoEvidenceTable)
    .where(
      and(
        eq(caseVideoEvidenceTable.schoolId, schoolId),
        eq(caseVideoEvidenceTable.caseId, caseId),
      ),
    )
    .orderBy(asc(caseVideoEvidenceTable.timestampStart));

  const videoPlayerRows: VideoPlayerRow[] = await db
    .select()
    .from(caseVideoEvidencePlayersTable)
    .where(
      and(
        eq(caseVideoEvidencePlayersTable.schoolId, schoolId),
        eq(caseVideoEvidencePlayersTable.caseId, caseId),
      ),
    );

  const noteRows: CaseNoteRow[] = await db
    .select()
    .from(interactionCaseNotesTable)
    .where(
      and(
        eq(interactionCaseNotesTable.schoolId, schoolId),
        eq(interactionCaseNotesTable.caseId, caseId),
      ),
    )
    .orderBy(asc(interactionCaseNotesTable.createdAt));

  // 3. Resolve student names (one-shot lookup)
  const allStudentIds = new Set<string>();
  for (const p of partsRows) allStudentIds.add(p.studentId);
  for (const s of stmtRows) allStudentIds.add(s.studentId);
  for (const v of videoPlayerRows) allStudentIds.add(v.studentId);
  for (const i of interactionsForCase) {
    if (i.witnessStudentId) allStudentIds.add(i.witnessStudentId);
  }
  const studentRows = allStudentIds.size
    ? await db
        .select()
        .from(studentsTable)
        .where(
          and(
            eq(studentsTable.schoolId, schoolId),
            inArray(studentsTable.studentId, Array.from(allStudentIds)),
          ),
        )
    : [];
  const studentNameById = new Map(
    studentRows.map((s) => [
      s.studentId,
      `${s.firstName ?? ""} ${s.lastName ?? ""}`.trim(),
    ]),
  );

  // First-appearance ordering: walk interactions chronologically and
  // collect the participants in the order they show up.
  const orderedStudentIds: string[] = [];
  const seen = new Set<string>();
  const pushStudent = (sid: string | null | undefined) => {
    if (!sid || seen.has(sid)) return;
    seen.add(sid);
    orderedStudentIds.push(sid);
  };
  for (const i of interactionsForCase) {
    pushStudent(i.witnessStudentId);
    for (const p of partsRows.filter((pp) => pp.interactionId === i.id)) {
      pushStudent(p.studentId);
    }
  }
  for (const s of stmtRows) pushStudent(s.studentId);
  for (const v of videoPlayerRows) pushStudent(v.studentId);

  const aliasMap = new Map<string, string>(); // internalId -> alias
  const participants: ConsistencyBundleParticipant[] = orderedStudentIds.map(
    (sid, idx) => {
      const alias = aliasFor(idx);
      aliasMap.set(sid, alias);
      const realName = studentNameById.get(sid) ?? "";
      return {
        alias,
        initials: realName ? initialsFor(realName) : "?",
        internalId: sid,
      };
    },
  );

  // Redactor: real-name → alias, longest-first, case-insensitive.
  // Include both full names and first-name tokens (witness statements
  // often use first names only).
  const realToAlias = new Map<string, string>();
  for (const sid of orderedStudentIds) {
    const alias = aliasMap.get(sid)!;
    const full = studentNameById.get(sid)?.trim() ?? "";
    if (full) {
      realToAlias.set(full, alias);
      realToAlias.set(full.toLowerCase(), alias);
      const first = full.split(/\s+/)[0];
      // Two-letter first names ("Bo", "Ty", "Jo") are real and not
      // uncommon — the previous `>= 3` cutoff would have leaked them
      // through narrative free-text. We accept the very small risk
      // that a 2-letter common-word collision (e.g. "an", "in") could
      // be over-redacted in a witness statement; that's preferable to
      // a name leak to the model.
      if (first && first.length >= 2) {
        realToAlias.set(first, alias);
        realToAlias.set(first.toLowerCase(), alias);
      }
    }
  }
  const redact = buildRedactor(realToAlias);

  // 4. Project to bundle
  const playersByClip = new Map<
    number,
    Array<{ alias: string; tier: string }>
  >();
  for (const v of videoPlayerRows) {
    const alias = aliasMap.get(v.studentId);
    if (!alias) continue;
    const arr = playersByClip.get(v.evidenceId) ?? [];
    arr.push({ alias, tier: v.confidence });
    playersByClip.set(v.evidenceId, arr);
  }

  const groundTruthVideo: ConsistencyBundle["groundTruthVideo"] = [];
  const contextVideo: ConsistencyBundle["contextVideo"] = [];
  for (const c of videoClips) {
    const players = playersByClip.get(c.id) ?? [];
    const confirmed = players
      .filter((p) => p.tier === "confirmed")
      .map((p) => p.alias);
    const inferred = players
      .filter((p) => p.tier !== "confirmed")
      .map((p) => p.alias);
    if (confirmed.length > 0) {
      groundTruthVideo.push({
        id: c.id,
        cameraLabel: c.cameraLabel,
        timestampStart: c.timestampStart.toISOString(),
        timestampEnd: c.timestampEnd ? c.timestampEnd.toISOString() : null,
        notes: redact(c.notes ?? ""),
        confirmedPlayers: confirmed,
      });
    }
    if (inferred.length > 0) {
      // Tier label uses the *highest* of inferred/possible present.
      const tier = players.some((p) => p.tier === "inferred")
        ? "inferred"
        : "possible";
      contextVideo.push({
        id: c.id,
        cameraLabel: c.cameraLabel,
        timestampStart: c.timestampStart.toISOString(),
        timestampEnd: c.timestampEnd ? c.timestampEnd.toISOString() : null,
        notes: redact(c.notes ?? ""),
        inferredPlayers: inferred,
        tier: tier as "inferred" | "possible",
      });
    }
  }

  const bundle: ConsistencyBundle = {
    case: {
      id: caseRow.id,
      number: caseRow.caseNumber,
      title: redact(caseRow.title),
      status: caseRow.status,
      openedAt: caseRow.openedAt.toISOString(),
    },
    participants,
    groundTruthVideo,
    contextVideo,
    witnessStatements: stmtRows
      .filter((s) => (s.body ?? "").trim().length > 0)
      .map((s) => ({
        id: s.id,
        authorAlias: aliasMap.get(s.studentId) ?? null,
        completedAt: s.completedAt ? s.completedAt.toISOString() : null,
        body: redact(s.body),
      })),
    interactions: interactionsForCase.map((i) => ({
      id: i.id,
      occurredAt: i.occurredAt.toISOString(),
      kind: i.kind,
      severity: i.severity,
      location: i.location,
      summary: redact(i.summary ?? ""),
      detail: redact(i.detail ?? ""),
      participantAliases: partsRows
        .filter((p) => p.interactionId === i.id)
        .map((p) => aliasMap.get(p.studentId))
        .filter((a): a is string => Boolean(a)),
    })),
    notes: noteRows.map((n) => ({
      id: n.id,
      createdAt: n.createdAt.toISOString(),
      authorName: n.authorName,
      body: redact(n.body),
    })),
  };

  const promptHash = createHash("sha256")
    .update(canonicalStringify(bundle))
    .digest("hex");

  return { bundle, promptHash, aliasMap };
}
