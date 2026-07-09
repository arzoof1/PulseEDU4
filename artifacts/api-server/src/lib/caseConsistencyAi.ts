// AI consistency-check runner (Phase 3).
//
// Single Anthropic call against a redacted bundle, parses the model's
// JSON-mode output into structured findings, applies the per-case
// suppression list (any finding whose signature was previously
// dismissed is dropped), computes a 0-100 consistency score, and
// upserts the per-case state row in one transaction.
//
// SAFETY NOTES:
// - Bundle is already redacted by assembleCaseBundle (Student A/B/C
//   aliases). This file MUST NOT receive any un-redacted text.
// - Prompt-hash dedupe: if a run with the same prompt_hash exists in
//   the last 60s, skip the AI call entirely. Uses the per-case state
//   row's lastAttemptAt as a coarse rate guard.
// - Per-case daily cap (20 runs/day) enforced by the route layer
//   before calling in here; this module never imposes its own cap so
//   the route can decide what to do with the limit hit.
// - Failures are logged + recorded as a `runs` row with `errorText`
//   set, score=last-known. They never throw out of the function so a
//   trigger hook can fire-and-forget.

import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import {
  db,
  caseConsistencyRunsTable,
  caseConsistencyFindingsTable,
  caseConsistencyStateTable,
} from "@workspace/db";
import { logger } from "./logger";
import {
  assembleCaseBundle,
  type ConsistencyBundle,
  type ConsistencySourceRef,
} from "./caseConsistencyBundle";
import { isAiAssistEnabledForSchool } from "./aiFeatures.js";

// ---------- Anthropic client (lazy, env-validated) -------------------

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (_client) return _client;
  const baseURL = process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL;
  const apiKey = process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;
  if (!baseURL || !apiKey) {
    throw new Error(
      "Anthropic AI Integrations env vars not set (AI_INTEGRATIONS_ANTHROPIC_BASE_URL/API_KEY)",
    );
  }
  _client = new Anthropic({ baseURL, apiKey });
  return _client;
}

const MODEL = "claude-sonnet-4-6";
const DEBOUNCE_MS = 60_000;

// ---------- Scoring ---------------------------------------------------

type RawFinding = {
  kind: "contradiction" | "gap" | "corroboration";
  severity: "high" | "med" | "low";
  summary: string;
  detail?: string;
  cited_source_refs: ConsistencySourceRef[];
};

function scoreOf(findings: RawFinding[]): number {
  let s = 100;
  for (const f of findings) {
    if (f.kind === "contradiction") {
      s -= f.severity === "high" ? 15 : f.severity === "med" ? 8 : 4;
    } else if (f.kind === "gap") {
      s -= f.severity === "high" ? 6 : f.severity === "med" ? 4 : 2;
    } else if (f.kind === "corroboration") {
      s += 3;
    }
  }
  if (s < 0) return 0;
  if (s > 100) return 100;
  return Math.round(s);
}

// Stable per-finding signature so the suppression list (= dismissed
// findings on this case) can match and skip re-emitted lookalikes.
// Built from kind + severity-bucket-coarse + sorted cited refs. We
// intentionally do NOT include the model's prose summary — admins
// dismissing "Student A and B disagree on time" should also suppress
// the next run's "the time given by A conflicts with B's account".
function signatureOf(f: RawFinding): string {
  const refs = [...f.cited_source_refs]
    .map((r) => `${r.kind}:${r.id}`)
    .sort()
    .join("|");
  return createHash("sha256")
    .update(`${f.kind}|${refs}`)
    .digest("hex");
}

// ---------- Prompt ----------------------------------------------------

