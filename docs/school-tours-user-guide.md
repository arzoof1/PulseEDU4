# PulseEDU School Tours — User Guide for Schools

A complete, step-by-step guide to running enrollment tours in PulseEDU, from the
moment a family first hears about your school to the day they enroll. This guide
covers **every feature** and is written for **every person who touches a tour**:

- **Families** (prospective parents) — request a tour, take the tour, give feedback
- **Front Office / Enrollment Lead** — manage the pipeline, schedule, follow up, report
- **Tour Guide** — run the live walk on a phone, capture timings and notes
- **Administrator** — set up the brag page, checkpoints, branding, roles, and settings

> **Where to find it:** Tours live under **Settings → 📋 School Tours**. When new
> requests come in, a red **🔔 _N_ new tour requests** banner also links straight in.

---

## Table of contents

1. [The big picture — how a tour flows](#1-the-big-picture)
2. [Administrator: first-time setup](#2-administrator-first-time-setup)
3. [Family: requesting and taking a tour](#3-family-requesting-and-taking-a-tour)
4. [Front Office: managing the lead pipeline](#4-front-office-managing-the-lead-pipeline)
5. [Tour Guide: running the live walk](#5-tour-guide-running-the-live-walk)
6. [Printed materials (PDFs)](#6-printed-materials-pdfs)
7. [Outcomes & analytics](#7-outcomes--analytics)
8. [Roles & permissions](#8-roles--permissions)
9. [Quick reference: URLs](#9-quick-reference-urls)
10. [Troubleshooting & FAQ](#10-troubleshooting--faq)

---

## 1. The big picture

A tour moves through six stages. Everyone sees the same journey from their own seat:

```
  FAMILY            FRONT OFFICE              TOUR GUIDE            FRONT OFFICE
  ───────           ────────────              ──────────           ────────────
  Finds brag   →    New lead lands     →   Owner assigned,   →   Guide walks the   →   Outcome logged
  page, asks        in the pipeline        tour scheduled        family live           (Enrolled / etc.)
  for a tour                                                      (phone QR)
       │                  │                       │                     │
       └──── post-tour survey ◄──────────────────┴── timings + notes ──┘
                                                      feed the follow-up call
```

**Pipeline stages:** New → Contacted → Scheduled → Toured → Still deciding → Closed.

The system watches the clock for you: a new lead that hasn't been contacted, or a
scheduled tour that was never logged, surfaces an **overdue badge** so nothing slips.

---

## 2. Administrator: first-time setup

Do these once before you publish your brag page. (Requires an Admin / tour-manager
role — see [Roles & permissions](#8-roles--permissions).)

### Step 2.1 — Turn the feature on
School Tours must be enabled for your school (a district SuperUser enables it at the
district level, and it then appears under **Settings**). If you don't see **📋 School
Tours** under Settings, ask your district administrator to enable it.

### Step 2.2 — Build your Brag Page
Go to **Settings → 📋 School Tours → ✨ Brag Page**. This is the public page families
will see. Fill in:

- **Headline & sub-headline** — the first thing a family reads.
- **Content blocks** — sections of title + body text (your story, your mission).
- **Programs / Electives / "What we're proud of"** — bullet lists of highlights.
- **Photos** — upload a gallery; families swipe through them.
- **Flyers** — upload PDFs or images (open house invites, program one-pagers).
- **Accent color** — drives the page's hero gradient and branding.
- **Language (EN/ES)** — edit both languages. The system can machine-translate to
  give you a starting Spanish draft, which you then refine.

District branding (logo, tagline) is inherited automatically from your district.

### Step 2.3 — Define your Tour Checkpoints
Still on the **✨ Brag Page** tab, set up the **stops** on your tour. For each
checkpoint:

- **Name** (e.g., "Media Center", "Science Lab", "Cafeteria")
- **Location** (where it is, for the guide)
- **Talking points** (what to say at this stop — staff-only)
- **Minutes** (planned time — used for planned-vs-actual on the live walk)
- **School Highlight / Always include** — toggle ON for stops every family should
  see (these are always part of the tour, even if a family didn't pick them).

> Checkpoints do two jobs: families pick which optional stops interest them on the
> request form, and they become the tap-list on the guide's live-walk screen and
> the printed roadmap. **Talking points and minutes are staff-only** — they never
> show to families.

### Step 2.4 — Configure Settings (SLAs & notifications)
In **School Settings**, set:

- **Tour Notification Group** — which staff get alerted when a new request arrives.
- **Response SLA** — hours before an un-contacted lead is flagged overdue (default 24h).
- **Follow-up Window** — business days before a "Still deciding" lead is flagged for
  follow-up (default 3 days).
- **Family Nurture** — toggle automated reminders / thank-you emails on or off.

### Step 2.5 — Assign your Tour Guides
Make sure the staff who run tours have the **tour-guide** capability (see
[Roles & permissions](#8-roles--permissions)). Guides can be assigned leads and can
run the live walk; full managers can do everything including editing the brag page.

✅ **Setup checklist:** feature on → brag page written → photos/flyers uploaded →
checkpoints defined (with at least a few "Always include") → SLAs set → notification
group chosen → guides have the role.

---

## 3. Family: requesting and taking a tour

### Step 3.1 — Find the brag page
Families open your public page at **`/tour/<your-school-id>`** (you'll share this link
on your website, social media, or a flyer QR). No login required.

They can toggle **English / Español** at any time.

### Step 3.2 — Request a tour
On the brag page, the family fills out the **request form**:

- **Family / parent name** (required)
- **Phone number** (required)
- **Email** (optional)
- **Student(s)** — name + incoming grade; **+ Add another student** for siblings
- **"What would you like to see on your tour?"** — they check off the optional
  checkpoints that interest them
- **"Anything else?"** — free-text for questions or specific interests

When they submit, a **new lead** lands in your pipeline and your notification group
is alerted.

### Step 3.3 — Take the tour
The family arrives and is walked through the school by a guide (see
[Section 5](#5-tour-guide-running-the-live-walk)). Their selected checkpoints (plus
your always-include stops) shape the route.

### Step 3.4 — Give feedback (post-tour survey)
After the tour, the family can scan a **survey QR code** (printed on the leave-behind
PDF or shown by the guide) which opens **`/tour/survey/<token>`**. The survey asks:

- **Overall rating** (1–5 stars)
- **"What stood out?"**
- **"Still wondering about?"**
- **"Anything else?"**

Their answers flow straight into the lead's record so the office can follow up on
exactly what's on the family's mind.

---

## 4. Front Office: managing the lead pipeline

Open **Settings → 📋 School Tours → 📋 Lead Pipeline**. This is your command center.

### 4.1 — Read the board
Leads are organized by stage: **New, Contacted, Scheduled, Toured, Still deciding,
Closed.** Each lead card shows:

- Family name + student(s)
- **Owner** (assigned staff member)
- **Overdue badge** — e.g. ⏰ *No first contact*, ⏰ *Tour not logged*
- **Follow-up countdown** — e.g. 📞 *Follow up in 2d*

### 4.2 — Work a lead (the Lead Drawer)
Click any lead to open its **drawer**. From here you can:

- **Assign Owner** — give the lead to a staff member (this is also who defaults as the
  guide on the live walk).
- **Schedule Tour** — set the date/time.
- **Log Contact** — record a Call / Text / Email / In-Person touch. Each one is
  timestamped on the timeline.
- **Change Status** — move the lead along the pipeline.
- **Record Outcome** — the terminal result: **Enrolled 🎉**, **Still deciding**, or
  **Chose elsewhere** (with a reason).
- **Timeline** — a chronological feed of every status change, assignment, automated
  overdue escalation, logged contact, and manual note.
- **Live Tour Walk** — a QR code + **Open live walk** link for the guide, and, after
  the walk, the captured results (see [Section 7](#7-outcomes--analytics)).
- **Print PDFs** — Brag sheet, Roadmap, Note-catcher, Leave-behind (see
  [Section 6](#6-printed-materials-pdfs)).

### 4.3 — Let the clock work for you
You don't have to remember every deadline. The pipeline flags:

- New leads not contacted within your **Response SLA**
- Scheduled tours that came and went without being logged
- "Still deciding" families due for follow-up within your **Follow-up Window**

---

## 5. Tour Guide: running the live walk

> **New in Phase 4 — Live Tour Capture.** The guide runs the tour from a phone. Every
> tap is timestamped, works offline, and feeds the follow-up call and analytics.

### Step 5.1 — Open the walk screen
Two ways in:

1. **Scan the QR** on the printed **Tour Roadmap** PDF, or
2. Open the **Live Tour Walk** section in the lead drawer and tap **Open live walk**.

Either opens the guide screen at **`/tour/walk/<token>`**. It's token-gated and needs
no login — perfect for grabbing any staff phone.

### Step 5.2 — Confirm who's guiding
The screen opens by asking **"You're guiding this tour"** with the **lead owner**
pre-selected. If someone else is actually walking the family, change the guide here —
this is what makes the per-guide analytics accurate. Then **start the tour**; the
clock begins.

### Step 5.3 — Tap each stop as you go
You'll see the family's checkpoints (their selections + your always-include stops),
each with its location and talking points. As you complete a stop, **tap it once** —
that records the time. (One tap per checkpoint.)

### Step 5.4 — Jot notes for follow-up
At any stop you can add an optional **per-stop note** — e.g., *"Mom asked about the
gifted program"* or *"Wants bus route info."* These are **staff-only** (never shown to
the family) and are meant to arm the office for the follow-up call.

### Step 5.5 — End the tour
Tap **end the tour** when you're done. The total length and every stop's timing are
captured.

### Works offline by design
The walk screen buffers everything **on the device** and shows a status pill:
- **All changes saved** — synced to the server
- **Saving…** — flushing now
- **Offline** — buffered locally; it will sync automatically when the connection
  returns (or when you come back online).

So a basement science lab with no signal is no problem — keep tapping; it catches up.

---

## 6. Printed materials (PDFs)

From the **lead drawer**, you can generate four documents. **All PDFs download to your
device** (then open them from your downloads to print) — this is intentional and
reliable inside the app.

| Button | What it is | Who uses it |
| --- | --- | --- |
| **⬇️ Brag sheet (PDF)** | A polished one-pager about the school | Hand to the family |
| **⬇️ Roadmap (PDF)** | The tour route with stops, talking points, minutes — **and a QR to start the live walk** | The guide |
| **⬇️ Note-catcher (PDF)** | A printable sheet to jot notes by hand | The guide (paper backup) |
| **⬇️ Leave-behind (PDF)** | A take-home with a **survey QR code** | Hand to the family at the end |

> Talking points and planned minutes print only on the **Roadmap** (staff-facing).
> The **Leave-behind** carries the QR families scan for the post-tour survey.

---

## 7. Outcomes & analytics

Open **Settings → 📋 School Tours → 📊 Outcomes**.

### Conversion report
- **Total leads, Toured, Enrolled, Conversion %** at the top
- **Pipeline** breakdown by stage
- **By source** — where your leads come from

### Live tour walks (per-guide analytics)
A **Live tour walks** card shows:
- **Walks completed**
- **Avg tour length** (minutes)
- **By tour guide** — each guide's number of walks and their average tour length

> **Heads-up:** per-guide analytics only appear **after at least one walk is
> completed** (a walk with both a start and an end). Until then you'll see *"No
> completed walks yet. Per-guide analytics appear here once a guide finishes a live
> tour from the roadmap QR."* — that's normal, not an error.

### Per-lead walk results (in the lead drawer)
After a walk, the lead drawer's **Live Tour Walk** section shows:
- **Who guided** the tour
- **Total length** vs. the planned total
- **Per-stop planned-vs-actual** timing, in the order stops were actually completed
- **Follow-up notes** the guide captured, highlighted for the call

---

## 8. Roles & permissions

| Capability | Who has it | What it unlocks |
| --- | --- | --- |
| **Manage tours** | Admin, Behavior Specialist, MTSS, or staff granted the tour-notify capability | Full pipeline, Brag Page editor, Outcomes, all PDFs |
| **Guide tours** | All managers, plus staff granted the tour-guide capability | Be assigned leads; run the live walk; print/access PDFs for their own leads |
| **Access a lead** | Managers (any lead); guides (only leads assigned to them) | View detail, timeline, and print PDFs |

The **public** brag page, request form, post-tour survey, and the token-gated live-walk
screen need **no login** — they're protected by opaque, link-safe tokens, just like the
kiosk and survey flows.

---

## 9. Quick reference: URLs

| URL | Audience | Login? |
| --- | --- | --- |
| `/tour/<schoolId>` | Family — public brag page & request form | No |
| `/tour/survey/<token>` | Family — post-tour survey | No |
| `/tour/walk/<token>` | Guide — live tour walk | No (token-gated) |
| **Settings → 📋 School Tours** | Staff — pipeline, brag page, outcomes | Yes |

---

## 10. Troubleshooting & FAQ

**"I don't see per-guide analytics."**
You need at least one **completed** walk (started *and* ended). No completed walk =
empty card with a hint. Run a full live walk to populate it.

**"The walk screen says the link isn't valid."**
The token is wrong or expired. Generate a fresh **Roadmap** PDF from the lead drawer
(or use the **Open live walk** link there) to get a current QR/link.

**"A PDF opened blank / froze when I tried to print."**
By design, all tour PDFs **download** to your device. Open the downloaded file and
print from there — don't try to print from a preview tab.

**"The brag page isn't showing for families."**
Confirm School Tours is enabled for your school and that you've published brag-page
content. Check the public URL `/tour/<your-school-id>`.

**"My checkpoint timings look off on the report."**
Per-stop actuals are computed in the order stops were **actually completed** during the
walk, compared against the **planned minutes** you set per checkpoint. Make sure each
checkpoint has a sensible planned-minutes value.

**"The guide on the report is wrong."**
Whoever was confirmed on the walk screen (Step 5.2) is credited. Remind guides to
re-stamp the guide if someone other than the lead owner walks the family.

**"Does the live walk need internet the whole time?"**
No. It buffers offline and syncs when the connection returns. Watch the status pill:
*All changes saved / Saving… / Offline.*

---

*PulseEDU — School Tours. Questions or a feature you don't see here? Check with your
district administrator.*
