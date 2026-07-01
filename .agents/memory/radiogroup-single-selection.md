---
name: One radiogroup per single selection
description: Accessibility rule for splitting a single-choice radio list into visual groups
---

When you visually group a single-choice list (one selected value across the whole
list) into sections, keep exactly ONE `role="radiogroup"` wrapping all the radios.
Render the section headings as presentational text.

**Why:** giving each visual section its own `role="radiogroup"` tells assistive tech
there are multiple independent radio questions, but the underlying state is a single
global choice — contradictory semantics that a screen reader announces as several
separate questions when only one selection is possible. Flagged in code review of the
DataImports step-0 "Choose data" picker.

**How to apply:** any time you break a radio list into labeled groups for layout,
wrap the whole thing in a single `radiogroup` and make the group titles plain text
(no per-group `role="radiogroup"`). Same idea applies to a single `listbox` split
into visual optgroup-style sections.