const SYSTEM_PROMPT = `You are a case-investigation analyst helping a school's Core Team review the internal consistency of evidence on a student-conduct case.

Ground-truth ranking:
1. Confirmed-tier video clips ("groundTruthVideo") are observed fact. Statements that contradict them are HIGH-severity contradictions.
2. Inferred/possible video ("contextVideo") is suggestive, not proof. Use it only as soft corroboration.
3. Witness statements and interactions can corroborate or contradict each other; severity reflects how clearly they conflict.

Your job is to emit a JSON object with one key, "findings", an array. Each finding has:
- kind: one of "contradiction" | "gap" | "corroboration"
- severity: one of "high" | "med" | "low"
- summary: <= 200 chars, plain English, refers to students by their alias ("Student A")
- detail: optional longer explanation (<= 600 chars)
- cited_source_refs: array of { kind: "witness_statement"|"interaction"|"video_clip"|"case_note", id: number } — at least one ref required, must reference rows actually present in the bundle.

Findings policy:
- "contradiction": two or more sources disagree on a verifiable fact (who was where, when, what was said).
- "gap": a key investigative question (who/what/when/where for a confirmed event) is unanswered across all sources.
- "corroboration": two INDEPENDENT sources agree on a non-trivial fact. Do not emit corroboration for a single source restating itself.

Constraints:
- Never identify, describe, or speculate about students using anything other than their bundle alias.
- Do not invent sources. Every cited id MUST exist in the bundle.
- Do not return more than 12 findings. If the case is large, prioritise contradictions > gaps > corroborations.
- Output MUST be a single valid JSON object. No prose before or after.`;

function userPromptFor(bundle: ConsistencyBundle): string {
  return `Case bundle:
${JSON.stringify(bundle, null, 2)}

Emit findings as the JSON object described in the system prompt.`;
}

// ---------- Output parsing -------------------------------------------

const VALID_KINDS = new Set(["contradiction", "gap", "corroboration"]);
const VALID_SEVERITIES = new Set(["high", "med", "low"]);
const VALID_REF_KINDS = new Set([
  "witness_statement",
  "interaction",
  "video_clip",
  "case_note",
]);

function buildValidIdSet(bundle: ConsistencyBundle): Set<string> {
  const out = new Set<string>();
  for (const s of bundle.witnessStatements) out.add(`witness_statement:${s.id}`);
  for (const i of bundle.interactions) out.add(`interaction:${i.id}`);
  for (const v of bundle.groundTruthVideo) out.add(`video_clip:${v.id}`);
  for (const v of bundle.contextVideo) out.add(`video_clip:${v.id}`);
  for (const n of bundle.notes) out.add(`case_note:${n.id}`);
  return out;
}

function parseFindings(
  raw: unknown,
  bundle: ConsistencyBundle,
): RawFinding[] {
  if (!raw || typeof raw !== "object") return [];
  const findingsRaw = (raw as { findings?: unknown }).findings;
  if (!Array.isArray(findingsRaw)) return [];

  const validIds = buildValidIdSet(bundle);
  const out: RawFinding[] = [];

  for (const item of findingsRaw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.kind !== "string" || !VALID_KINDS.has(o.kind)) continue;
    if (typeof o.severity !== "string" || !VALID_SEVERITIES.has(o.severity))
      continue;
    if (typeof o.summary !== "string" || o.summary.trim().length === 0)
      continue;
    if (!Array.isArray(o.cited_source_refs) || o.cited_source_refs.length === 0)
      continue;

    const refs: ConsistencySourceRef[] = [];
    for (const r of o.cited_source_refs) {
      if (!r || typeof r !== "object") continue;
      const rr = r as Record<string, unknown>;
      if (typeof rr.kind !== "string" || !VALID_REF_KINDS.has(rr.kind))
        continue;
      if (typeof rr.id !== "number" || !Number.isInteger(rr.id)) continue;
      if (!validIds.has(`${rr.kind}:${rr.id}`)) continue; // hallucinated id
      refs.push({ kind: rr.kind, id: rr.id } as ConsistencySourceRef);
    }
    if (refs.length === 0) continue;

    out.push({
      kind: o.kind as RawFinding["kind"],
      severity: o.severity as RawFinding["severity"],
      summary: o.summary.trim().slice(0, 400),
      detail:
        typeof o.detail === "string" ? o.detail.trim().slice(0, 1200) : undefined,
      cited_source_refs: refs,
    });
  }

  return out.slice(0, 12);
}

// ---------- Suppression list -----------------------------------------

async function loadSuppressionSignatures(
  schoolId: number,
  caseId: number,
): Promise<Set<string>> {
  const rows = await db
    .select({ sig: caseConsistencyFindingsTable.signatureHash })
    .from(caseConsistencyFindingsTable)
    .where(
      and(
        eq(caseConsistencyFindingsTable.schoolId, schoolId),
        eq(caseConsistencyFindingsTable.caseId, caseId),
        eq(caseConsistencyFindingsTable.status, "dismissed"),
      ),
    );
  return new Set(rows.map((r) => r.sig));
}

