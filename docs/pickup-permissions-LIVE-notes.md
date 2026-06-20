# Developer Notes — Pickup/Dismissal Permission Split → LIVE

**Date added:** June 20, 2026
**Scope of this change set:** **CLIENT-ONLY.** Two frontend files. **No database
migration, no server/route changes, no new environment variables.**

> ⚠️ Production is a separate host (`pulseedu.pulsekinetics.us`) with its own DB.
> Nothing here needs to touch that DB — see §3.

---

## 1. What changed today (and why)

A new staff user could not open the curb/dismissal URLs, and the only way to grant
access was to make them a full **Admin** — which dangerously also exposed the
school-wide pickup-tag tools (including a button that can change every family's
pickup number). Two fixes:

### A. Exposed the existing curb-monitor capability in the UI
- **File:** `artifacts/client/src/components/StaffRolesMatrix.tsx`
- Added one row to the `PAGES` array: a **"Curb / Walker Monitor"** checkbox under
  the **Administration** group, mapping to the `capCarRiderMonitor` capability.
- This capability **already existed** end-to-end (DB column, `/me` login payload,
  admin-staff PATCH whitelist, and both client + server gates) — it simply had **no
  checkbox** in the editor, so it could never be granted without Admin.

### B. Iframe-safe two-step confirmations on destructive tag actions
- **File:** `artifacts/client/src/components/PickupTagsPanel.tsx`
- Replaced two `window.confirm()` calls with inline modal confirmations.
  **Why:** the Replit preview iframe silently suppresses native `confirm()`/`alert()`
  dialogs, so the old guard never appeared and the destructive action fired with no
  warning at all.
  - **School-wide "Assign pickup numbers"** now requires **both** an "I understand"
    checkbox **and** typing **`ASSIGN`** before the action enables.
  - **Per-tag "Reprint (new #)"** now requires an "I understand" checkbox before the
    action enables.

---

## 2. The permission model (for the admin who provisions staff)

Two **separate** capabilities — keep them distinct:

| Checkbox in Staff & Roles | Capability | Grants |
| --- | --- | --- |
| **Curb / Walker Monitor** | `capCarRiderMonitor` | Run `/pickup/curb` + `/pickup/walkers` **only**. No tag CRUD. Does **not** show the "Parent Pickup" sidebar item. |
| **Set Dismissal Mode** | `capManageDismissal` | Front-office tag management: create / reprint / school-wide assign + the Parent Pickup panel. |

- A generic curb monitor → check **Curb / Walker Monitor** only. Leave **Set Dismissal
  Mode** unchecked.
- Front office → **Set Dismissal Mode** (and optionally Curb / Walker Monitor too).
- Admin / Core Team / Counselor roles already satisfy both gates.

Server enforcement is unchanged and authoritative: `canRunCurb()` gates the curb/walker
endpoints; `canManagePickup()` gates every tag/bulk/reissue/PDF endpoint. The client
checkboxes only mirror these.

---

## 3. Deploy procedure (LIVE)

1. **Pull/merge** these two client files into the production build source.
2. **Build the client** (`pnpm run build`, or your prod client build).
3. **Deploy the client bundle.**
4. **No DB step required.** The `cap_car_rider_monitor` column was already created in
   production by the existing `ensurePickupSchema()` boot migration when the pickup
   module first shipped. (If you want to confirm: `\d students` should show
   `cap_car_rider_monitor BOOLEAN NOT NULL DEFAULT false`. If somehow missing, just
   restart the API server — `ensurePickupSchema()` re-applies it idempotently at boot.)
5. **No server/route changes** in this change set, so the API server does not need a
   code redeploy for this feature — but a normal full deploy is fine.
6. **No new environment variables.**

---

## 4. Post-deploy verification

- [ ] In **Staff & Roles → Edit access**, the **Administration** group shows a new
      **"Curb / Walker Monitor"** checkbox.
- [ ] A staff member with **only** Curb / Walker Monitor can open `/pickup/curb` and
      `/pickup/walkers`, and **cannot** see the "Parent Pickup" sidebar item / tag tools.
- [ ] On the Parent Pickup panel, **"Assign pickup numbers"** opens a warning modal; the
      red confirm button stays disabled until the checkbox is ticked **and** `ASSIGN`
      is typed.
- [ ] **"Reprint (new #)"** opens a warning modal; the red confirm button stays disabled
      until the checkbox is ticked.

---

## 5. Provisioning fix for existing staff

Any curb monitor who was previously given **"Set Dismissal Mode"** (a workaround) should
be switched to **"Curb / Walker Monitor"** with **Set Dismissal Mode unchecked**, unless
they genuinely also run the front-office tag desk. Have them sign out/in afterward so the
login payload refreshes.
