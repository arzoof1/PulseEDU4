# Hall Pass Demo Run-Book

A complete, presenter-ready guide for demoing the **Hall Pass Kiosk** to a
school: what to print, the equipment you need, one-time setup, and a
step-by-step script for running a live demo classroom with a working kiosk.

---

## 1. What you're demoing (the 30-second pitch)

A tablet by the classroom door becomes a **self-serve hall pass kiosk**.
A student taps their ID, picks where they're going, and walks out — no paper
slip, no teacher interruption. If too many students are already out (cap of 5),
or two students who shouldn't be in the hall together try to leave, the kiosk
**holds them in a digital line** and calls them up when it's their turn. The
teacher watches the whole thing from a small panel in the app, and the front
office can see every active pass on a hallway TV.

The "wow" moments to land in the demo:
1. **Tap-and-go** sign out with a destination.
2. **"I'm Back"** return that automatically calls the **next student in line**.
3. The **keep-apart block** (two students can't be out together).
4. The **period reset** — the line clears itself when the bell rings.

---

## 2. Equipment checklist

| # | Item | Purpose | Notes |
|---|------|---------|-------|
| 1 | **Tablet or laptop** (the "kiosk") | Runs `/kiosk` by the door | iPad / Android tablet / Chromebook all work. A stand or case is a nice touch. |
| 2 | **Camera on that device** | Scan activation card + student badges | Built-in webcam/front camera is fine. Needed if you want to demo QR scanning. |
| 3 | **A second device** (phone or laptop) | The **teacher view** — logged into the app | This is the presenter's "control panel." |
| 4 | *(Optional)* **A TV or monitor** | Hallway **Active Hall Pass** signage | Any screen that can open a browser, or a real signage TV. |
| 5 | *(Optional)* **A printer** | Print the activation card + student badges | Color not required; QR codes scan fine in black & white. |
| 6 | **Reliable Wi-Fi** | All devices need the app | Test the network in the demo room ahead of time. |
| 7 | **The app URL** | e.g. `https://<your-app-domain>/` | Use your **live published** domain, not the preview link. |

> Minimum viable demo = **2 devices** (one kiosk tablet + one teacher phone)
> on Wi-Fi. Everything else is polish.

---

## 3. What to print

Print these **before** demo day. All are generated from inside the app
(admin login required).

### A. Kiosk Activation Card (1 page) — **required**
- **What it is:** A single sheet for the demo room with the room name, teacher
  name, a **QR code**, a **barcode**, and a **6-digit PIN**.
- **Why:** It's how you turn a blank tablet into *this room's* kiosk in seconds.
- **Where to get it:** Admin → **Settings** → **Kiosk Cards** panel → generate /
  download the cards PDF, then print the page for your demo room.

### B. Student ID Badges (1 per demo student) — **recommended**
- **What it is:** A badge/card per student with a **QR code** that signs that
  student into the kiosk instantly.
- **Why:** Tapping a card on the camera is far more impressive than typing an ID.
- **Where to get it:** Admin → **Settings** → **Student Badges** panel → print
  badges for the 2–3 students you'll use in the demo.

### C. *(Optional)* A printed "cheat sheet" for the presenter
- The student IDs/names you'll use, in order, plus the demo script (Section 6).
- Keep it in your hand or taped to the back of the teacher device.

> **No per-pass paper.** The system is intentionally paperless for the passes
> themselves — that's part of the value. The only printing is the one-time
> activation card and the reusable student badges.

---

## 4. One-time setup (admin, ~15 minutes)

Do this once, ahead of demo day, signed in as an **admin / Core Team** user.
Each step below has to be done in order, because each one unlocks the next.

1. **Turn the feature on (licensing).**
   The school's plan must include **Hall Passes**. If the Hall Pass screens are
   missing entirely, this is the cause — confirm `hallPasses` is enabled for the
   school's license before anything else.

2. **Enable the Hall Pass toggle.**
   **Settings → School Settings** → switch the **Hall Pass** feature **ON**.

3. **Set a default Bell Schedule.** *(This is the important one — see the
   prerequisite note in the project README.)*
   **Settings → Bell Schedules** → create or pick a schedule and mark it the
   **default**. This is what makes the line **auto-clear when the period
   changes**, giving each class a clean line. Without it, the queue falls back to
   a 45-minute idle timer — usable, but you lose the "bell rings, line resets"
   demo moment.

4. **Configure Locations (rooms + destinations).**
   **Settings → Locations**:
   - Add your **demo room** as an **origin** (kiosk-visible).
   - Add a few **destinations**: Restroom, Nurse, Front Office, Water.
   - Create the **allowed destination** pairs so the demo room can reach those
     destinations.
   - Shortcut for a demo: use **"Wire all classrooms"** to auto-create a full
     mesh of room→destination pairings, so you don't hand-build them.

5. **Pick your demo students and (optionally) create a conflict.**
   - Choose **2–3 students** from the roster and note their **student IDs**
     (you'll type these, or scan their badges).
   - To demo the **keep-apart block**, flag **two of them as keep-apart**
     (a "polarity"/keep-apart pair) so the kiosk refuses to let them both be out
     at once.
   - *(Optional)* Set a **daily limit** on one student to demo the
     "you've hit your limit" message.

6. **Smoke-test it yourself** once, end to end (Section 6), the day before.

---

## 5. Activating the kiosk (do this ~10 min before you present)

Pick **one** of these to turn the demo tablet into the room's kiosk:

- **Scan the card (best for the demo):** On the tablet open `…/kiosk`, choose
  **"Use this camera,"** and hold the printed **Activation Card** up to it.
- **Type the PIN:** On `…/kiosk`, enter the **6-digit PIN** from the card.
- **Phone hand-off:** Scan the card's QR with your phone, it opens
  `…/kiosk?enroll=<token>`; or, as admin, use **"Activate sub"** to open the
  tablet pre-activated.
- **Fallback:** Sign in with a staff email + password on the tablet.

Once activated, the tablet **remembers** it's this room's kiosk (stored on the
device) — you won't have to log in again during the demo. Leave it on the
sign-in screen.

> **Optional second screen:** open the **Phone View** mirror at
> `…/kiosk-view/<token>` on a phone or the TV — it shows the same live line
> read-only, great for the audience to watch while you drive the kiosk.

---

## 6. The live demo — step-by-step presenter script

> Setup in the room: **Kiosk tablet** on a stand by the "door." **Teacher
> device** in your hand showing the **Companion Queue** panel. *(Optional)* **TV**
> showing the active-pass board or the Phone View mirror.

**Scene 1 — A normal hall pass (the happy path)**
1. "Imagine I'm a student who needs the restroom." On the **kiosk**, scan
   Student A's **badge** (or type their ID) and tap **Out**.
2. Pick **Restroom** from the destination list. → The kiosk confirms they're out.
3. Hold up your **teacher device**: "From here I can see exactly who's out, where
   they went, and for how long — without stopping my lesson." Point to the live
   timer.

**Scene 2 — The line forms (capacity cap)**
4. Sign out a couple more students the same way until you approach the cap.
   "The system only allows **5 students out at once** — no hallway hangouts."
5. Try to send **one more** student out. → The kiosk puts them in the
   **waiting line** instead of issuing a pass. "They're not denied — they're
   queued."

**Scene 3 — Keep-apart safety block**
6. With Student A still out, have **Student B (the keep-apart pair)** try to go
   **Out**. → The kiosk **blocks** it with a keep-apart message. "Admin decided
   these two shouldn't be in the hall together — the kiosk enforces it
   automatically, so staff don't have to remember."

**Scene 4 — Return calls the next student**
7. Bring **Student A** back: on the kiosk, scan their badge and tap **"I'm Back."**
8. → The kiosk immediately shows a **"Next Up"** prompt for the first eligible
   student in line. "The moment a spot opens, the next student is called — the
   line manages itself."
9. On the **teacher device**, show that you can **reorder** or **remove** anyone
   in the line by hand if you need to.

**Scene 5 — The bell resets the line**
10. "When the period ends, nobody carries over." Explain that at the **bell**
    (per the default bell schedule) the line **wipes clean** so the next class
    starts fresh. *(If you want to show it live, set the demo bell schedule so a
    period boundary falls during your session.)*

**Scene 6 — The hallway view (optional)**
11. Point to the **TV**: "Meanwhile the front office sees every active pass
    building-wide on the hallway display." Show the active-pass board or the
    Phone View mirror updating in real time.

**Close:** "Paperless, safer, and the teacher never stops teaching."

---

## 7. Pre-flight checklist (morning of)

- [ ] All devices on the demo Wi-Fi, app loads on each.
- [ ] Kiosk tablet **activated** to the demo room (sign-in screen showing).
- [ ] Teacher device logged in, **Companion Queue** panel open.
- [ ] 2–3 student **badges** printed and in hand (or IDs on your cheat sheet).
- [ ] Keep-apart pair confirmed; one daily limit set (if demoing that).
- [ ] Destinations show up on the kiosk for the demo room.
- [ ] *(Optional)* TV showing the active-pass board / Phone View.
- [ ] You've run the full script once successfully.

---

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Hall Pass screens missing in the app | Licensing `hallPasses` off, or School Settings toggle off | Enable licensing, then **Settings → School Settings → Hall Pass ON** |
| Kiosk won't activate from the card | Camera permission blocked, or card expired | Allow camera in the browser; regenerate the card; or use the **6-digit PIN** |
| No destinations appear on the kiosk | Locations/allowed pairs not set for the room | **Settings → Locations** → add destinations + allowed pairs (or "Wire all classrooms") |
| Line doesn't reset between classes | No **default bell schedule** | **Settings → Bell Schedules** → mark one as default |
| Student "can't sign out" unexpectedly | Keep-apart pair or daily limit hit | Expected — that's the safety feature; explain it, or clear the flag |
| Kiosk logged itself out | Device cleared its storage / token expired | Re-activate with the card or PIN |
| QR scan won't read | Glare or low light on the printed code | Tilt the card, improve lighting, or type the ID/PIN |

---

## 9. Quick URL reference

> Replace `<your-app-domain>` with your **live published** domain.

- **Kiosk (student-facing):** `https://<your-app-domain>/kiosk`
- **Activate from card QR:** `https://<your-app-domain>/kiosk?enroll=<token>` *(card generates this)*
- **Student badge auto-sign-in:** `https://<your-app-domain>/kiosk?signin=<studentId>` *(badge generates this)*
- **Phone View (read-only line mirror):** `https://<your-app-domain>/kiosk-view/<token>`
- **Teacher control:** sign into the app → **Companion Queue** panel
- **Print activation cards:** Admin → **Settings → Kiosk Cards**
- **Print student badges:** Admin → **Settings → Student Badges**