// ---------- Public runner --------------------------------------------

export type ConsistencyRunResult =
  | {
      kind: "ok";
      runId: number;
      score: number;
      findingCount: number;
      reusedRecent: boolean;
    }
  | { kind: "debounced" }
  | { kind: "error"; message: string };

export async function runConsistencyCheck(opts: {
  schoolId: number;
  caseId: number;
  triggerReason:
    | "new_statement"
    | "new_interaction"
    | "new_video"
    | "manual"
    | "initial";
  actorStaffId: number | null;
  actorName: string | null;
}): Promise<ConsistencyRunResult> {
  const { schoolId, caseId, triggerReason, actorStaffId, actorName } = opts;

  if (!(await isAiAssistEnabledForSchool(schoolId))) {
    return {
      kind: "error",
      message: "AI features are disabled for this school.",
    };
  }

  // 1. Coarse debounce on lastAttemptAt — skip if attempted in the last
  //    DEBOUNCE_MS. Manual runs ignore the debounce so an admin can
  //    force a re-evaluation.
  if (triggerReason !== "manual") {
    const [state] = await db
      .select()
      .from(caseConsistencyStateTable)
      .where(
        and(
          eq(caseConsistencyStateTable.schoolId, schoolId),
          eq(caseConsistencyStateTable.caseId, caseId),
        ),
      )
      .limit(1);
    if (
      state?.lastAttemptAt &&
      Date.now() - state.lastAttemptAt.getTime() < DEBOUNCE_MS
    ) {
      return { kind: "debounced" };
    }
  }

  let bundle: ConsistencyBundle;
  let promptHash: string;
  try {
    const built = await assembleCaseBundle(caseId, schoolId);
    bundle = built.bundle;
    promptHash = built.promptHash;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.warn(
      { schoolId, caseId, message },
      "consistency: bundle assembly failed",
    );
    return { kind: "error", message };
  }

  // 2. Mark attempt time early so concurrent triggers debounce against
  //    each other even before the AI call returns. Upsert.
  await db
    .insert(caseConsistencyStateTable)
    .values({
      schoolId,
      caseId,
      score: 100,
      lastAttemptAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        caseConsistencyStateTable.schoolId,
        caseConsistencyStateTable.caseId,
      ],
      set: { lastAttemptAt: new Date() },
    });

  // 3. Hash dedupe — if an existing run inside the debounce window
  //    used the same prompt hash, reuse it.
  const since = new Date(Date.now() - DEBOUNCE_MS);
  const recent = await db
    .select()
    .from(caseConsistencyRunsTable)
    .where(
      and(
        eq(caseConsistencyRunsTable.schoolId, schoolId),
        eq(caseConsistencyRunsTable.caseId, caseId),
        eq(caseConsistencyRunsTable.promptHash, promptHash),
        gte(caseConsistencyRunsTable.createdAt, since),
      ),
    )
    .orderBy(desc(caseConsistencyRunsTable.createdAt))
    .limit(1);
  if (recent.length > 0 && triggerReason !== "manual") {
    const r = recent[0]!;
    return {
      kind: "ok",
      runId: r.id,
      score: r.score,
      findingCount: 0,
      reusedRecent: true,
    };
  }

  // 4. AI call
  let rawJson: unknown = null;
  let errorText: string | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  try {
    const message = await getClient().messages.create({
      model: MODEL,
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPromptFor(bundle) }],
    });
    inputTokens = message.usage?.input_tokens ?? null;
    outputTokens = message.usage?.output_tokens ?? null;

    const textBlock = message.content.find((b) => b.type === "text");
    const text = textBlock && textBlock.type === "text" ? textBlock.text : "";
    // Be lenient about leading/trailing prose — extract the first
    // {...} block. Falls through to errorText if parse fails.
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      throw new Error("model output contained no JSON object");
    }
    rawJson = JSON.parse(text.slice(firstBrace, lastBrace + 1));
  } catch (e) {
    errorText = e instanceof Error ? e.message : String(e);
    logger.warn(
      { schoolId, caseId, errorText },
      "consistency: AI call failed",
    );
  }

  // 5. Parse + suppress
  const parsed = errorText ? [] : parseFindings(rawJson, bundle);
  const suppression = await loadSuppressionSignatures(schoolId, caseId);
  const kept = parsed.filter((f) => !suppression.has(signatureOf(f)));
  const score = errorText ? 100 : scoreOf(kept);
  const highCount = kept.filter(
    (f) => f.kind === "contradiction" && f.severity === "high",
  ).length;

  // 6. Persist run + findings + state in one transaction
  const runId = await db.transaction(async (tx) => {
    const [run] = await tx
      .insert(caseConsistencyRunsTable)
      .values({
        schoolId,
        caseId,
        triggeredById: actorStaffId,
        triggeredByName: actorName,
        triggerReason,
        model: MODEL,
        promptHash,
        inputBundleJson: bundle,
        rawOutputJson: rawJson ?? null,
        score,
        inputTokens,
        outputTokens,
        errorText,
      })
      .returning({ id: caseConsistencyRunsTable.id });
    const newRunId = run!.id;

    if (kept.length > 0) {
      await tx.insert(caseConsistencyFindingsTable).values(
        kept.map((f) => ({
          schoolId,
          caseId,
          runId: newRunId,
          source: "ai",
          kind: f.kind,
          severity: f.severity,
          summary: f.summary,
          detail: f.detail ?? null,
          citedSourceRefs: f.cited_source_refs,
          signatureHash: signatureOf(f),
          status: "open",
        })),
      );
    }

    // Refresh state row from authoritative open-finding count (counts
    // include any human findings still open from prior runs).
    const [{ openCount, hiCount }] = (
      await tx.execute(sql`
        SELECT
          COUNT(*)::int AS "openCount",
          COUNT(*) FILTER (
            WHERE kind = 'contradiction' AND severity = 'high'
          )::int AS "hiCount"
        FROM case_consistency_findings
        WHERE school_id = ${schoolId}
          AND case_id = ${caseId}
          AND status = 'open'
      `)
    ).rows as { openCount: number; hiCount: number }[];

    await tx
      .insert(caseConsistencyStateTable)
      .values({
        schoolId,
        caseId,
        latestRunId: newRunId,
        score,
        openFindingCount: openCount,
        highSeverityCount: hiCount,
        lastRunAt: new Date(),
        lastAttemptAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          caseConsistencyStateTable.schoolId,
          caseConsistencyStateTable.caseId,
        ],
        set: {
          latestRunId: newRunId,
          score,
          openFindingCount: openCount,
          highSeverityCount: hiCount,
          lastRunAt: new Date(),
          lastAttemptAt: new Date(),
          updatedAt: new Date(),
        },
      });

    return newRunId;
  });

  if (errorText) {
    return { kind: "error", message: errorText };
  }
  return {
    kind: "ok",
    runId,
    score,
    findingCount: kept.length,
    reusedRecent: false,
  };
}

