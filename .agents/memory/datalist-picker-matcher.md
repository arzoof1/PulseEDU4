---
name: Datalist picker matcher must mirror the option value
description: In the staff client, text-input + <datalist> student/entity pickers resolve the selected id in onChange by string-matching against the rendered <option> value — if the matcher and the option value disagree, selection silently fails and downstream submit buttons stay disabled.
---

The staff app (`artifacts/client/src/App.tsx`) has many pickers built as a text
`<input list="...">` + `<datalist>` rather than a `<select>`. There is no real
"selected option" event — the input just gets the option's **value string**, and
an `onChange` handler must re-derive the canonical id (e.g. `studentId`) by
string-matching that value back against the list.

**Rule:** the `onChange` matcher string MUST be byte-for-byte identical to the
`<option value={...}>` template it renders. If they drift, picking from the
dropdown sets the canonical id to `""`, and any control gated on that id (submit
buttons with `disabled={... || !studentId}`) is **permanently disabled** with no
error shown — the user "picks a student" but the button never enables.

**Why:** the Request Pullout regression — the option value was switched to show
`localSisId` (`${first} ${last} (${localSisId ?? "—"})`) but the matcher still
compared against the old `studentId`-based label, so selecting a student never
populated `studentId` and "Submit pullout request" stayed disabled forever.

**How to apply:**
- When you change a datalist `<option value=...>`, update the sibling `onChange`
  matcher in lockstep (and vice-versa).
- Prefer matching the exact rendered label, plus accepting a raw id typed
  directly; if you accept a secondary key (e.g. `localSisId`), also add that key
  to the search-filter predicate so typed entries surface in the dropdown.
- Beware ambiguity: `find()` takes the first match, so non-unique labels (e.g.
  `localSisId` null → "—") can resolve to the wrong record. Include a stable
  unique token in the value when collisions are possible.
