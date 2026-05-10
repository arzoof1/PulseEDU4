// AI-assisted @-mention suggester. Given a witness statement body and
// the school's roster, ask Claude which roster students appear to be
// referenced. ALWAYS advisory — the client never auto-applies; the
// writer must explicitly click a chip to insert.
//
// Failure modes are silent on purpose (return []) so the witness flow
// is never blocked by an AI hiccup.

import Anthropic from "@anthropic-ai/sdk";
import { logger } from "./logger";

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (_client) return _client;
  const baseURL = process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL;
  const apiKey = process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;
  if (!baseURL || !apiKey) {
    throw new Error("Anthropic AI Integrations env vars not set");
  }
  _client = new Anthropic({ baseURL, apiKey });
  return _client;
}

const MODEL = "claude-sonnet-4-6";

export type MentionSuggestRosterRow = {
  studentId: string;
  firstName: string;
  lastName: string;
  grade: number | string | null;
};

export type MentionSuggestion = {
  studentId: string;
  displayName: string;
  reason: string;
};

export async function suggestMentions(opts: {
  body: string;
  roster: MentionSuggestRosterRow[];
  already: Set<string>;
}): Promise<MentionSuggestion[]> {
  const { body, roster, already } = opts;
  // Strip existing chip tokens so the model focuses on free-text refs.
  const cleaned = body.replace(/@\[[^|\]]+\|([A-Za-z0-9_-]+)\]/g, (_m, sid) => {
    const r = roster.find((x) => x.studentId === sid);
    return r ? `${r.firstName} ${r.lastName}` : "";
  });

  // Compact roster snippet — keep tokens small. We only send first/last
  // and grade; nothing PII-sensitive beyond what is already in the body.
  const rosterLines = roster
    .map((r) => `${r.studentId}: ${r.firstName} ${r.lastName} (G${r.grade ?? "?"})`)
    .join("\n");

  const prompt = [
    "You analyze a witness statement and identify which students from a school roster",
    "are referenced in the text. A student is referenced when the text uses their full",
    "name, or an unambiguous last-name-only reference, or an obvious nickname.",
    "Do NOT guess. If multiple roster students could match, skip them.",
    "Reply ONLY with valid JSON of the form:",
    '{"suggestions":[{"studentId":"...","reason":"..."}]}',
    "",
    "ROSTER:",
    rosterLines,
    "",
    "STATEMENT:",
    cleaned,
  ].join("\n");

  let raw = "";
  try {
    const resp = await getClient().messages.create({
      model: MODEL,
      max_tokens: 600,
      messages: [{ role: "user", content: prompt }],
    });
    for (const block of resp.content) {
      if (block.type === "text") raw += block.text;
    }
  } catch (err) {
    logger.warn({ err }, "mention-suggest AI call failed");
    return [];
  }

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  const suggestions = (parsed as { suggestions?: unknown })?.suggestions;
  if (!Array.isArray(suggestions)) return [];

  const rosterMap = new Map(roster.map((r) => [r.studentId, r] as const));
  const out: MentionSuggestion[] = [];
  const seen = new Set<string>();
  for (const item of suggestions) {
    if (!item || typeof item !== "object") continue;
    const s = item as { studentId?: unknown; reason?: unknown };
    if (typeof s.studentId !== "string") continue;
    const sid = s.studentId;
    if (already.has(sid)) continue;
    if (seen.has(sid)) continue;
    const r = rosterMap.get(sid);
    if (!r) continue;
    seen.add(sid);
    out.push({
      studentId: sid,
      displayName: `${r.firstName} ${r.lastName}`,
      reason: typeof s.reason === "string" ? s.reason.slice(0, 200) : "",
    });
  }
  return out.slice(0, 8);
}
