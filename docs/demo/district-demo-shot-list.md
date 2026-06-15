# PulseEDU District Demo — Screenshot Shot-List

Two kinds of screens in this demo:

1. **PUBLIC surfaces** — already auto-captured and embedded in the deck. Listed
   here for reference; nothing to do.
2. **LOGIN-GATED surfaces** — cannot be auto-captured (they require an
   authenticated session). Capture these live in the running app before the
   demo, or simply demo them live. Each entry gives the exact route, the account
   to log in as, the setup, and what to frame.

All student IDs shown on screen must be the **local SIS ID**, never the FLEID —
this is enforced in-app, but double-check any export you take.

---

## Already captured (PUBLIC — embedded in deck)

| File | Route | Slide | What it shows |
|---|---|---|---|
| `public/shots/kiosk.jpg` | `/kiosk` | 3 | Door kiosk activation screen |
| `public/shots/tour.jpg` | `/tour/1` | 4 | D.S. Parrott public tour page |
| `public/shots/signage-houses.jpg` | `/signage/houses?schoolId=1` | 15 | Live PBIS House Cup signage |
| `public/shots/signage-heartbeat.jpg` | `/signage/heartbeat?schoolId=1` | (spare) | Today's Heartbeat signage |

> Note: `signage-heartbeat.jpg` showed an "all quiet" empty feed at capture time;
> it was intentionally left out of the deck. Recapture it during a period with
> live mood events if you want to use it.

---

## To capture live (LOGIN-GATED)

Log in to the staff app at `/` for D.S. Parrott Middle (school_id 1) unless noted.

### Slide 3 — Hall Pass teacher view
- **Account:** Amy Brown (or any teacher with kiosk access in her room)
- **Setup:** Have a student in the waiting queue (use the kiosk to enqueue one).
- **Frame:** The Companion Queue panel with a waiting student and the **Go Now**
  control; then the active pass with its live timer.

### Slide 5 — Teacher Roster
- **Account:** Amy Brown (Math, Grade 7) — or Core Team viewing her roster
- **Frame:** The roster grid showing FAST benchmark columns (color-coded),
  bottom-standards, and the ESE/504/ELL + safety-plan flags. Include the
  learning-gain green-check on at least one student.

### Slide 6 — Small Groups & Accommodations
- **Account:** Pamela Martin (ELA, Grade 7)
- **Frame (a):** The small-group builder with students grouped by a shared weak
  standard, plus a logged support session in the history.
- **Frame (b):** The accommodations view listing required supports for ~5
  students.

### Slide 7 — HeartBEAT / Invisible Student
- **Account:** Counselor, Core Team, or admin
- **Setup:** Open student **Noah Xu**.
- **Frame:** The invisible-student flag on his profile and the connection-history
  panel that drove the flag. Emotional, clean — one student, full context.

### Slide 8 — MTSS Tier 3 plans
- **Account:** MTSS coordinator / Core Team
- **Setup:** Open a Tier 3 academic plan for **Alina Maddox (ELA)**, **Amelia
  Abbott (math)**, or **Sienna Osborne (math)**.
- **Frame:** The plan timeline showing ~2 months: multiple weekly entries,
  multiple staff, progress monitoring. Capture the timeline, not a single entry.

### Slide 9 — AST & Comp Time
- **Account:** Demo Admin (id 598) for the approver view
- **Setup:** Have one request at each stage if possible.
- **Frame:** The five-step workflow (submit → approve → complete → verify →
  bank), and the EST Comp Time balance for **Teresa Holloway (id 795)**.

### Slide 10 — PulseDNA AI (the wow shot)
- **Account:** Core Team / admin with PulseDNA access
- **Setup:** Communication DNA profile already saved for the school.
- **Frame:** The rough-idea input ("Volleyball team won tonight. Great crowd.
  Proud of our kids.") and the three generated outputs side by side (family
  message, social post, teleprompter script). If demoing before/after, also
  capture a generic vs. DNA-trained comparison.

### Slide 11 — Family HeartBEAT / Parent Portal
- **Account:** A parent/guardian portal login (or staff "preview as parent").
- **Setup:** A student with real activity — hall passes, a tardy with lost
  minutes, FAST scores, an active intervention/accommodation, and a sent
  family message.
- **Frame (a):** The portal home for one child showing daily activity, tardies
  / lost instructional time, FAST scores with next steps, and interventions /
  accommodations.
- **Frame (b):** A school message with the **acknowledge ("Got it") tap**, plus
  the **sibling switcher** and the **PDF export** control.

### Slide 12 — Insights Hub
- **Account:** Admin / Core Team
- **Frame (a):** The Algebra performance / readiness view.
- **Frame (b):** A chart drilled down into an individual student profile (proves
  it's actionable, not just a dashboard).

### Slide 13 — FAST Coverage Report
- **Account:** Admin / Core Team
- **Frame:** The coverage report for Grade 7 — standards analyzed, % curriculum
  taught, and the instructional-gaps section.

### Slide 14 — Event Ticketing
- **Account:** A user with `canManageTickets`
- **Setup:** The seeded demo event (see readiness checklist).
- **Frame (a):** The event creation screen with per-grade quotas.
- **Frame (b):** A QR ticket, and the scan screen showing a **duplicate-scan
  rejection** on a second scan of the same ticket.

---

## Capture tips
- Use a 16:9 viewport (1280×720 or 1920×1080) so shots drop cleanly into the
  16:9 slides.
- Hide any browser chrome / dev banners.
- If you save new shots into `artifacts/pulseedu-district-demo/public/shots/`,
  reference them in a slide via `${import.meta.env.BASE_URL}shots/<file>` and
  re-run `pnpm --filter @workspace/pulseedu-district-demo run validate-slides`.