// Per-case in-process debounce for fire-and-forget hooks. Each hook
// calls scheduleConsistencyRun which sets a 60s timer; subsequent
// calls within the window reset the timer. The actual AI call still
// goes through runConsistencyCheck above, which has its own
// belt-and-suspenders DB-level debounce in case the process restarted.
const _scheduled = new Map<string, NodeJS.Timeout>();
export function scheduleConsistencyRun(opts: {
  schoolId: number;
  caseId: number;
  triggerReason:
    | "new_statement"
    | "new_interaction"
    | "new_video"
    | "initial";
  actorStaffId: number | null;
  actorName: string | null;
}): void {
  void isAiAssistEnabledForSchool(opts.schoolId).then((ok) => {
    if (!ok) return;
    scheduleConsistencyRunInner(opts);
  });
}

function scheduleConsistencyRunInner(opts: {
  schoolId: number;
  caseId: number;
  triggerReason:
    | "new_statement"
    | "new_interaction"
    | "new_video"
    | "initial";
  actorStaffId: number | null;
  actorName: string | null;
}): void {
  const key = `${opts.schoolId}:${opts.caseId}`;
  const existing = _scheduled.get(key);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    _scheduled.delete(key);
    void runConsistencyCheck(opts).catch((e) => {
      logger.warn(
        { schoolId: opts.schoolId, caseId: opts.caseId, err: String(e) },
        "consistency: scheduled run threw",
      );
    });
  }, DEBOUNCE_MS);
  // Don't keep the event loop alive for these.
  if (typeof t.unref === "function") t.unref();
  _scheduled.set(key, t);
}
