---
name: Teacher Roster layout preference
description: User rejected redesigns of the roster row layout — keep the original single-line, full-word-button structure.
---

The Teacher Roster's original row structure (photo/name/ID, status pills and full-word action buttons flowing on one line, separate Programs column) is the layout the user wants.

**Why:** Two redesigns were built and explicitly rejected (Aug 2026): (1) a stacked two-line row ("not what I expected"), and (2) a compact layout with fixed pill slots, merged Programs column, and icon-only two-letter round buttons ("so cryptic... go back to the original structure"). An intermediate "dedicated Actions column" also failed to satisfy. All were reverted via `git show <pre-change-commit>:...TeacherRosterPage.tsx`.

**How to apply:** Do not re-propose stacked rows, icon-only/abbreviated buttons, fixed pill slots, or removing the Programs column. If asked to save roster space again, prefer minimal tweaks (padding, font size) and mock up in a picture FIRST — the user judges layouts visually and rejects after building otherwise. Keep buttons labeled with full words.
