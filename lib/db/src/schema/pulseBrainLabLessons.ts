import {
  pgTable,
  serial,
  text,
  integer,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// pulse_brain_lab_lessons — GLOBAL (not school-scoped) catalog of the curated
// PulseBrainLab curriculum (48 lessons: 4 grade bands x 12 sessions). Like
// benchmark_descriptions, this is deliberately NOT school-scoped: the curated
// lesson content is identical for every tenant (it is original program
// reference content, not tenant data), so it lives once and is read by all
// schools. The committed source of truth is the JSON under
// artifacts/api-server/src/data/pulseBrainLab/; this table is upserted
// idempotently at boot, keyed by lessonKey, and version-stamped via
// contentVersion so corrections flow in on the next boot.
//
// The full lesson object (flow, prompts, parentReinforcement, studentWorksheet,
// etc.) is stored in the `lesson` JSONB column; the flat columns are
// denormalized copies for cheap listing/filtering without parsing JSON. The
// JSONB is typed as an opaque record here so lib/db carries no dependency on
// the app-side PulseBrainLabLesson type — callers cast on read.
export const pulseBrainLabLessonsTable = pgTable(
  "pulse_brain_lab_lessons",
  {
    id: serial("id").primaryKey(),
    // Stable lesson slug, e.g. "pbl-g35-s03". Natural unique key.
    lessonKey: text("lesson_key").notNull(),
    // "K-2" | "3-5" | "6-8" | "9-12".
    gradeBand: text("grade_band").notNull(),
    // 1-6 (six-week cycle).
    week: integer("week").notNull(),
    // 1-12 (two sessions per week).
    session: integer("session").notNull(),
    title: text("title").notNull(),
    // Neutral, student-facing skill label (never CASEL/SEL wording).
    skillArea: text("skill_area").notNull(),
    // Cognitive-science model tag: Spotlight | Velcro | Echo | Rewire.
    brainModelTag: text("brain_model_tag").notNull(),
    // Program contentVersion the row was seeded from (idempotent re-seed).
    contentVersion: integer("content_version").notNull(),
    // Full curated lesson object (opaque to lib/db; app casts on read).
    lesson: jsonb("lesson").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    gradeBandIdx: index("pulse_brain_lab_lessons_grade_band_idx").on(
      t.gradeBand,
    ),
    uniq: uniqueIndex("pulse_brain_lab_lessons_lesson_key_unique").on(
      t.lessonKey,
    ),
  }),
);

export type PulseBrainLabLessonRow =
  typeof pulseBrainLabLessonsTable.$inferSelect;
