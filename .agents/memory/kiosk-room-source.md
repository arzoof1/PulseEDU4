---
name: Kiosk room source & bulk room assignment
description: Where Hall Pass kiosk room values come from and how the bulk teacher->room importer must match/validate.
---

# Kiosk room source

The master schedule (`class_sections`) has NO room column. The room a kiosk
shows for a teacher comes from the **teacher record**
(`staff_defaults.default_location_name`, falling back to `staff.default_room`),
never from the schedule. Any "populate rooms" feature must write to
`staff_defaults`, not invent a schedule-derived room.

**Why:** the SIS roster export the schools use doesn't carry a reliable room
per section; rooms are a teacher attribute in this product.

# Bulk teacher->room import rules

When matching free-text teacher identifiers (CSV import) to staff within a
school:

- **Email match is safe** (unique within school). Prefer it.
- **Display-name match is NOT safe** — display names are not unique within a
  school. Treat a name that resolves to >1 active staff as **ambiguous =
  unmatched**, never silently pick one. (Build a collision set while indexing.)
- Validate the room against active **origin** locations
  (`locations.isOrigin && active`); blank/`none`/`roaming`/`n/a` clears the room
  (roaming).
- Client CSV parse must strip a leading UTF-8 BOM (`\uFEFF`) before reading the
  header row, or Excel/Sheets exports fail teacher-column detection.

**How to apply:** dedicated `POST /api/staff-defaults/bulk` (admin-gated,
school-scoped, dry-run via `commit:false`) is the chosen path — deliberately NOT
the generic student-centric data importer (its snapshot/rollback machinery is
overkill and student-shaped). Room dropdowns everywhere are fed from active
origin locations; keep any legacy off-list value selectable so an existing room
is never silently dropped.

# Activation requires the room to exist as an origin location

A teacher's saved room (`staff_defaults.default_location_name` / free-text
`staff.default_room`) is NOT constrained to the `locations` list, so the two can
diverge. Kiosk activation rejects any room that isn't an **active origin
location** for that school ("… is not a valid kiosk room"), regardless of which
sign-in method resolved it — so resolution parity is necessary but not
sufficient; the resolved name must also exist as an origin location.

**Why:** free-text room entry (admin staff editor / roster import) can name a
room that was never set up as a location. The product decision is that kiosks
NEVER invent rooms on their own; valid rooms mirror the source of truth
(admin-curated locations today, the future ClassLink/SIS sync later).

**How to apply:** if teachers are blocked at activation, check for staff rooms
with no matching active origin location before assuming a code bug — it is
usually a data/setup gap. Repair demo gaps with a school-scoped, marker-guarded
boot one-shot that creates the missing origin (name verbatim) + wires LAD pairs;
do NOT auto-provision from rooms generally (that behavior is deferred to
ClassLink).
