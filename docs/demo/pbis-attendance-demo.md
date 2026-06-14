# Demo Script — PBIS + Attendance

Covers the positive-behavior system (Houses, Spotlight, Invisible Student,
Store) **and** attendance: the **On-Time "arrive-in-time" rewards** and tardy
logging.

## 1. The 30-second pitch

PulseEDU turns good behavior and on-time arrival into a **school-wide game**.
Students earn points that climb their **House** standings; staff give **Spotlight**
shout-outs; the system quietly flags any child who's gone **invisible** (no
recognition lately) so nobody slips through; and arriving on time literally
**pays off** — points for beating the bell, plus a daily **On-Time Lottery**.
Tardies are logged in two taps and the family hears about all of it in their
**weekly HeartBEAT**.

## 2. Who to log in as / what to open

- Drive as **Chris Clifford** (SuperUser, Parrott) for the admin + Core-Team views.
- Side screen: **Houses signage** → `…/signage/houses?schoolId=1`.
- Main screen: **PBIS Hub** (Recognition group in the nav).

## 3. One-time setup (admin)

- **Houses** exist (Falcon / Phoenix / Stag / Wolf) and students are sorted.
- A **default Bell Schedule** is set (this powers both on-time math and the
  tardy bell-gate).
- **Settings → Behavior & PBIS → On-Time Attendance & Lottery**: confirm
  **On-Time Attendance** and **Lottery** are ON, and note the lottery label
  (e.g. "Golden Ticket") and bonus points.

## 4. The live demo — step-by-step

**Scene 1 — Houses are alive.** On the signage, point to the four **House bars**
and the **action feed** ticking by. *"This is on every hallway TV."* If the feed
is quiet, hit **"Fire heartbeat"** to drop a fresh award. *"Standings update in
about 30 seconds — no refresh."*

**Scene 2 — Spotlight shout-out.** In the **PBIS Hub**, give a student a
**Spotlight** recognition. Watch it land at the **top** of the signage feed and
nudge that student's House. *"Any staff member can recognize any student in
seconds."*

**Scene 3 — The Invisible Student safety net.** Open **PBIS Hub → Needs
Attention**. *"These students have had **zero** recognitions inside their
window — they're becoming invisible."* Explain the window is **tier-aware**:
**8 / 5 / 3** school days for Tier 1 / 2 / 3, so higher-need kids surface
faster. *"The system finds the quiet kid the adults didn't notice."*

**Scene 4 — Arrive-in-time rewards (the on-time game).**
1. *"Students scan in at the classroom door. Beat the bell and you earn points —
   the **earlier** you arrive, the **more** you get."* (Post-bell grace = 1 pt.)
2. Open **Testing → Demo & time-travel tools**, set the **demo clock** just
   before a period start, and **Start test loop**. Scan a student in the
   passing window → points awarded live; a **tardy** in a counted period
   **resets their on-time streak**.
3. *"And once a day there's a draw."* Hit **Run lottery draw now** → a random
   eligible class wins, every on-time student gets the **bonus** (e.g. 25 pts),
   and it shows on the signage. *"Showing up on time pays — for you and your
   House."*

**Scene 5 — Tardies in two taps.** Open the **Create Pass** modal as Core Team
and check **"Log as tardy."** It logs the tardy **and** auto-addresses the pass
to the student's **current teacher of record** — and (stubbed) **texts the
parent**. Then show **Hall Passes → Tardy history** (read-only) for the trail.

**Scene 6 — The Store.** Show the two reward catalogs — **Classroom Store** and
the school-wide **School Store** — where students spend points. *"Points mean
something because they buy something."*

## 5. Talking points & objection handling

- **Sales:** one system for recognition, attendance, and early warning — fewer
  tools, more consistency.
- **Training:** the Invisible Student window is tier-aware and **must match** the
  Teacher Roster's flag — they use the same logic, so they never disagree.
- *"Is this just stickers?"* No — on-time points, lottery, and Houses tie to real
  attendance behavior, and every signal feeds Insights + the family HeartBEAT.

## 6. Weekly HeartBEAT tie-in

PBIS points, on-time streaks, and tardies **all** appear in the **Parent Portal**
and the **weekly HeartBEAT email**. Close with: *"So a parent opens one email
Friday and sees their child earned 40 points, kept a 9-day on-time streak, and
had one tardy Tuesday — without a single phone call."*

## 7. Quick reference

- Houses signage: `…/signage/houses?schoolId=1` · **Fire heartbeat** button
- PBIS Hub → **Needs Attention** (Invisible Student), **Spotlight**, **Store**
- Settings → **Behavior & PBIS → On-Time Attendance & Lottery**
- Testing → **Demo & time-travel tools**: demo clock, **Start test loop**,
  **Run lottery draw now**
- Tardy: **Create Pass → "Log as tardy"** (Core Team) · **Hall Passes → Tardy
  history**
