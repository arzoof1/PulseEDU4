---
name: Shared TeacherPicker
description: The single component every teacher-chooser dropdown should use across the client
---

`artifacts/client/src/components/TeacherPicker.tsx` is the one searchable,
department-grouped, color-tinted teacher dropdown. Backed by
`teacherDepartments.ts` (TeacherOpt, DEPARTMENT_ORDER, DEPARTMENT_TINTS,
deptOf/tintFor/presentDepartments).

**Contract:** `value: number | null`, `onChange: (id: number | null) => void`,
optional `allowEmpty`/`emptyLabel`, `showDeptFilter`, `disabled`,
`selectStyle`, `style`, `id`, `ariaLabel`. The selected teacher always stays
visible even when filtered out.

**How to apply:** when adding/replacing any teacher chooser, use this
component, not a hand-rolled `<select>`. Lists shaped `{id, name}` adapt
inline to `{id, displayName: name}`. Lists shaped `{id, displayName,
department}` pass straight through (showDeptFilter gives the grouped/tinted
UX). Without `allowEmpty` the native select auto-selects the first option —
match the old behavior when migrating.

**Why:** keeps grouping/tints/search identical everywhere instead of N
divergent dropdowns. Note Safari ignores `<option>` backgroundColor; grouping
via `<optgroup>` still works.
