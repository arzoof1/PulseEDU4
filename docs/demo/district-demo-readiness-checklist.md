# PulseEDU District Demo — Readiness Checklist

Run through this the day before and again 30 minutes before the demo. Demo data
was seeded earlier (`artifacts/api-server/src/seedDemoExtras.ts`); this verifies
it is present and the accounts work.

**Demo school:** D.S. Parrott Middle School (school_id 1)

---

## Accounts to have ready

- [ ] **Demo Admin** (id 598) — district/admin walkthrough + AST/Comp Time
      approver + PulseDNA + Insights + ticketing.
- [ ] **Amy Brown** — Math, Grade 7. Hall Pass teacher view + Teacher Roster.
- [ ] **Pamela Martin** — ELA, Grade 7. Small groups + accommodations.
- [ ] A **Counselor / Core Team** login that can open HeartBEAT + MTSS plans.
- [ ] A user with **`canManageTickets`** for Event Ticketing (Demo Admin works).
- [ ] A **parent/guardian portal login** (or staff "preview as parent") for the
      Family HeartBEAT slide, ideally a family with **two siblings** so the
      sibling switcher is demonstrable.
- [ ] Know each password / have sessions pre-logged-in on the demo device.

## Students to confirm (open each profile once)

- [ ] **Noah Xu** — flagged as an Invisible Student in HeartBEAT, with a real
      connection history.
- [ ] **Alina Maddox** — active Tier 3 **academic (ELA)** plan, ~2 months of
      entries.
- [ ] **Amelia Abbott** — active Tier 3 **academic (math)** plan, ~2 months.
- [ ] **Sienna Osborne** — active Tier 3 **academic (math)** plan, ~2 months.
- [ ] At least one student in **Amy Brown's** roster with a FAST learning-gain
      green-check and a visible ESE/504/ELL or safety flag.
- [ ] ~5 students with accommodations visible on **Pamela Martin's** roster.

## Data to confirm

- [ ] **Bell schedule** marked as default for school 1 (so the Hall Pass queue
      resets per period — see onboarding note in `replit.md`).
- [ ] A **destination at/near capacity** so the waiting-line + Go Now flow is
      demonstrable (or be ready to enqueue students at the kiosk live).
- [ ] **PBIS House Cup** has standings so the signage shows real numbers
      (`/signage/houses?schoolId=1`).
- [ ] **MTSS Tier 3** plans show multiple weekly entries from more than one staff
      member (the timeline, not a single point).
- [ ] **AST / Comp Time** has at least one request to walk through approval; EST
      Comp Time balance exists for **Teresa Holloway** (id 795).
- [ ] **PulseDNA** Communication DNA profile is saved for the school so generated
      copy is in the school's voice.
- [ ] **Family HeartBEAT / Parent Portal**: the demo family's child shows real
      hall passes/attendance, a **tardy with lost minutes**, FAST scores with
      next steps, an active intervention/accommodation, and at least one **sent
      family message to acknowledge**.
- [ ] **Insights**: Algebra performance view populated; a student profile opens
      from a chart drill-down.
- [ ] **FAST Coverage Report** populated for Grade 7.
- [ ] A **demo event** exists in Event Ticketing with a QR ticket you can scan
      (and re-scan to show the duplicate block).

## Devices & environment

- [ ] Demo device logged in to the staff app at `/` for school 1.
- [ ] A second device or the kiosk URL (`/kiosk`) for the Hall Pass demo.
- [ ] A phone/camera ready for the **ticket QR scan** (no-login scanner works).
- [ ] A screen/TV (or a browser tab) on `/signage/houses?schoolId=1` for signage.
- [ ] The deck open (PulseEDU District Demo) — `/allslides` for a quick walk, or
      `/slide1` to present in order.
- [ ] Test network: kiosk, signage, and scanner all reachable.

## Verify the deck itself

- [ ] `pnpm --filter @workspace/pulseedu-district-demo run validate-slides`
      passes (16 slides).
- [ ] Embedded screenshots load on slides 3, 4, and 15.
- [ ] Walk slides 1 → 16 once; confirm each fits the 16:9 frame.

## Supporting docs

- [ ] `district-demo-script.md` — presenter talking points, in hand.
- [ ] `district-demo-shot-list.md` — which gated screens to capture/demo live.
