# PulseEDU Demo Run-Books

Presenter-ready scripts for demoing PulseEDU. Each file is **one feature
track** — what to say, **which account to log in as**, and **exactly which
screens, teachers, and student rows to point at**. Written to work for
**both** a sales pitch *and* internal staff onboarding.

> Format mirrors `docs/hall-pass-demo-runbook.md` (the full Hall Pass setup
> guide). The files here are the **demo scripts**; that runbook is the deep
> setup/equipment reference for the kiosk.

## The tracks

| # | Track | File | One-liner |
|---|-------|------|-----------|
| 1 | Hall Pass | [hall-pass-demo.md](hall-pass-demo.md) | Paperless self-serve passes + digital line. |
| 2 | PBIS + Attendance | [pbis-attendance-demo.md](pbis-attendance-demo.md) | Houses, Spotlight, Invisible Student, **On-Time "arrive-in-time" rewards**, tardies. |
| 3 | School Tours CRM | [school-tours-crm-demo.md](school-tours-crm-demo.md) | Full enrollment-lead pipeline **with owner accountability**. |
| 4 | AST | [ast-demo.md](ast-demo.md) | Staff time-bank ledger with admin-confirmed credits. |
| 5 | Teacher Roster (deep dive) | [teacher-roster-demo.md](teacher-roster-demo.md) | **The centerpiece** — the whole child on one screen. |
| 6 | Insights Hub | [insights-hub-demo.md](insights-hub-demo.md) | Six dashboards, filters, drill-down to the student. |
| 7 | HeartBEAT to families | [parent-heartbeat-demo.md](parent-heartbeat-demo.md) | The **weekly** family update, automatically. |

## The "weekly HeartBEAT to families" thread

This runs through **every** track. Almost everything you demo —
PBIS points, hall passes, tardies, on-time streaks, accommodations,
staff notes — flows into the **Parent Portal** and is mailed home as a
**Weekly HeartBEAT email** (a PDF snapshot). Whenever you land a feature,
add the one-line close: *"...and the family sees this in their weekly
HeartBEAT."* Track 7 shows the family side end-to-end.

---

## Shared setup (read once)

### The demo school
- **D. S. Parrott Middle** (`schoolId = 1`) has the richest seeded data —
  realistic FAST scores, accommodations, safety plans, PBIS history, tardies,
  tour leads. **Demo Parrott unless you have a reason not to.**

### Accounts to drive from (seeded demo credentials)
| Use it for | Name | Login | Password |
|---|---|---|---|
| Admin / Core-Team views (can switch schools) | **Chris Clifford** (SuperUser, Parrott) | `chris.clifford@hcsb.k12.fl.us` | `@Leopards` |
| **Hall Pass** demo (drive this teacher's room) | **Amy Brown** — Math G7 (Parrott) | `amy.brown@pulsedemo.com` | `PulseDemo26` |
| **Teacher Roster** deep-dive teacher | **Pamela Martin** — ELA G7 (Parrott) | `pamela.martin@pulsedemo.com` | `PulseDemo26` |
| Generic FAST teacher (fallback) | **Demo Teacher** (Parrott) | `demo.fast.teacher@dsparrott.test` | *(seed default)* |
| A second district/school | **Brandon Wright** (SuperUser, Springstead) | `brandon.wright@hcsb.k12.fl.us` | `@GoEagles` |
| Plain admin examples | Brad Merschbach / Ed LaRose / et al. | `…@hcsb.k12.fl.us` | `PulseDemo!` |

> **Featured teachers for this demo set** (per your setup): drive **Hall Pass**
> with **Amy Brown - Math G7** (her students' badges are printed) and the
> **Teacher Roster** deep-dive with **Pamela Martin - ELA G7**. Both are plain
> teachers at Parrott, so they also show the *teacher's-eye* (not admin) view.
> Either log in as them directly, or — to skip passwords and show off a feature
> — drive as **Chris Clifford** (Core Team) and open their roster via the
> teacher picker.

> These are **demo-seed** credentials (from `artifacts/api-server/src/seed.ts`),
> not real staff secrets. Use the **live published** domain for the demo, never
> the preview link.

### People to point at (Parrott)
- **Vivian Warren** — ESE (Specific Learning Disability), Hispanic. Great for
  accommodations + equity.
- **Gianna James** — ESE (Other Health Impaired).
- **Frankie Flynn** — Gifted. Good for the high-flyer / growth story.
- **Tristan Lawson** — clean baseline (no flags) for the "normal student" path.

> **Always read the on-screen ID as the local SIS ID.** PulseEDU never shows
> the state FLEID to anyone. If anyone asks "what's that long ID?" — it's
> internal-only and never displayed.

### The four Houses
**Falcon** (Blue) · **Phoenix** (Red) · **Stag** (Green) · **Wolf** (Purple).
Standings appear on the hallway signage at `…/signage/houses?schoolId=1`.

### Make the room feel alive
- Open `…/signage/houses?schoolId=1` on a side screen. The ambient
  **"heartbeat"** drip keeps the action feed moving during the bell window.
  Admins can force one with the **"Fire heartbeat"** button on that page.
- Signage and dashboards poll roughly every **30 seconds** — give them a beat
  to update after you do something.

### General presenter tips
- Navigate by **tile/nav label** (the app uses path-based screens; clicking is
  cleaner than typing URLs). Public URLs that *are* worth typing: `/kiosk`,
  `/parent`, `/tour/1`, `/signage/houses?schoolId=1`.
- If a feature screen is missing entirely, it's a **licensing/feature toggle**
  for that school — check the school's plan before blaming the build.
