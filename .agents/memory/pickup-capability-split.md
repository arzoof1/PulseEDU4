---
name: Pickup capability split (curb monitor vs tag management)
description: Two distinct pickup caps and the matrix-UI gap that forced Admin-only access
---

# Pickup/dismissal has TWO separate capabilities — keep them distinct

- **`capCarRiderMonitor`** ("Curb / Walker Monitor") → gated by `canRunCurb()`
  (PickupApp.tsx + routes/pickup.ts). Runs `/pickup/curb` + `/pickup/walkers` ONLY.
  No tag CRUD; does NOT show the "Parent Pickup" sidebar item.
- **`capManageDismissal`** ("Set Dismissal Mode") → part of `canManagePickup()`
  (lib/coreTeam.ts, also admits Core Team / counselor / `canApproveAst`). Gates ALL
  tag management: create / reprint(reissue) / school-wide bulk-assign / PDFs /
  the Parent Pickup panel.

**The trap:** `capCarRiderMonitor` existed everywhere (DB column via
`ensurePickupSchema()`, `/me` payload, adminStaff PATCH whitelist, both gates) but
was MISSING from the `PAGES` array in `StaffRolesMatrix.tsx`, so it had no checkbox
— the only way to grant curb access through the UI was full Admin, which over-grants
tag tools. **Lesson:** a capability with no row in the matrix `PAGES` array is
ungrantable except via Admin; when adding a server cap, also add its matrix checkbox.

**Why it matters:** the school-wide "Assign pickup numbers" (bulk-assign) action can
upgrade legacy letterless codes (1026 → 1026A), changing distributed tags. Curb staff
must never have tag access. Destructive pickup actions use inline two-step modals
(checkbox + typed word for bulk-assign), NOT `window.confirm` — the preview iframe
silently suppresses native dialogs so confirm() no-ops and the action fires unguarded.
