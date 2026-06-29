---
name: PBIS point-awarding-staff population
description: The "quiet staff" alert and "Staff Active" tile measure point-awarding staff, not just teachers; both endpoints must share the population.
---

# PBIS "point-awarding staff" population

The PBIS engagement metrics — the Needs-Attention "X of Y staff haven't
awarded points in N+ school days" alert and the home-stats "Staff Active"
tile — measure **point-awarding staff**, defined as: active staff in the
school who EITHER teach a non-planning `class_section` OR have at least one
non-voided `pbis_entry`.

**Why:** the alert originally counted only classroom teachers (non-planning
class-section holders). When an admin/coordinator (e.g. a SuperUser who isn't
assigned a section) awarded points, the alert never moved ("39 of 39 teachers"
stuck), and it disagreed with the home-stats "Teachers Active" numerator which
already counted ANY awarding staff. The user chose to count all point-awarding
staff and relabel "teachers" → "staff".

**How to apply (invariant):** `/pbis/needs-attention` (quiet population +
response `total`) and `/pbis/home-stats` (denominator `totalTeachingStaff` +
the weekly `teachersActive` numerator, which must be intersected with the
population so numerator ⊆ denominator) MUST compute the same population, or the
two surfaces disagree again. Internal JSON keys/var names (`quietTeachers`,
`totalTeachingStaff`, `teachersActive`) were kept for API compatibility — the
semantics are "staff", not "teachers". All awarder/staff queries stay
school-scoped (`eq(...schoolId, req.schoolId!)`).
