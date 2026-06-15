// PulseBrainLab PARENT PORTAL — the family-facing side of "Reinforce at Home":
// read the recall cards for a child (shared work samples grouped by lesson),
// record a voice-to-text Home Follow-Up per "Ask your child" prompt, and
// download the evidence packet PDF.
//
// HARD CONSTRAINTS:
//  - Parent-authed (req.parentId via session or Bearer parent token). Every
//    lookup is gated by parent↔student ownership AND the student's school_id.
//  - The FLEID (students.student_id) is an internal FK only. The parent payload
//    NEVER includes it or the raw object key — work samples are stripped to a
//    safe shape; the only id that may appear is local_sis_id.
//  - Bilingual: the family picks EN/ES. CASEL / "SEL" framing never appears.
import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  parentStudentsTable,
  studentsTable,
  pulseBrainLabHomeResponsesTable,
} from "@workspace/db";
import { verifyParentAuthToken } from "../lib/authToken.js";
import { buildHomeCards } from "../lib/pulseBrainLabHomeCards.js";
import { buildPacketPdf } from "./pulseBrainLabDelivery.js";
import type { WorksheetLanguage } from "../lib/pulseBrainLabWorksheetPdf.js";

const router: IRouter = Router();

router.use(async (req, _res, next) => {
  let pid: number | null = req.session.parentId ?? null;
  if (!pid) {
    const auth = req.headers.authorization;
    if (typeof auth === "string" && auth.startsWith("Bearer ")) {
      pid = verifyParentAuthToken(auth.slice(7).trim());
    }
  }
  req.parentId = pid;
  next();
});

function parseLang(value: unknown): WorksheetLanguage {
  return value === "es" ? "es" : "en";
}

interface OwnedStudent {
  /** Canonical students.student_id (FLEID) — internal FK, never returned. */
  fleid: string;
  schoolId: number;
  localSisId: string | null;
}

// Resolve a parent-owned student from the integer students.id the portal uses.
// Returns null when the parent does not own the student. The school_id comes
// from the student row itself (the authoritative tenant), not from the caller.
async function resolveOwnedStudent(
  parentId: number,
  studentIdInt: number,
): Promise<OwnedStudent | null> {
  const [link] = await db
    .select({ id: parentStudentsTable.id })
    .from(parentStudentsTable)
    .where(
      and(
        eq(parentStudentsTable.parentId, parentId),
        eq(parentStudentsTable.studentId, studentIdInt),
      ),
    );
  if (!link) return null;
  const [student] = await db
    .select({
      studentId: studentsTable.studentId,
      schoolId: studentsTable.schoolId,
      localSisId: studentsTable.localSisId,
    })
    .from(studentsTable)
    .where(eq(studentsTable.id, studentIdInt));
  if (!student) return null;
  return {
    fleid: student.studentId,
    schoolId: student.schoolId,
    localSisId: student.localSisId ?? null,
  };
}

