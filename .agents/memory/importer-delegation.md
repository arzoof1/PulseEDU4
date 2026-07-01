---
name: Delegable data importers
description: How the 4 assignable importer caps are gated server-side and why client filtering is not the enforcement point.
---

# Delegable data importers

Four assignable staff caps (`staff.capImportGrades/Attendance/Fast/Iready`,
default FALSE) let Admin OR Core Team hand a single importer to a non-admin
clerk without granting admin.

**Rule:** importer authorization is enforced at EACH server route, never by the
client.
- Import KINDS (gradebook/fast_*/assessments) map to caps via `scope.ts`
  `SCHOOL_IMPORT_KIND_CAP`; `canImportKind` / `allowedSchoolImportKinds` gate
  EVERY `dataImports.ts` surface (preview, commit, jobs list, export, rollback,
  templates), not just upload.
- Attendance is SEPARATE — it lives on the eligibility route, gated by
  `requireAttendanceImporter` on BOTH the upload and the uploads-history GET.
- `adminStaff.ts` admits Core Team into GET/PATCH staff but STRIPS the PATCH
  body down to only the 4 import caps for non-full-authority actors, so a
  crafted PATCH can't touch roles or other caps (privilege escalation guard).

**Why:** client surfaces (DataImports `allowedKinds`, StaffRolesMatrix
import-only mode, the `importData` nav gate) are UX only and bypassable via
direct API calls. The PATCH field-strip is the load-bearing anti-escalation
control.

**How to apply:** any NEW import surface or any new staff-cap delegation must
add its own server gate through the shared `canImportKind` /
`requireAttendanceImporter`; adding it to the client filter alone is a security
hole. District imports stay admin/SuperUser (school-scoped caps never reach
district paths).
