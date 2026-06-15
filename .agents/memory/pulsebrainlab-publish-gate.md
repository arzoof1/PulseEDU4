---
name: PulseBrainLab publish gate parity
description: Every parent-facing PulseBrainLab surface must enforce the session publish gate, not just the card builder.
---

PulseBrainLab family visibility is a TWO-part contract: (1) the student is in a
Brain Lab group (outer gate) AND (2) the work sample's session is published
(`pulse_brain_lab_sessions.published_at IS NOT NULL`). `null` = draft / staff-only.

**Why:** `buildHomeCards` enforces both gates for the cards/packet/responses
paths, but the publish gate is easy to forget on *sibling* parent routes. The
parent work-sample **image** route (`/parent/brain-lab/work-sample/:id/image`)
originally checked only ownership + group membership, so a guessed numeric
sampleId could stream a DRAFT image — a real bypass caught in review.

**How to apply:** Any NEW parent-facing endpoint that returns Brain Lab content
(images, PDFs, detail JSON) must join `pulseBrainLabSessionsTable` and require
`isNotNull(publishedAt)` — mirror `buildHomeCards`'s default (parents) vs
`{ includeUnpublished: true }` (staff preview/packet) split. Staff routes use
`loadCoreTeamStaff`/`isCoreTeam`; parent routes are `parentId`-authed and must
ALSO carry an explicit `school_id` predicate. The per-sample `shared` flag is a
staff annotation only and does NOT gate family visibility.
