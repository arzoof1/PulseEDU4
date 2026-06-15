---
name: PulseBrainLab program
description: Branding/positioning + content design constraints for the PulseBrainLab intervention curriculum
---

# PulseBrainLab

A PulseEDU-original, brain-based **learning & self-regulation** intervention
program. Curriculum data lives in `artifacts/api-server/src/data/pulseBrainLab/`
(4 grade-band JSON files + typed `index.ts`): 48 lessons = bands K-2/3-5/6-8/9-12
x one 6-week cycle (12 sessions, ~15 min, 2x/week).

## Hard constraints (durable decisions)

- **NEVER surface "SEL" / "social-emotional learning" to staff, parents, or
  students.** **Why:** politically sensitive in Florida; the user explicitly
  required removing all SEL language. **How to apply:** student-facing copy uses
  neutral `skillArea` labels (Know Your Brain / Focus & Self-Control /
  Understanding Others / Working With Others / Smart Choices). The
  `caselAlignment` field is INTERNAL/admin-only reference for academic
  defensibility — do not render it in any teacher/parent/student surface.
- **Original content only — do NOT reproduce Second Step** (or any licensed
  curriculum) wording, titles, or lesson sequence, even reworded. **Why:** CASEL
  the framework is free to align to; Second Step the product is copyrighted.
  Build "up from CASEL," not "down from Second Step."
- **Cognitive-science thread is core, not decoration.** Every lesson carries a
  `brainModelTag`: Spotlight=attention, Velcro=encoding/connect-to-prior,
  Echo=retrieval practice, Rewire=neuroplasticity. Sessions open with an Echo
  (recall last session) and close with a Rewire goal; followup questions ARE
  retrieval practice.

## Downstream phases (not yet built as of authoring)

DB catalog table + CSV importer (provider-agnostic, license-gated) + Behavior
Specialist browse/deliver UI + session capture (interventionist Q&A + student
responses + signature) + parent HeartBEAT cards (lesson + child responses) +
photo-capture of student work as evidence (staff-only default, per-item family
share; reuse `/api/storage/*` bindObjectToSchool; getUserMedia works in preview
iframe). Any student-facing ID = `local_sis_id`, never FLEID.
