// Builds the "Reinforce at Home" cards for a single student: shared work
// samples grouped by the lesson that was delivered, each carrying the bilingual
// parent recall content (from the global lesson catalog) and any parent-
// submitted Home Follow-Up transcripts.
//
// FLEID boundary: callers pass the canonical students.student_id (FLEID text
// FK). The staff projection returns the raw work-sample rows (studentId is a
// non-rendered FK); the parent projection (see routes/pulseBrainLabParent.ts)
// strips studentId and objectKey before the payload leaves for the family.
import {
  db,
  pulseBrainLabWorkSamplesTable,
  pulseBrainLabSessionsTable,
  pulseBrainLabHomeResponsesTable,
  studentsTable,
} from "@workspace/db";
import { and, eq, desc } from "drizzle-orm";
import { PULSE_BRAIN_LAB_LESSONS } from "../data/pulseBrainLab/index.js";
import type {
  PulseBrainLabLesson,
  PulseBrainLabParentReinforcement,
} from "../data/pulseBrainLab/index.js";

export interface HomeCardWorkSample {
  id: number;
  sessionId: number;
  studentId: string;
  localSisId: string | null;
  firstName: string | null;
  lastName: string | null;
  objectKey: string;
  pageIndex: number | null;
  source: string;
  shared: boolean;
  createdAt: string;
  // The date of the SESSION this sample belongs to (the assignment date) — used
  // to label per-assignment grades on family surfaces.
  sampleSessionDate: string | null;
  // Grading (per-assignment config from the session + per-sample grade). The
  // mode/benchmark live on the session; the score/mark live on the sample.
  gradeMode: string | null;
  maxScore: number | null;
  score: number | null;
  participationMark: string | null;
  benchmarkCode: string | null;
  benchmarkLabel: string | null;
}

export interface HomeCardHomeResponse {
  id: number;
  lessonKey: string;
  sessionId: number | null;
  promptIndex: number;
  transcript: string;
  language: string;
  createdAt: string;
  updatedAt: string;
}

export interface HomeCard {
  lessonKey: string;
  lessonTitle: string;
  skillArea: string;
  brainIdea: PulseBrainLabLesson["brainModelTag"];
  sessionId: number | null;
  sessionDate: string | null;
  parentReinforcement: PulseBrainLabParentReinforcement;
  workSamples: HomeCardWorkSample[];
  homeResponses: HomeCardHomeResponse[];
}

function findLesson(lessonKey: string): PulseBrainLabLesson | null {
  return PULSE_BRAIN_LAB_LESSONS.find((l) => l.id === lessonKey) ?? null;
}

