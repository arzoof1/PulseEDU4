# Demo Script — Hall Pass

> **Full setup, equipment, and printing guide:** see
> [`../hall-pass-demo-runbook.md`](../hall-pass-demo-runbook.md). This file is
> the **short live script**; that runbook is the deep reference.

## 1. The 30-second pitch

A tablet by the door becomes a **self-serve hall pass kiosk**. A student taps
their ID, picks a destination, and goes — no paper, no interrupting the teacher.
If too many students are already out (cap of **5**), or two students who
shouldn't be in the hall together both try to leave, the kiosk **holds them in
a digital line** and calls them up in turn. The teacher watches from a small
panel; the front office sees every active pass on a hallway TV.

## 2. Who to log in as / what to open

- **Kiosk tablet:** open `…/kiosk`, activated to **Amy Brown's Math G7 room**.
- **Teacher device (your control panel):** log in as **Amy Brown**
  (`amy.brown@pulsedemo.com` / `PulseDemo26`) and open the **Companion Queue**
  panel. *(Or drive as Chris Clifford and view her room.)*
- **Student badges (printed):** Amy Brown's class — e.g. **Bryce Baxter**,
  **Evelyn Callahan**, **Olivia Daniels**, **Mason Donovan**, **Serena Hayes**.
- *(Optional)* **Hallway TV:** the read-only line mirror `…/kiosk-view/<token>`.

> Set up the **keep-apart pair** ahead of time (Section 5 of the full runbook).
> For this script, **Evelyn Callahan** + **Olivia Daniels** are the pair.

## 3. The live demo — step-by-step

1. **Happy path.** On the kiosk, scan **Bryce Baxter**'s badge → pick
   **Restroom** → "Out." On the teacher device, point to the **live timer**:
   *"I see who's out, where, and for how long — without stopping the lesson."*
2. **The line forms.** Sign out **Mason Donovan** and **Serena Hayes** the same
   way until you hit the cap of 5. Send one more → they're **queued**, not denied.
3. **Keep-apart block.** With **Evelyn Callahan** out, have **Olivia Daniels**
   try to leave → kiosk **blocks** it. *"Admin decided these two shouldn't share
   the hall — enforced automatically."*
4. **Return calls the next student.** Bring **Bryce Baxter** back ("I'm Back") →
   kiosk shows **"Next Up"** for the first eligible student in line.
5. **Bell reset.** *"At the bell, the line wipes clean so the next class starts
   fresh."*

## 4. Talking points

- **Sales:** safer halls, paperless, zero teacher interruption, front-office
  visibility on one screen.
- **Training:** the cap, keep-apart pairs, and daily limits are **admin
  policy** enforced by the kiosk — staff don't have to remember the rules.

## 5. Weekly HeartBEAT tie-in

Every pass a student takes shows up in their **Parent Portal** and rolls into
the **weekly HeartBEAT email** home. *"Families see their child's hall-pass
activity each week — no surprises."*

## 6. Quick reference

- Kiosk: `…/kiosk` · Phone mirror: `…/kiosk-view/<token>`
- Teacher control: **Companion Queue** panel
- Full setup/printing: `../hall-pass-demo-runbook.md`
