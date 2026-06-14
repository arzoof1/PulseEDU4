// PulseDNA — per-school communication profile + AI drafting studio.
//
// Part of the Family Communication feature (gated on the `familyComm` license
// in routes/index.ts, Core-Team only here via requireFamilyMessenger).
//
// The PulseDNA profile is the school's communication voice/policy, authored
// outside the app and pasted or uploaded (parsed to TEXT client-side). The
// server stores text only — keeps the table light. AI drafting folds the
// profile in as background context (skipped when the profile is disabled).
//
// Talks to the client via authFetch (no OpenAPI codegen — repo convention for
// feature routes). Tenancy: school_id stamped on every row; every read/write
// is scoped to req.schoolId.
import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { z } from "zod";
import { db, staffTable, pulseDnaProfilesTable } from "@workspace/db";
import { pulseDnaGenerationsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { isCoreTeam } from "../lib/coreTeam.js";
import { anthropic } from "@workspace/integrations-anthropic-ai";

const router: IRouter = Router();

type StaffRow = typeof staffTable.$inferSelect;

// ---------------------------------------------------------------------------
// Auth — load the staff row and require Core Team (same gate as Family
// Messages). The `familyComm` license is enforced ahead of this router in
// routes/index.ts.
// ---------------------------------------------------------------------------
async function requireStaffRow(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const staffId = req.staffId;
  if (!staffId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const [staff] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, staffId));
  if (!staff || !staff.active) {
    res.status(401).json({ error: "Staff not found or inactive" });
    return;
  }
  (req as Request & { staff: StaffRow }).staff = staff;
  next();
}

function staffOf(req: Request): StaffRow {
  return (req as Request & { staff: StaffRow }).staff;
}

function requireFamilyMessenger(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!isCoreTeam(staffOf(req))) {
    res
      .status(403)
      .json({ error: "Not authorized to use PulseDNA" });
    return;
  }
  next();
}

router.use("/pulse-dna", requireStaffRow, requireFamilyMessenger);

// Cheap in-memory rate limiter for the paid LLM endpoint — per-staff sliding
// window. Generous; exists to stop runaway clients, not to ration normal use.
const DRAFT_WINDOW_MS = 60_000;
const DRAFT_MAX_PER_WINDOW = 12;
const draftHits = new Map<number, number[]>();

function rateLimitDraft(req: Request, res: Response, next: NextFunction): void {
  const sid = req.staffId;
  if (!sid) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const now = Date.now();
  const cutoff = now - DRAFT_WINDOW_MS;
  const recent = (draftHits.get(sid) ?? []).filter((t) => t > cutoff);
  if (recent.length >= DRAFT_MAX_PER_WINDOW) {
    res.status(429).json({
      error: "rate_limited",
      retryAfterSeconds: Math.ceil((recent[0] + DRAFT_WINDOW_MS - now) / 1000),
    });
    return;
  }
  recent.push(now);
  draftHits.set(sid, recent);
  next();
}

const MAX_PROFILE_CHARS = 50_000;

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

// GET /pulse-dna — the school's profile (or a default empty one).
router.get("/pulse-dna", async (req, res) => {
  const schoolId = req.schoolId;
  if (!schoolId) {
    res.status(401).json({ error: "School context required" });
    return;
  }
  const [row] = await db
    .select()
    .from(pulseDnaProfilesTable)
    .where(eq(pulseDnaProfilesTable.schoolId, schoolId));
  if (!row) {
    res.json({
      content: "",
      sourceName: null,
      enabled: true,
      updatedAt: null,
    });
    return;
  }
  res.json({
    content: row.content,
    sourceName: row.sourceName,
    enabled: row.enabled,
    updatedAt: row.updatedAt,
  });
});

const PutProfileBody = z.object({
  content: z.string().max(MAX_PROFILE_CHARS),
  sourceName: z.string().max(255).nullable().optional(),
  enabled: z.boolean().optional(),
});

// PUT /pulse-dna — create or replace the profile (read-or-create row).
router.put("/pulse-dna", async (req, res) => {
  const schoolId = req.schoolId;
  if (!schoolId) {
    res.status(401).json({ error: "School context required" });
    return;
  }
  const parsed = PutProfileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", detail: parsed.error.message });
    return;
  }
  const { content, sourceName, enabled } = parsed.data;
  const staffId = staffOf(req).id;

  // Atomic upsert keyed on the one-per-school unique index — avoids a
  // read-then-write race (two concurrent first-saves would otherwise collide
  // on the unique constraint). When `enabled` is omitted we leave the existing
  // flag untouched (content-only save keeps the toggle as-is).
  const [saved] = await db
    .insert(pulseDnaProfilesTable)
    .values({
      schoolId,
      content,
      sourceName: sourceName ?? null,
      enabled: enabled ?? true,
      updatedByStaffId: staffId,
    })
    .onConflictDoUpdate({
      target: pulseDnaProfilesTable.schoolId,
      set: {
        content,
        sourceName: sourceName ?? null,
        ...(enabled === undefined ? {} : { enabled }),
        updatedByStaffId: staffId,
        updatedAt: new Date(),
      },
    })
    .returning();
  res.json({
    content: saved.content,
    sourceName: saved.sourceName,
    enabled: saved.enabled,
    updatedAt: saved.updatedAt,
  });
});

