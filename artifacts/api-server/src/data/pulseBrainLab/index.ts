import k2Lessons from "./k2.json" with { type: "json" };
import g35Lessons from "./g35.json" with { type: "json" };
import g68Lessons from "./g68.json" with { type: "json" };
import g912Lessons from "./g912.json" with { type: "json" };

/**
 * PulseBrainLab — a brain-based learning & self-regulation program.
 *
 * Internally aligned to the CASEL 5 competencies for academic defensibility,
 * but NEVER surfaced as "SEL"/"social-emotional learning" to staff, parents,
 * or students (politically sensitive in FL). The `caselAlignment` field is an
 * admin-only/internal reference; `skillArea` is the neutral, student-facing
 * label.
 *
 * Structure: one 6-week cycle = 12 sessions (~15 min, twice weekly), authored
 * per grade band (K-2, 3-5, 6-8, 9-12) and developmentally re-leveled.
 *
 * Cognitive-science thread woven through every session via `brainModelTag`:
 *   - Spotlight = attention
 *   - Velcro    = encoding / connecting new to prior knowledge
 *   - Echo      = retrieval practice
 *   - Rewire    = neuroplasticity (practice changes the brain)
 */

export type BrainModelTag = "Spotlight" | "Velcro" | "Echo" | "Rewire";

export type GradeBand = "K-2" | "3-5" | "6-8" | "9-12";

/**
 * Internal/admin-only CASEL competency reference. NEVER rendered to staff,
 * parents, or students — use `skillArea` for any visible label.
 */
export type InternalCaselCompetency =
  | "Self-Awareness"
  | "Self-Management"
  | "Social Awareness"
  | "Relationship Skills"
  | "Responsible Decision-Making"
  | "Integration";

export interface PulseBrainLabLessonFlow {
  connect: string;
  teach: string;
  practice: string;
  close: string;
}

/**
 * A response-bearing prompt. The stable `id` (e.g. "pbl-g35-s03-cq2") is the
 * natural key downstream session-response capture FKs to, so editing the wording
 * later never orphans historical student responses.
 */
export interface PulseBrainLabPrompt {
  id: string;
  text: string;
}

export interface PulseBrainLabLesson {
  /** Stable slug, e.g. "pbl-g35-s03". */
  id: string;
  /** Audience key carried on every record for direct seeding/querying. */
  gradeBand: GradeBand;
  /** 1-6 (six-week cycle). */
  week: number;
  /** 1-12 (two sessions per week). */
  session: number;
  title: string;
  /** Neutral, student-facing skill label (e.g. "Focus & Self-Control"). */
  skillArea: string;
  /** Internal/admin-only CASEL competency reference. Never parent/student-facing. */
  internalCaselCompetency: InternalCaselCompetency;
  /** The cognitive-science idea taught this session. */
  brainConcept: string;
  brainModelTag: BrainModelTag;
  objective: string;
  materials: string;
  durationMinutes: number;
  flow: PulseBrainLabLessonFlow;
  /** Discussion prompts that drive thought during the session. */
  contentQuestions: PulseBrainLabPrompt[];
  /** Retrieval / take-home prompts for understanding checks. */
  followupQuestions: PulseBrainLabPrompt[];
  skillTags: string[];
}

export interface PulseBrainLabBand {
  gradeBand: GradeBand;
  label: string;
  lessons: PulseBrainLabLesson[];
}

export const PULSE_BRAIN_LAB_PROGRAM = {
  slug: "pulsebrainlab",
  name: "PulseBrainLab",
  tagline: "How your brain learns — and the focus, self-control, and people skills that help you learn.",
  weeks: 6,
  sessionsPerWeek: 2,
  sessionsPerCycle: 12,
  sessionMinutes: 15,
  /**
   * Bump when the curated lesson content changes. The DB seed uses this to
   * re-upsert curated rows idempotently and to leave staff-customized rows
   * untouched, so re-seeding is safe to run on every boot.
   */
  contentVersion: 1,
} as const;

export const PULSE_BRAIN_LAB_BANDS: PulseBrainLabBand[] = [
  { gradeBand: "K-2", label: "Grades K-2", lessons: k2Lessons as PulseBrainLabLesson[] },
  { gradeBand: "3-5", label: "Grades 3-5", lessons: g35Lessons as PulseBrainLabLesson[] },
  { gradeBand: "6-8", label: "Grades 6-8", lessons: g68Lessons as PulseBrainLabLesson[] },
  { gradeBand: "9-12", label: "Grades 9-12", lessons: g912Lessons as PulseBrainLabLesson[] },
];

/** Flat list of all 48 lessons across every grade band. */
export const PULSE_BRAIN_LAB_LESSONS: PulseBrainLabLesson[] = PULSE_BRAIN_LAB_BANDS.flatMap(
  (band) => band.lessons.map((lesson) => ({ ...lesson })),
);
