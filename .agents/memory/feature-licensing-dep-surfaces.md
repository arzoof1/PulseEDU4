---
name: Feature Licensing dependency-guard surfaces
description: Where feature-dependency (Required/Recommended) validation must live so no path persists an incoherent combo.
---

# Feature Licensing dependency guards

Feature dependencies live in the server registry (`FEATURE_KEYS` in
`lib/featureLicensing.ts`) as optional `requires` (HARD) / `recommends`
(SOFT) per `FeatureSpec`. `/feature-licensing/feature-keys` returns the
registry verbatim, so edges flow to the client automatically.

**Rule:** EVERY UI surface that toggles a feature must run
`computeDepIssues` on the **EFFECTIVE** feature set and block any write
that leaves a Required dep unmet.

**Why:** the validation was first added to only the two modal editors
(`PlanEditorModal`, `FeaturePickerModal`). Review then found the
`OverridesDrawer` had THREE more unguarded write paths — immediate per-row
`upsert` (enable/disable) AND the Clear/`remove` delete (reverting an
override to a `false` plan default can orphan a dependent). Each round of
review surfaced another path. There are 3 toggle surfaces, not 1.

**How to apply:** when adding any new feature-toggle surface, wire
`computeDepIssues` + block. The drawer must be plan-aware (effective =
`override ?? plan default`) or it false-flags features enabled via the
plan with no override row. `resetAll` is intentionally unguarded — it only
reverts to plan defaults, which `PlanEditorModal` already guards.

**4th surface — School Features panel (`App.tsx`, `settingsTile ==="schoolFeatures"`):**
the school-admin two-tier panel (super_feature_ "Allowed" + feature_
"Enabled") now surfaces the SAME deps as inline warnings (red=requires,
amber=recommends), computed only when the feature is EFFECTIVELY live
(`super && admin`) and a dep target's effective state is off. It WARNS,
does not block (the panel is a plain save, not a plan editor). The dep map
is a small hardcoded `FEATURE_DEPS` mirror (PascalCase keys) — the drift
risk is accepted (must stay in lockstep with `FEATURE_KEYS`); dep targets
`academics`/`dataImports` aren't rows here but their super/admin values ARE
in `schoolSettings` state so effective checks still work.

**Audit note (9 July-2026 modules):** dataChats/schoolGrade recommend
academics, gradebook requires dataImports — already correct. pickup,
ticketing, tours, esign, brainLab, safetyPlans are genuinely standalone
(verified brainLab uses its OWN groups, not behaviorSpecialist; ticketing
email is standalone, portal delivery is one optional channel). No hidden
cascades — plan-apply blind-writes super_feature_ booleans by design.
