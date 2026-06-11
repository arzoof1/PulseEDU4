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
