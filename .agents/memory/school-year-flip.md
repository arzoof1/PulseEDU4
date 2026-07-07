---
name: School-year flip (date-based reporting rollover)
description: How the FAST/Insights reporting-year rollover works — school-controlled date, not wall-clock; default resolves to newest data.
---

# School-year flip

The FAST/Insights **reporting year** is chosen by a school-controlled date
(`school_settings.school_year_flip_date`, YYYY-MM-DD, school-local), NOT a
wall-clock July-1 rollover. `getActiveSchoolYear(schoolId)` is the single
resolver every FAST/Insights current-year read must call.

**Rule: no flip set → resolve to the NEWEST non-historical data year**
(`resolveCurrentFastYear` = MAX(school_year WHERE is_historical=FALSE)).
**Why:** wall-clock `schoolYearLabelFor(new Date())` flips at July and can point
at a year with no data yet → blank Roster/Insights (the "frozen demo current-year
drift" failure). Deriving from data means the app un-blanks on its own with zero
visible UI change.

**Reconcile (`schoolYearFlip.ts reconcileSchoolYearFlip`) is idempotent + tx-based**
and ONLY mutates `school_settings.school_year_flip_active` + the
`student_fast_scores.is_historical` tag of the outgoing year. It NEVER touches
schedules/rosters/grades — those stay SIS-owned (RosterOne). Reversible: clear or
postpone the date and the outgoing year returns to current. Called on every
settings save and on boot (`reconcileAllSchoolYearFlips`, best-effort try/catch).

**Evaluate the date in the school's OWN timezone** (`getSchoolTimezone(schoolId)`
from `schoolYear.ts`), never a hardcoded `DEFAULT_SCHOOL_TZ`, or a school flips a
day early/late at the date boundary in multi-tz tenancy.

**Admin-only field in a whole-object PUT:** the client saves the entire
`schoolSettings` object; `school_year_flip_date` is admin/superuser-gated
server-side (403s non-admins when the key is present). The client **must strip the
field from the PUT body for non-admins** (destructure it out) or a Core Team save
of unrelated settings 403s on that one field. Admin-gated UI also renders only
after Aug 1 (`new Date().getMonth() >= 7`).
