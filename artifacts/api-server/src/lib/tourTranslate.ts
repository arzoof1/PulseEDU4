import { createHash } from "crypto";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import type {
  TourPageSection,
  TourCheckpoint,
  TourTranslation,
} from "@workspace/db";
import { logger } from "./logger.js";

// ---------------------------------------------------------------------------
// School Tours — on-demand machine translation of the public brag page.
//
// The English columns on `tour_pages` are the source of truth and are always
// served raw. When a family toggles the public page to another language we
// machine-translate the admin-authored free text once and cache it on the row
// (keyed by language). The cache is keyed by a hash of the source strings so a
// later admin edit transparently invalidates it. Only Spanish is supported
// today; `SUPPORTED_TARGET_LANGS` gates which languages we will translate to.
// ---------------------------------------------------------------------------

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 4096;

// Languages we will machine-translate the brag page into. English is the
// source language and is never translated.
export const SUPPORTED_TARGET_LANGS = ["es"] as const;
export type SupportedTargetLang = (typeof SUPPORTED_TARGET_LANGS)[number];

const LANG_NAMES: Record<SupportedTargetLang, string> = {
  es: "Spanish (Latin American, as spoken by families in U.S. schools)",
};

export function isSupportedTargetLang(
  lang: string,
): lang is SupportedTargetLang {
  return (SUPPORTED_TARGET_LANGS as readonly string[]).includes(lang);
}

// The admin-authored subset of a tour page that we translate. Mirrors the
// translatable columns; checkpoint keys are preserved (selections are stored
// by key) so only labels are translated.
export type TranslatableTourContent = {
  headline: string;
  subheadline: string;
  intro: string;
  sections: TourPageSection[];
  checkpoints: Pick<TourCheckpoint, "key" | "label">[];
  programs: string[];
  electives: string[];
  proudOf: string[];
  ctaText: string;
};

// Stable hash of the source strings a translation was produced from. Order
// matters and is fixed here so identical content always hashes the same.
export function hashTourContent(c: TranslatableTourContent): string {
  const payload = JSON.stringify([
    c.headline,
    c.subheadline,
    c.intro,
    c.sections.map((s) => [s.title, s.body]),
    // Include the key (not just the label): a cached translation stores
    // {key,label}, so a key change with an unchanged label must still
    // invalidate the cache or the public form would render stale keys and the
    // family's selection would be rejected on submit.
    c.checkpoints.map((cp) => [cp.key, cp.label]),
    c.programs,
    c.electives,
    c.proudOf,
    c.ctaText,
  ]);
  return createHash("sha256").update(payload).digest("hex");
}

// Collect every non-empty string from the content in a deterministic order so
// we can translate them as a flat list and reassemble afterwards. Empty
// strings are skipped (they translate to empty and would waste tokens).
function collectStrings(c: TranslatableTourContent): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    if (s && s.trim()) out.push(s);
  };
  push(c.headline);
  push(c.subheadline);
  push(c.intro);
  for (const s of c.sections) {
    push(s.title);
    push(s.body);
  }
  for (const cp of c.checkpoints) push(cp.label);
  for (const p of c.programs) push(p);
  for (const e of c.electives) push(e);
  for (const p of c.proudOf) push(p);
  push(c.ctaText);
  return out;
}

// Rebuild the content structure, substituting each non-empty source string for
// its translation via the provided lookup. Empty strings stay empty. Falls
// back to the source string when a translation is missing.
function rebuild(
  c: TranslatableTourContent,
  lookup: Map<string, string>,
): TranslatableTourContent {
  const tr = (s: string) => (s && s.trim() ? lookup.get(s) ?? s : s);
  return {
    headline: tr(c.headline),
    subheadline: tr(c.subheadline),
    intro: tr(c.intro),
    sections: c.sections.map((s) => ({ title: tr(s.title), body: tr(s.body) })),
    checkpoints: c.checkpoints.map((cp) => ({
      key: cp.key,
      label: tr(cp.label),
    })),
    programs: c.programs.map(tr),
    electives: c.electives.map(tr),
    proudOf: c.proudOf.map(tr),
    ctaText: tr(c.ctaText),
  };
}

// Translate the admin-authored content into `lang` and return a cache payload
// (translated fields + source hash). Returns null on any failure so callers
// can transparently fall back to the English source — a translation outage
// must never break the public page.
export async function translateTourContent(
  content: TranslatableTourContent,
  lang: SupportedTargetLang,
): Promise<TourTranslation | null> {
  const sourceHash = hashTourContent(content);
  const strings = collectStrings(content);
  // Nothing to translate (page is effectively empty) — cache an identity
  // mapping so we don't re-hit the model on every view.
  if (strings.length === 0) {
    const rebuilt = rebuild(content, new Map());
    return { sourceHash, ...rebuilt };
  }

  const languageName = LANG_NAMES[lang];
  const system =
    `You are a professional translator for a U.S. K-12 school's public ` +
    `enrollment page. Translate the given strings from English into ` +
    `${languageName}. Keep the tone warm, welcoming, and parent-friendly. ` +
    `Do not translate proper nouns (school names, program brand names, people's ` +
    `names) — leave them as-is. Preserve any punctuation and capitalization ` +
    `style. Return ONLY a JSON array of strings: the translations in the same ` +
    `order as the input, with exactly the same number of items. No commentary, ` +
    `no markdown, no keys.`;

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: "user", content: JSON.stringify(strings) }],
    });
    const text = response.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();

    const parsed = parseStringArray(text);
    if (!parsed || parsed.length !== strings.length) {
      logger.error(
        { lang, expected: strings.length, got: parsed?.length },
        "tour translation: model returned mismatched array",
      );
      return null;
    }

    const lookup = new Map<string, string>();
    strings.forEach((src, i) => lookup.set(src, parsed[i]));
    const rebuilt = rebuild(content, lookup);
    return { sourceHash, ...rebuilt };
  } catch (err) {
    logger.error({ err, lang }, "tour translation request failed");
    return null;
  }
}

// Defensively parse the model output into a string array. Tolerates a stray
// markdown code fence around the JSON.
function parseStringArray(text: string): string[] | null {
  let body = text;
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) body = fence[1].trim();
  try {
    const json = JSON.parse(body);
    if (Array.isArray(json) && json.every((x) => typeof x === "string")) {
      return json as string[];
    }
  } catch {
    /* fall through */
  }
  return null;
}
