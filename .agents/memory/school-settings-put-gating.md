---
name: school-settings PUT per-field gating
description: Adding a school-wide setting to PUT /school-settings needs its OWN role gate; the route has no top-level admin guard and intRange auto-writes to updates.
---

# PUT /api/school-settings has no route-level role gate

`router.put("/school-settings")` is guarded only by `requireSchool` (tenant
scoping) — there is **no** admin/role middleware on the route. Authorization for
school-wide policy fields is done **per-field, inline** in the handler.

**Why:** the route mixes harmless per-school display prefs with school-wide PBIS
policy. Only some fields are privileged.

**How to apply:** when you add a new school-WIDE policy field (anything a single
teacher shouldn't be able to flip for the whole school), add an explicit inline
role gate that returns 403 for non-privileged staff — mirror the
`pbisNegativeAffectsTotal` gate (active && isSuperUser||isAdmin||isPbisCoordinator||isBehaviorSpecialist).

**Gotcha:** the `intRange(name,val,min,max,field)` validator **writes the value
into `updates` as a side effect** during the validation loop. So an integer
field is already staged before any later gate runs — your 403 must `return`
before the final `db.update(...)`, not just skip an assignment. Place the gate
after the validation loop, before the DB write.

**Known parity gap (pre-existing, not from this work):** the per-school PBIS
int settings routed through `intRange` (pbisInvisibleDaysTier1/2/3,
pbisColdPeriodMultiple, pbisReasonImbalancePct, pbisQuietTeacherDays) currently
have NO server-side role gate — they rely on client-only gating, which is
bypassable. `interventionEffectivenessDays` and `pbisNegativeAffectsTotal` ARE
server-gated. If you touch those tier-day settings, consider closing the gap.