// Load the "Reinforce at Home" cards for a student. Only SHARED work samples
// drive a card — that share toggle is the single gate that exposes a lesson to
// the family. Cards are ordered most-recent session first.
export async function buildHomeCards(
  schoolId: number,
  studentId: string,
): Promise<HomeCard[]> {
  const sampleRows = await db
    .select({
      id: pulseBrainLabWorkSamplesTable.id,
      sessionId: pulseBrainLabWorkSamplesTable.sessionId,
      studentId: pulseBrainLabWorkSamplesTable.studentId,
      objectKey: pulseBrainLabWorkSamplesTable.objectKey,
      pageIndex: pulseBrainLabWorkSamplesTable.pageIndex,
      source: pulseBrainLabWorkSamplesTable.source,
      shared: pulseBrainLabWorkSamplesTable.shared,
      createdAt: pulseBrainLabWorkSamplesTable.createdAt,
      lessonKey: pulseBrainLabSessionsTable.lessonKey,
      sessionDate: pulseBrainLabSessionsTable.sessionDate,
      gradeMode: pulseBrainLabSessionsTable.gradeMode,
      maxScore: pulseBrainLabSessionsTable.maxScore,
      benchmarkCode: pulseBrainLabSessionsTable.benchmarkCode,
      benchmarkLabel: pulseBrainLabSessionsTable.benchmarkLabel,
      score: pulseBrainLabWorkSamplesTable.score,
      participationMark: pulseBrainLabWorkSamplesTable.participationMark,
      localSisId: studentsTable.localSisId,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
    })
    .from(pulseBrainLabWorkSamplesTable)
    .innerJoin(
      pulseBrainLabSessionsTable,
      and(
        eq(pulseBrainLabSessionsTable.id, pulseBrainLabWorkSamplesTable.sessionId),
        eq(pulseBrainLabSessionsTable.schoolId, schoolId),
      ),
    )
    .leftJoin(
      studentsTable,
      and(
        eq(studentsTable.studentId, pulseBrainLabWorkSamplesTable.studentId),
        eq(studentsTable.schoolId, schoolId),
      ),
    )
    .where(
      and(
        eq(pulseBrainLabWorkSamplesTable.schoolId, schoolId),
        eq(pulseBrainLabWorkSamplesTable.studentId, studentId),
        eq(pulseBrainLabWorkSamplesTable.shared, true),
      ),
    )
    .orderBy(desc(pulseBrainLabWorkSamplesTable.createdAt));

  if (sampleRows.length === 0) return [];

  const responseRows = await db
    .select({
      id: pulseBrainLabHomeResponsesTable.id,
      lessonKey: pulseBrainLabHomeResponsesTable.lessonKey,
      sessionId: pulseBrainLabHomeResponsesTable.sessionId,
      promptIndex: pulseBrainLabHomeResponsesTable.promptIndex,
      transcript: pulseBrainLabHomeResponsesTable.transcript,
      language: pulseBrainLabHomeResponsesTable.language,
      createdAt: pulseBrainLabHomeResponsesTable.createdAt,
      updatedAt: pulseBrainLabHomeResponsesTable.updatedAt,
    })
    .from(pulseBrainLabHomeResponsesTable)
    .where(
      and(
        eq(pulseBrainLabHomeResponsesTable.schoolId, schoolId),
        eq(pulseBrainLabHomeResponsesTable.studentId, studentId),
      ),
    );

  const responsesByLesson = new Map<string, HomeCardHomeResponse[]>();
  for (const r of responseRows) {
    const list = responsesByLesson.get(r.lessonKey) ?? [];
    list.push({
      id: r.id,
      lessonKey: r.lessonKey,
      sessionId: r.sessionId ?? null,
      promptIndex: r.promptIndex,
      transcript: r.transcript,
      language: r.language,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    });
    responsesByLesson.set(r.lessonKey, list);
  }

  const cards = new Map<string, HomeCard>();
  for (const row of sampleRows) {
    const lesson = findLesson(row.lessonKey);
    if (!lesson) continue; // lesson de-listed from catalog — skip the card.
    let card = cards.get(row.lessonKey);
    if (!card) {
      card = {
        lessonKey: lesson.id,
        lessonTitle: lesson.title,
        skillArea: lesson.skillArea,
        brainIdea: lesson.brainModelTag,
        // sampleRows is newest-first, so the first sample we see for a lesson
        // is the most recent — use it as the card's session anchor.
        sessionId: row.sessionId,
        sessionDate: row.sessionDate,
        parentReinforcement: lesson.parentReinforcement,
        workSamples: [],
        homeResponses: (responsesByLesson.get(row.lessonKey) ?? []).sort(
          (a, b) => a.promptIndex - b.promptIndex,
        ),
      };
      cards.set(row.lessonKey, card);
    }
    card.workSamples.push({
      id: row.id,
      sessionId: row.sessionId,
      studentId: row.studentId,
      localSisId: row.localSisId ?? null,
      firstName: row.firstName ?? null,
      lastName: row.lastName ?? null,
      objectKey: row.objectKey,
      pageIndex: row.pageIndex ?? null,
      source: row.source,
      shared: row.shared,
      createdAt: row.createdAt.toISOString(),
      sampleSessionDate: row.sessionDate ?? null,
      gradeMode: row.gradeMode ?? null,
      maxScore: row.maxScore ?? null,
      score: row.score ?? null,
      participationMark: row.participationMark ?? null,
      benchmarkCode: row.benchmarkCode ?? null,
      benchmarkLabel: row.benchmarkLabel ?? null,
    });
  }

  return [...cards.values()];
}

export { findLesson as findPulseBrainLabLesson };
