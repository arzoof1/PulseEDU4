// PulseBrainLab catalog — GLOBAL (not school-scoped) read-only reference of the
// curated 48-lesson curriculum. Like the Standards Book and benchmark
// descriptions, the curated content is identical for every tenant (original
// program reference content, not tenant data), so it is served once for all
// schools straight from the committed dataset. The DB table
// `pulse_brain_lab_lessons` is the catalog of record that delivery sessions FK
// to; these browse endpoints serve the same committed data in-memory for speed.
import { Router, type IRouter } from "express";
import {
  PULSE_BRAIN_LAB_LESSONS,
  type GradeBand,
} from "../data/pulseBrainLab/index.js";

const router: IRouter = Router();

const VALID_GRADE_BANDS: GradeBand[] = ["K-2", "3-5", "6-8", "9-12"];

// GET /api/pulse-brain-lab/lessons?gradeBand= — lightweight summaries for
// browsing/picking a lesson. Optional grade-band filter.
router.get("/pulse-brain-lab/lessons", (req, res) => {
  const raw = req.query.gradeBand;
  const gradeBand =
    typeof raw === "string" && raw.length > 0 ? (raw as GradeBand) : undefined;
  if (gradeBand && !VALID_GRADE_BANDS.includes(gradeBand)) {
    res.status(400).json({ error: `Invalid gradeBand "${gradeBand}"` });
    return;
  }
  const lessons = gradeBand
    ? PULSE_BRAIN_LAB_LESSONS.filter((l) => l.gradeBand === gradeBand)
    : PULSE_BRAIN_LAB_LESSONS;
  res.json(
    lessons.map((l) => ({
      lessonKey: l.id,
      gradeBand: l.gradeBand,
      week: l.week,
      session: l.session,
      title: l.title,
      skillArea: l.skillArea,
      brainModelTag: l.brainModelTag,
    })),
  );
});

// GET /api/pulse-brain-lab/lessons/:lessonKey — full lesson (flow, prompts,
// bilingual parent card + student worksheet). The internal CASEL competency is
// intentionally stripped here so it never leaves the server.
router.get("/pulse-brain-lab/lessons/:lessonKey", (req, res) => {
  const lesson = PULSE_BRAIN_LAB_LESSONS.find(
    (l) => l.id === req.params.lessonKey,
  );
  if (!lesson) {
    res.status(404).json({ error: "Lesson not found" });
    return;
  }
  const { internalCaselCompetency: _omit, ...publicLesson } = lesson;
  res.json(publicLesson);
});

export default router;
