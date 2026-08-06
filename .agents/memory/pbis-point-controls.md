---
name: PBIS award point controls
description: School toggle (adjust on/off) + per-award cap for PBIS points; where enforcement and gating must live.
---
Rule: the point-control policy (`pbisAllowPointAdjust`, `pbisMaxPointsPerAward` on school_settings) is enforced server-side at POST /pbis, POST /pbis/bulk (pin to reason defaultPoints when adjust off; 400 when abs(points) > cap) and PATCH /pbis/:id (cap only — edits have no authoritative reason to pin to). Core Team (lib/coreTeam isCoreTeam) is exempt everywhere.

**Why:** without a server gate a teacher could award e.g. 6,000 points for a trivial reason and distort the whole store/leaderboard economy; client UI (PicksEditor lock / input max) is presentation only.

**How to apply:**
- Any NEW endpoint that inserts/edits pbis_entries with caller-chosen points must run the same policy (settings row + isCoreTeam). Intentional exceptions: Spotlight (own bounded pool), intervention quick-log (server derives defaultPoints, no caller value), imports/seeds.
- In PUT /school-settings, the cap must NOT be validated via `intRange` — intRange writes into `updates` with no role gate. Both fields are validated + written inside the shared school-wide PBIS policy gate block (admin / PBIS coordinator / behavior specialist / SuperUser), like pbisNegativeAffectsTotal.
- Client mirror in PbisPointsHub (`isCoreTeamViewer`) is narrower than server isCoreTeam (Me lacks isDistrictAdmin/isSchoolPsychologist/assignable isCoreTeam/isConfidentialSecretary) — that only over-restricts the UI for those roles; server stays authoritative.
- Dev-login trick for role testing: demo teachers are firstname.lastname@pulsedemo.com / PulseDemo26.