const ToggleBody = z.object({ enabled: z.boolean() });

// PATCH /pulse-dna/toggle — enable/disable the profile without touching text.
router.patch("/pulse-dna/toggle", async (req, res) => {
  const schoolId = req.schoolId;
  if (!schoolId) {
    res.status(401).json({ error: "School context required" });
    return;
  }
  const parsed = ToggleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }
  const staffId = staffOf(req).id;
  const [existing] = await db
    .select()
    .from(pulseDnaProfilesTable)
    .where(eq(pulseDnaProfilesTable.schoolId, schoolId));
  if (!existing) {
    // Nothing saved yet — create an empty row carrying the toggle so the
    // preference sticks.
    const [created] = await db
      .insert(pulseDnaProfilesTable)
      .values({
        schoolId,
        content: "",
        enabled: parsed.data.enabled,
        updatedByStaffId: staffId,
      })
      .returning();
    res.json({ enabled: created.enabled });
    return;
  }
  const [updated] = await db
    .update(pulseDnaProfilesTable)
    .set({
      enabled: parsed.data.enabled,
      updatedByStaffId: staffId,
      updatedAt: new Date(),
    })
    .where(eq(pulseDnaProfilesTable.id, existing.id))
    .returning();
  res.json({ enabled: updated.enabled });
});

// ---------------------------------------------------------------------------
// AI drafting
// ---------------------------------------------------------------------------

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 2048;
const MAX_ROUGH_INPUT = 4000;

const DraftBody = z.object({
  roughInput: z.string().min(1).max(MAX_ROUGH_INPUT),
  outputType: z.string().min(1).max(120),
  audience: z.string().min(1).max(120),
  tone: z.string().min(1).max(120),
  language: z.string().min(1).max(80).optional(),
});

function buildDraftSystemPrompt(
  profile: string | null,
  outputType: string,
  audience: string,
  tone: string,
  language: string,
): string {
  const profileBlock =
    profile && profile.trim().length > 0
      ? `## SCHOOL COMMUNICATION PROFILE (PulseDNA)
Use this as the authoritative voice, values, and constraints for this school.
Match its tone, terminology, and any do/don't rules. Do not contradict it.

${profile.trim()}`
      : `(No school communication profile is active — use a warm, clear, professional school voice.)`;

  return `You are PulseDNA, the communication writing assistant inside PulseEDU, a K-12 school operations app. You help school staff turn a rough idea into a polished, ready-to-send message.

## YOUR TASK
- Output type: ${outputType}
- Intended audience: ${audience}
- Tone: ${tone}
- Language: write the message in ${language}.

## RULES
1. Write ONLY the finished message text, ready to copy and send. No preamble, no "Here's your draft", no surrounding quotes, no commentary.
2. Honor the requested output type's format (e.g. an SMS is short and plain; a newsletter blurb can have a short heading; a video/teleprompter script is spoken-word and conversational).
3. Keep it appropriate for a school-to-family/community context: clear, respectful, jargon-free, and inclusive.
4. Never invent specific facts (names, dates, times, dollar amounts, links) that the user did not provide. If a detail is needed but missing, use a clearly bracketed placeholder like [DATE] or [LOCATION].
5. Respect the school communication profile below.

${profileBlock}`;
}

// POST /pulse-dna/draft — generate a draft grounded in the (optional) profile.
router.post("/pulse-dna/draft", rateLimitDraft, async (req, res) => {
  const schoolId = req.schoolId;
  if (!schoolId) {
    res.status(401).json({ error: "School context required" });
    return;
  }
  const parsed = DraftBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "invalid_body", detail: parsed.error.message });
    return;
  }
  const { roughInput, outputType, audience, tone } = parsed.data;
  const language = parsed.data.language?.trim() || "English";

  const [profileRow] = await db
    .select()
    .from(pulseDnaProfilesTable)
    .where(eq(pulseDnaProfilesTable.schoolId, schoolId));
  const usedPulseDna =
    !!profileRow && profileRow.enabled && profileRow.content.trim().length > 0;
  const profileText = usedPulseDna ? profileRow.content : null;

  const system = buildDraftSystemPrompt(
    profileText,
    outputType,
    audience,
    tone,
    language,
  );

  let output: string;
  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: "user", content: roughInput }],
    });
    output = response.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
  } catch (err) {
    req.log?.error({ err }, "pulse-dna draft failed");
    res.status(502).json({ error: "ai_request_failed" });
    return;
  }

  if (!output) {
    res.status(502).json({ error: "empty_ai_response" });
    return;
  }

  // Accountability log — one row per generation, persists even if discarded.
  try {
    await db.insert(pulseDnaGenerationsTable).values({
      schoolId,
      staffId: staffOf(req).id,
      outputType,
      audience,
      tone,
      language,
      usedPulseDna,
      roughInput,
      output,
      model: MODEL,
    });
  } catch (err) {
    // Logging failure must not block the user's draft.
    req.log?.error({ err }, "pulse-dna generation log failed");
  }

  res.json({ output, usedPulseDna });
});

export default router;