// Strip the staff card down to a family-safe shape: drop the FLEID studentId and
// the raw objectKey from every work sample (the family never needs either).
function sanitizeCard(card: Awaited<ReturnType<typeof buildHomeCards>>[number]) {
  // Grading is PER ASSIGNMENT (session), but a card groups every SHARED sample
  // for one lesson — possibly across several sessions, each with its own grade
  // and benchmark. Surface ONE grade entry per graded shared sample (newest
  // first, as buildHomeCards orders them) so a multi-session lesson never
  // collapses to a single misattributed grade. A sample is included only when
  // the assignment has a grade mode AND there's an actual mark/score or a
  // tagged benchmark — never an empty "not graded" line to the home.
  const grades = card.workSamples
    .filter(
      (s) =>
        s.gradeMode != null &&
        (s.score != null ||
          s.participationMark != null ||
          s.benchmarkCode != null),
    )
    .map((s) => ({
      sessionDate: s.sampleSessionDate,
      gradeMode: s.gradeMode,
      maxScore: s.maxScore,
      score: s.score,
      participationMark: s.participationMark,
      benchmarkCode: s.benchmarkCode,
      benchmarkLabel: s.benchmarkLabel,
    }));
  return {
    lessonKey: card.lessonKey,
    lessonTitle: card.lessonTitle,
    skillArea: card.skillArea,
    brainIdea: card.brainIdea,
    sessionId: card.sessionId,
    sessionDate: card.sessionDate,
    parentReinforcement: card.parentReinforcement,
    workSampleCount: card.workSamples.length,
    grades,
    homeResponses: card.homeResponses.map((r) => ({
      id: r.id,
      lessonKey: r.lessonKey,
      sessionId: r.sessionId,
      promptIndex: r.promptIndex,
      transcript: r.transcript,
      language: r.language,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
  };
}

// GET /api/parent/brain-lab/cards?studentId= — the "Reinforce at Home" cards for
// one owned child. studentId is the integer students.id used across the portal.
router.get("/parent/brain-lab/cards", async (req, res) => {
  const pid = req.parentId;
  if (!pid) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const studentIdInt = Number(req.query.studentId);
  if (!Number.isInteger(studentIdInt)) {
    res.status(400).json({ error: "studentId is required" });
    return;
  }
  const owned = await resolveOwnedStudent(pid, studentIdInt);
  if (!owned) {
    res.status(403).json({ error: "Not your student" });
    return;
  }
  const cards = await buildHomeCards(owned.schoolId, owned.fleid);
  res.json(cards.map(sanitizeCard));
});

const SubmitResponseBody = z.object({
  studentId: z.number().int(),
  lessonKey: z.string().min(1),
  sessionId: z.number().int().nullable().optional(),
  promptIndex: z.number().int().min(0),
  transcript: z.string().trim().min(1).max(4000),
  language: z.enum(["en", "es"]).default("en"),
});

// POST /api/parent/brain-lab/responses — record/replace a Home Follow-Up
// transcript for one prompt. Upserts on (student, lesson, prompt) so a family
// can re-record a prompt; transcript text ONLY (no audio is stored).
router.post("/parent/brain-lab/responses", async (req, res) => {
  const pid = req.parentId;
  if (!pid) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const parsed = SubmitResponseBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const body = parsed.data;
  const owned = await resolveOwnedStudent(pid, body.studentId);
  if (!owned) {
    res.status(403).json({ error: "Not your student" });
    return;
  }
  // The card must exist for this lesson (i.e. a shared work sample gates it) so a
  // parent can only respond to prompts the school has actually surfaced.
  const cards = await buildHomeCards(owned.schoolId, owned.fleid);
  const card = cards.find((c) => c.lessonKey === body.lessonKey);
  if (!card) {
    res.status(404).json({ error: "No active card for that lesson" });
    return;
  }
  if (body.promptIndex >= card.parentReinforcement.askYourChild.length) {
    res.status(400).json({ error: "Invalid prompt" });
    return;
  }
  const now = new Date();
  const [row] = await db
    .insert(pulseBrainLabHomeResponsesTable)
    .values({
      schoolId: owned.schoolId,
      studentId: owned.fleid,
      lessonKey: body.lessonKey,
      sessionId: body.sessionId ?? card.sessionId ?? null,
      promptIndex: body.promptIndex,
      transcript: body.transcript,
      language: body.language,
      createdByParentId: pid,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      // Conflict key must match the (school_id-leading) unique index — FLEID is
      // not globally unique, so school_id is required to avoid cross-tenant
      // overwrite.
      target: [
        pulseBrainLabHomeResponsesTable.schoolId,
        pulseBrainLabHomeResponsesTable.studentId,
        pulseBrainLabHomeResponsesTable.lessonKey,
        pulseBrainLabHomeResponsesTable.promptIndex,
      ],
      set: {
        transcript: body.transcript,
        language: body.language,
        sessionId: body.sessionId ?? card.sessionId ?? null,
        createdByParentId: pid,
        updatedAt: now,
      },
    })
    .returning();
  res.json({
    id: row.id,
    lessonKey: row.lessonKey,
    sessionId: row.sessionId,
    promptIndex: row.promptIndex,
    transcript: row.transcript,
    language: row.language,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
});

// GET /api/parent/brain-lab/packet.pdf?studentId=&lessonKey=&lang= — the family
// download of the evidence packet (recall card + child's work + Home Follow-Up).
router.get("/parent/brain-lab/packet.pdf", async (req, res) => {
  const pid = req.parentId;
  if (!pid) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const studentIdInt = Number(req.query.studentId);
  const lessonKey = String(req.query.lessonKey ?? "");
  if (!Number.isInteger(studentIdInt) || !lessonKey) {
    res.status(400).json({ error: "studentId and lessonKey are required" });
    return;
  }
  const owned = await resolveOwnedStudent(pid, studentIdInt);
  if (!owned) {
    res.status(403).json({ error: "Not your student" });
    return;
  }
  const lang = parseLang(req.query.lang);
  const cards = await buildHomeCards(owned.schoolId, owned.fleid);
  const card = cards.find((c) => c.lessonKey === lessonKey);
  if (!card) {
    res.status(404).json({ error: "No shared evidence for that lesson" });
    return;
  }
  const pdf = await buildPacketPdf(card, lang);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="reinforce-at-home-${lessonKey}.pdf"`,
  );
  res.end(pdf);
});

export default router;
