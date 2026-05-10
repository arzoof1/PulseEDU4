// Generates PulseEDU_Teacher_User_Guide.pdf — a teacher-facing, click-by-click
// instruction manual for every feature a teacher uses day-to-day. Each
// feature is its own chapter with: where to find it, when to use it,
// numbered steps (action + button + outcome), and tips.

import PDFDocument from "pdfkit";
import { createWriteStream, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "..", "..", "attached_assets", "PulseEDU_Teacher_User_Guide.pdf");
mkdirSync(dirname(OUT), { recursive: true });

const C = {
  ink: "#0f172a",
  inkSoft: "#475569",
  inkFaint: "#94a3b8",
  brand: "#1d4ed8",
  accent: "#0e7490",
  rule: "#cbd5e1",
  ok: "#15803d",
  warn: "#b45309",
  bgPanel: "#f1f5f9",
  bgTip: "#ecfdf5",
  bgWarn: "#fffbeb",
};

interface Step {
  // numbered step. action is the imperative ("Click ...", "Type ...").
  // detail is optional follow-up text.
  action: string;
  detail?: string;
}

interface Feature {
  title: string;
  whereToFind: string;
  whenToUseIt: string;
  beforeYouStart?: string[];
  steps: Step[];
  tips?: string[];
  watchOutFor?: string[];
}

interface Chapter {
  title: string;
  intro?: string;
  features: Feature[];
}

// =========================================================================
// CONTENT
// =========================================================================

const CHAPTERS: Chapter[] = [
  // -------------------------------------------------------------------
  {
    title: "1. Getting Started",
    intro:
      "These three pages cover how to sign in, find your way around the app, and recognize what each part of the screen is for. Read this once on day one — every other chapter assumes you can navigate the sidebar.",
    features: [
      {
        title: "Sign In",
        whereToFind: "Open the PulseEDU URL your school provided in any browser.",
        whenToUseIt: "Every morning before first period.",
        steps: [
          { action: "Open your browser and go to the PulseEDU address your school sent you." },
          { action: "Type your school email in the Email field." },
          { action: "Type your password in the Password field." },
          { action: "Click the blue Sign in button.", detail: "If the button is greyed out, you haven't filled in both fields yet." },
          { action: "Wait for the dashboard to load." },
        ],
        tips: [
          "Bookmark the page on your school computer so you don't have to type the URL each morning.",
        ],
        watchOutFor: [
          "If you forgot your password, ask your school administrator to reset it — there is no self-serve reset link inside the app.",
        ],
      },
      {
        title: "Find Your Way Around (the App Shell)",
        whereToFind: "Visible on every screen after you sign in.",
        whenToUseIt: "Any time you need to switch from one feature to another.",
        steps: [
          { action: "Look at the left edge of the screen.", detail: "That's the sidebar — every feature you have access to is listed here." },
          { action: "Look at the very top of the sidebar.", detail: "That's Quick Access — items the system thinks you need right now (e.g., outstanding intervention check-ins, pending pullouts). It updates as you work." },
          { action: "Click any sidebar item to open that feature.", detail: "The center of the screen swaps to that feature. Your other tabs stay where they are." },
          { action: "Click your name at the top right to see your profile and the Sign Out button." },
          { action: "Click the bell icon (when it has a red number) to see notifications.", detail: "The bell shows how many intervention entries you owe today; clicking it jumps you to My Interventions." },
        ],
        tips: [
          "If you can't find a feature in the sidebar, your school has either turned it off or your role doesn't have access — ask your administrator.",
          "The sidebar collapses when the screen is narrow (e.g., on a tablet). Tap the menu icon (three lines) to open it.",
        ],
      },
    ],
  },
  // -------------------------------------------------------------------
  {
    title: "2. Hall Passes",
    intro: "Issue, monitor, and close out hall passes for students leaving your room.",
    features: [
      {
        title: "Create a Hall Pass",
        whereToFind: "Sidebar → Hall Passes.",
        whenToUseIt: "A student needs to leave your room (bathroom, nurse, office, another teacher's room).",
        beforeYouStart: [
          "Make sure the student is in the room — passes are time-stamped from the moment you click Create.",
        ],
        steps: [
          { action: "Click Hall Passes in the sidebar." },
          { action: "Click the + New Pass button at the top right of the Hall Passes screen." },
          { action: "Type the student's name in the Student field.", detail: "A dropdown of matching students from your roster appears as you type. Click the right one." },
          { action: "Pick a Destination from the dropdown.", detail: "The list comes from your school's Locations setting. If you don't see the right destination, ask your administrator to add it." },
          { action: "(Optional) Type a short Note — e.g., 'left textbook in lunch room'." },
          { action: "Click the green Create Pass button.", detail: "The pass appears at the top of the active list with a running timer." },
        ],
        tips: [
          "If the destination is another teacher's room, that teacher gets a notification that the student is on the way (only if your school has the teacher allowlist configured).",
          "You can have more than one pass open at a time, but the school's per-student limit (set by an admin) caps how many a single student can hold.",
        ],
        watchOutFor: [
          "If your school requires you to pick from an allowlist, an unfamiliar destination won't appear — that's by design.",
          "If the student is already out on another pass, the system will warn you before issuing a second one.",
        ],
      },
      {
        title: "Check a Student Back In",
        whereToFind: "Sidebar → Hall Passes → the active passes list at the top.",
        whenToUseIt: "When the student returns to your room.",
        steps: [
          { action: "Find the student's pass in the active list.", detail: "Active passes are at the top, color-coded: green (recent), yellow (over your school's threshold), red (well over)." },
          { action: "Click the Check In button on that row." },
          { action: "Confirm in the popup if asked.", detail: "The pass moves out of the active list and into Today's Closed Passes lower on the page." },
        ],
        tips: [
          "If the student forgot to check in and you notice later, you can still close the pass — the system records the actual close time, but you can edit it within the same school day.",
        ],
      },
      {
        title: "Mark a Pass as Arrived (destination teacher)",
        whereToFind: "Sidebar → Hall Passes (a pass routed to your room appears here automatically).",
        whenToUseIt: "A student arrives at YOUR room with a pass from another teacher.",
        steps: [
          { action: "Look for the pass in your Inbound section at the top of Hall Passes." },
          { action: "Click the Arrived button on that pass.", detail: "This time-stamps when they got there — the originating teacher's view updates immediately." },
          { action: "When the student leaves to go back, click Send Back.", detail: "This stamps the return-leg time and pings the originating room." },
        ],
      },
      {
        title: "View Active Passes School-Wide (Hall Pass Queue)",
        whereToFind: "Sidebar → Hall Passes → Queue tab (only visible if you have access).",
        whenToUseIt: "You're covering the front desk or doing a hallway sweep.",
        steps: [
          { action: "Click the Queue tab at the top of the Hall Passes screen." },
          { action: "Scroll the list — every active pass in the building is here.", detail: "The queue resets at every period change based on your school's bell schedule." },
          { action: "Click any row to see the full pass details (origin, destination, time out)." },
        ],
        tips: [
          "Most teachers see the Queue as read-only. Office staff and admins can override or close passes here.",
        ],
      },
    ],
  },
  // -------------------------------------------------------------------
  {
    title: "3. Tardy Pass",
    features: [
      {
        title: "Log a Tardy",
        whereToFind: "Sidebar → Tardy Pass.",
        whenToUseIt: "A student arrives to your class after the bell.",
        steps: [
          { action: "Click Tardy Pass in the sidebar." },
          { action: "Click + Log Tardy at the top right." },
          { action: "Type the student's name and pick them from the dropdown." },
          { action: "Pick the Period from the dropdown.", detail: "The list is your school's bell schedule — pick the period the tardy is for." },
          { action: "(Optional) Type a short reason in the Note field." },
          { action: "Click the green Log Tardy button.", detail: "The tardy appears in Today's Tardies with a timestamp; the parent will see it in the Parent Portal if your school has that section enabled." },
        ],
        tips: [
          "Tardies count toward attendance dashboards and Early Warning indicators, so log every one.",
        ],
        watchOutFor: [
          "If you logged the wrong student, click the row and use Edit to fix it (or Delete if it was a mistake). Edits are tracked.",
        ],
      },
    ],
  },
  // -------------------------------------------------------------------
  {
    title: "4. PBIS Points",
    intro: "Reward positive behavior. Points feed house standings on the hallway TVs and let students 'spend' at the school or classroom store.",
    features: [
      {
        title: "Award Points to One Student",
        whereToFind: "Sidebar → PBIS Points.",
        whenToUseIt: "A student does something worth recognizing — meeting an expectation, helping a peer, finishing extra work.",
        steps: [
          { action: "Click PBIS Points in the sidebar." },
          { action: "Click the + Award Points button at the top right." },
          { action: "Type the student's name and pick them from the dropdown." },
          { action: "Pick a Reason from the dropdown.", detail: "Reasons come from your school's PBIS Reasons catalog (e.g. 'Showed leadership', 'On-task during transitions')." },
          { action: "Adjust the Points value if you want to give more than the default for that reason.", detail: "The default for each reason is set by your PBIS coordinator." },
          { action: "(Optional) Click Add Note to attach a one-line description.", detail: "If your school has saved note templates, click the template chip to drop one in instantly." },
          { action: "Click the green Award button.", detail: "The student's balance updates immediately and a small confirmation pops up." },
        ],
        tips: [
          "If a student is on a Tier 2 plan, the form may suggest reasons aligned with their goals — pick those when they apply.",
        ],
      },
      {
        title: "Award Points to a Whole Class (Multi-Select)",
        whereToFind: "Sidebar → PBIS Points → + Award Points → toggle Multi-select.",
        whenToUseIt: "The whole class earned the reward (e.g., 'cleaned up after lab in under 2 min').",
        steps: [
          { action: "Open the Award Points form (see prior section)." },
          { action: "Click the Multi-select toggle at the top of the form.", detail: "The Student field becomes a checklist." },
          { action: "Check the box next to every student you want to award.", detail: "Use Select All to grab the whole roster, then uncheck anyone who shouldn't get it (e.g., absent students)." },
          { action: "Pick the Reason and Points exactly as you would for a single student." },
          { action: "Click Award.", detail: "One transaction is logged per student so each shows up individually in their history." },
        ],
        watchOutFor: [
          "Multi-select uses the same point value for every student. If one student earned more than the rest, do them separately.",
        ],
      },
      {
        title: "See a Student's Point History",
        whereToFind: "Sidebar → PBIS Points → click a student's name in the leaderboard, OR open Student Profile → PBIS tab.",
        whenToUseIt: "A parent or student asks 'how many points do I have / why did I lose those?'",
        steps: [
          { action: "Click a student name from the PBIS Points leaderboard." },
          { action: "Read the timeline.", detail: "Each row shows when, who awarded, the reason, points, and any note." },
          { action: "Click the Print Friendly link at the top to export a clean version for a parent meeting." },
        ],
      },
    ],
  },
  // -------------------------------------------------------------------
  {
    title: "5. School Store & Classroom Store",
    intro:
      "Two stores: the School Store is school-wide and read-only for teachers (admins manage it). The Classroom Store is yours alone — you stock and run it.",
    features: [
      {
        title: "Browse the School Store",
        whereToFind: "Sidebar → School Store.",
        whenToUseIt: "A student asks what they can spend their points on at the school level.",
        steps: [
          { action: "Click School Store in the sidebar." },
          { action: "Scroll the catalog of items.", detail: "Each card shows the item, its point cost, and stock remaining." },
          { action: "(For your information only.) Teachers cannot redeem from the School Store — that's done by the PBIS coordinator or admin in the PBIS Hub." },
        ],
      },
      {
        title: "Add an Item to YOUR Classroom Store",
        whereToFind: "Sidebar → PBIS Points → Classroom Store tab.",
        whenToUseIt: "Setting up your own reward catalog at the start of the term, or adding a seasonal item.",
        steps: [
          { action: "Click PBIS Points in the sidebar, then the Classroom Store tab at the top." },
          { action: "Click the + Add Item button." },
          { action: "Type a Name (e.g., 'Pick the music for 5 minutes')." },
          { action: "Type a Cost in points (the price students pay)." },
          { action: "Type a Stock number (or leave blank for unlimited)." },
          { action: "(Optional) Click Upload Image to attach a thumbnail.", detail: "Pictures help younger students see what they're buying. JPG/PNG, under 5 MB." },
          { action: "Click the green Save button.", detail: "The item appears in your Classroom Store and is immediately purchasable." },
        ],
        tips: [
          "Start with 4–6 items so the catalog is browsable on a phone-sized screen.",
          "Use the Hide checkbox to take an item out of rotation without deleting its history.",
        ],
      },
      {
        title: "Redeem an Item for a Student",
        whereToFind: "Sidebar → PBIS Points → Classroom Store tab.",
        whenToUseIt: "A student says 'I want to buy this'.",
        steps: [
          { action: "Open the Classroom Store tab." },
          { action: "Click the Redeem button on the item the student wants." },
          { action: "Type the student's name and pick them from the dropdown." },
          { action: "Confirm the cost vs. their balance.", detail: "If they don't have enough, the Confirm button is disabled — the system will not let you over-draft." },
          { action: "Click Confirm Purchase.", detail: "The cost is deducted, stock decrements, and the order shows up in your Recent Orders list." },
        ],
        watchOutFor: [
          "If you sold the wrong item or to the wrong student, click the order in Recent Orders and choose Refund — points and stock both come back. Refunds are logged.",
        ],
      },
    ],
  },
  // -------------------------------------------------------------------
  {
    title: "6. Spotlight",
    features: [
      {
        title: "Recognize a Student Publicly",
        whereToFind: "Sidebar → top header → Spotlight button.",
        whenToUseIt: "You want a student's win to show up on the hallway TVs.",
        steps: [
          { action: "Click the Spotlight button in the header." },
          { action: "Type the student's name and pick them." },
          { action: "Type a short message (one sentence).", detail: "Keep it under ~80 characters — anything longer is truncated on the TV." },
          { action: "(Optional) Pick an emoji from the row at the bottom." },
          { action: "Click Send Spotlight.", detail: "It enters the signage rotation within ~10 seconds and appears for the configured duration (usually 24 hours)." },
        ],
        tips: [
          "Spotlights are public — write the message as if a parent will read it. (They might.)",
          "If you spotlight five different students one after another, the rotation cycles through them; nobody's hidden.",
        ],
      },
    ],
  },
  // -------------------------------------------------------------------
  {
    title: "7. Accommodations",
    intro: "Log when you delivered a student's IEP/504/ELL accommodation. This builds the evidence record the case manager needs at meetings.",
    features: [
      {
        title: "Log an Accommodation Use",
        whereToFind: "Sidebar → Accommodations.",
        whenToUseIt: "Right after you provide an accommodation (extended time, fidget, scribe, separate setting, etc.).",
        steps: [
          { action: "Click Accommodations in the sidebar." },
          { action: "Click + Log Accommodation Use at the top right." },
          { action: "Type the student's name and pick them.", detail: "Only students with active accommodations show up in the suggestions list." },
          { action: "Pick the specific accommodation from the dropdown.", detail: "The list is filtered to that student's plan — you cannot log an accommodation they aren't approved for." },
          { action: "(Optional) Type a brief context note (e.g., 'used during weekly quiz')." },
          { action: "Click the green Log button.", detail: "It appears immediately in their Accommodation Log and on the Student Profile." },
        ],
        tips: [
          "Log on the same day. Backdating more than a few days requires an admin to override.",
          "If a student needs an accommodation that isn't in their plan, talk to the case manager — don't free-text it here.",
        ],
      },
      {
        title: "View a Student's Accommodation Log",
        whereToFind: "Sidebar → Accommodations → click a student name, OR Student Profile → Accommodations tab.",
        whenToUseIt: "Preparing for an IEP/504 meeting, or answering a case manager's question.",
        steps: [
          { action: "Click the student's name on the Accommodations screen." },
          { action: "Read the chronological log.", detail: "Each row shows date, time, accommodation, who logged it, and any note." },
          { action: "Click Export to download a PDF of the log for the meeting binder." },
        ],
      },
    ],
  },
  // -------------------------------------------------------------------
  {
    title: "8. Interventions (Tier 2 / Tier 3)",
    intro:
      "If one of your students is on a Tier 2 or Tier 3 plan, you'll be asked to log a check-in (Tier 2 = daily, Tier 3 = weekly). The Log Intervention launcher figures out which form to show based on the student you pick.",
    features: [
      {
        title: "Log Today's Tier 2 Check-In",
        whereToFind: "Sidebar → Log Intervention.",
        whenToUseIt: "End of the day (or end of the period you teach the student).",
        steps: [
          { action: "Click Log Intervention in the sidebar." },
          { action: "Type the student's name and pick them.", detail: "A Tier 2 or Tier 3 badge appears next to the name so you know which plan you're filling." },
          { action: "If they're Tier 2, the daily check-in form opens automatically." },
          { action: "Pick a Morning rating (1–4) from the row of buttons.", detail: "1 = struggled, 4 = exceeded. The exact wording is set by your school." },
          { action: "Pick an Afternoon rating from the second row of buttons." },
          { action: "(Optional) Type a Behavior Note — one or two sentences.", detail: "If the school has saved templates, the chips above the box drop them in." },
          { action: "Click the green Submit button.", detail: "The entry appears in My Interventions for today and the bell-icon counter decreases by one." },
        ],
        tips: [
          "Tier 2 entries are owed every school day. If you miss a day, you can still log it the next day — it stamps with the correct date.",
        ],
      },
      {
        title: "Log a Tier 3 Weekly Progress Entry",
        whereToFind: "Sidebar → Log Intervention.",
        whenToUseIt: "End of the school week (Friday) for any student on a Tier 3 plan.",
        steps: [
          { action: "Click Log Intervention in the sidebar." },
          { action: "Pick the student — the Tier 3 badge confirms you're on a weekly plan." },
          { action: "For each Goal listed at the top, pick a rating (1–4) from the button row." },
          { action: "Check every Strategy you actually used this week.", detail: "The list comes from the school's strategy catalog grouped by category (self-regulation, social skills, etc.)." },
          { action: "Type a Weekly Note summarizing the week (a few sentences)." },
          { action: "Click Submit Weekly Entry." },
        ],
        tips: [
          "If you forget what the goal language means, hover the (?) icon next to the goal — it shows the case manager's notes.",
          "Weekly entries are due by Sunday night. The bell counter clears when you submit.",
        ],
      },
      {
        title: "See What You Owe Today (My Interventions)",
        whereToFind: "Sidebar → My Interventions, or click the bell icon when it shows a number.",
        whenToUseIt: "First thing in the morning to see your list, or any time you want to clear pending entries.",
        steps: [
          { action: "Click My Interventions in the sidebar." },
          { action: "Read the list grouped by student.", detail: "Each line says what's owed (Tier 2 today, Tier 3 this week) and how overdue it is, if any." },
          { action: "Click any row to jump straight into that entry's form.", detail: "Submitting it removes the row from the list and decreases the bell counter." },
        ],
        tips: [
          "If a student transferred out, click the (X) on their row to dismiss the owed entry — it asks for a reason and logs it.",
        ],
      },
      {
        title: "Request a Pullout for a Student",
        whereToFind: "Sidebar → Request Pullout.",
        whenToUseIt:
          "A student needs to be pulled from your class for a check-in with a counselor, BS, MTSS, or behavior support — and you want it on the record.",
        steps: [
          { action: "Click Request Pullout in the sidebar." },
          { action: "Click + New Request." },
          { action: "Pick the student." },
          { action: "Pick a Reason from the dropdown.", detail: "Reasons are configured by your admin (e.g., 'reset / break', 'counselor check-in', 'parent on phone')." },
          { action: "Pick the Period.", detail: "Defaults to the current period if your school has a bell schedule set." },
          { action: "(Optional) Type a Note for the support staff." },
          { action: "Click Submit Request.", detail: "An admin or behavior specialist sees it in Verify Pullouts; you'll see the status update on this same screen." },
        ],
        tips: [
          "Track the status: Pending → Approved → Scheduled → Done (or Rejected with a note).",
          "If urgent, use a phone call AND submit the request — the request is the paper trail, not the alert mechanism.",
        ],
      },
    ],
  },
  // -------------------------------------------------------------------
  {
    title: "9. Safety Plans",
    intro:
      "Safety plans are written by the school's Guidance Counselor or a Core Team member. As a teacher, you cannot edit them — but you must be able to view a plan for any student you teach who has one.",
    features: [
      {
        title: "See a Student's Safety Plan",
        whereToFind:
          "Teacher Roster → hover the red SP pill next to the student's name. For the full plan, open the Student Profile and click the Safety Plan button in the header.",
        whenToUseIt:
          "Before the start of a new school year, after a difficult interaction, or any time you're not sure what the agreed protocol is.",
        steps: [
          { action: "Open your Teacher Roster." },
          { action: "Look at the row for the student in question.", detail: "If a red 'SP' pill appears next to their name, they have an active safety plan." },
          { action: "Hover (or focus) the red SP pill to read the active items inline.", detail: "A popover lists the active items and any notes. The roster pill itself is read-only — clicking does not open an editor for any role." },
          { action: "For the full plan, open the student's Profile.", detail: "Click the Spider pill on the roster row, then click the Safety Plan button in the profile header. The button reads 'View safety plan' for teachers." },
          { action: "Read each section of the plan." },
        ],
        tips: [
          "If something in the plan is unclear or contradicts what you're seeing in class, contact the Guidance Counselor or the case manager listed at the top of the plan — do not guess.",
        ],
        watchOutFor: [
          "If you believe the plan is wrong or out of date, do NOT try to edit it — teachers don't have permission. Reach out to Guidance Counseling or the Core Team.",
        ],
      },
    ],
  },
  // -------------------------------------------------------------------
  {
    title: "10. Teacher Roster",
    intro:
      "The Teacher Roster is your one-screen view of every student in your sections — their FAST progress monitoring scores, where they sit on the level chart, their program flags (ESE / 504 / ELL), and any active safety plan. It is read-only: there are no row action buttons. To award PBIS, log a tardy, or start a hall pass, use the matching feature in the sidebar.",
    features: [
      {
        title: "Open Your Roster",
        whereToFind: "Sidebar → Roster.",
        whenToUseIt: "Whenever you want a single screen showing every student you teach.",
        steps: [
          { action: "Click Roster in the sidebar." },
          { action: "The page loads your sections grouped by class period.", detail: "Each row is one student; columns show ELA and Math FAST scores plus program info." },
        ],
        tips: [
          "If you are on the Core Team (Admin / SuperUser / ESE Coordinator / Behavior Specialist / MTSS Coordinator), a Teacher dropdown appears at the top so you can view any teacher's roster.",
        ],
      },
      {
        title: "Read the Score Pills (PM3 / PM1 / PM2 / LG)",
        whereToFind: "Roster — the colored pills inside each student row.",
        whenToUseIt: "You want to know how a student is doing on FAST and where the next level lives.",
        steps: [
          { action: "Find the student's row.", detail: "ELA scores are on the left; Math scores are on the right." },
          { action: "Read each pill from left to right: PM3, PM1, PM2, LG.", detail: "PM3 is the most-recent score. Color encodes level: red = L1, orange = L2, green = L3, blue = L4, purple = L5. The number on the pill is the FAST sub-level (e.g., 2H)." },
          { action: "Click a pill to flip it to the raw scale score.", detail: "Click again to flip back. Each pill remembers its own state — you can flip several at once." },
          { action: "Look at the pail-shaped LG icon at the right of each subject group.", detail: "LG = Level Growth. The number inside is the points needed to hit the next level on the current grade's chart. A green check means the student is already at or above target." },
        ],
        tips: [
          "If a subject shows 'n/a' for a student, that grade has no FAST chart for that subject (e.g., Math for high-school courses like Algebra 1).",
        ],
      },
      {
        title: "Read the Pills Next to a Student's Name",
        whereToFind: "Roster — the chips that appear immediately after the student name.",
        whenToUseIt: "You want a quick read on supports, programs, and risk indicators.",
        steps: [
          { action: "Look for the red SP pill.", detail: "Red SP = active Safety Plan. Hover (or focus) to see the plan's active items, notes, and last-updated date in a popover. The pill itself is read-only on the roster — Counselors and Core Team manage plans from the dedicated Safety Plans page or from the Student Profile." },
          { action: "Look for the small ESE / 504 / ELL chips.", detail: "Each chip is colored: ESE = blue, 504 = purple, ELL = green. Hover any chip to see the student's active accommodations grouped by category." },
          { action: "Look for the eye-with-slash icon.", detail: "It means the student has had zero PBIS recognitions in the school's invisible-student window (e.g., 14 days). A small '2' or '3' badge means they also have an active MTSS Tier 2 or Tier 3 plan — i.e., a more urgent version of the same flag." },
          { action: "Look for the ISS / OSS indicator on the row.", detail: "If present, the student is on In-School (or Out-of-School) Suspension today. Acknowledge it for your period using the small period-acknowledgement control." },
          { action: "Click the Spider pill (when present) to open the student's full Profile (the whole-child radar)." },
        ],
      },
    ],
  },
  // -------------------------------------------------------------------
  {
    title: "11. Student Profile",
    intro:
      "The Student Profile is a whole-child view of one student: a radar chart across five pillars (academics, behavior, flow, supports, family), risk-flag chips at the top, and pillar cards with the underlying numbers. Use the Window picker at the top to change the time range. Teachers cannot add notes or edit plans from this screen — those actions live in dedicated features owned by Counselors / Case Managers / Core Team.",
    features: [
      {
        title: "Open a Student's Profile",
        whereToFind: "Click the Spider pill on a Roster row, click a student name in any Insights dashboard, or click a student in your Watchlist.",
        whenToUseIt: "Anytime you need the full picture of one student before a meeting or parent contact.",
        steps: [
          { action: "Open the profile from any of the entry points above." },
          { action: "Read the header.", detail: "Name, grade, demographics, MTSS tier, active plan count, and a row of risk-flag chips (color-coded: red = high, amber = watch, blue = info)." },
          { action: "Look at the Whole-Child Snapshot (radar).", detail: "Five axes (Academics, Behavior, Flow, Supports, Family) scored 0–100. The line color reflects the lowest non-resource axis. 'Supports' is a resource axis — high values mean wraparound is in place, not wellness." },
          { action: "Read each pillar card under the radar.", detail: "Academics (FAST PM1/PM2/PM3 + iReady + science benchmarks), Behavior (PBIS counts + recent items + recent support notes), Flow (tardies, hall passes, ISS days, recent pullouts), Supports (active accommodations, recent interventions, active MTSS plans, trusted adults), Family (parent contact + linked Parent Portal accounts)." },
          { action: "Scroll to the Intervention History panel below the pillars.", detail: "It is the canonical record of every Tier 2, Tier 3, legacy, and Check-In/Check-Out entry for this student." },
        ],
      },
      {
        title: "Change the Time Window",
        whereToFind: "Student Profile — the Window row at the top right.",
        whenToUseIt: "You need to see the past 3 days for a recent event, or stretch out to 30 days for a meeting.",
        steps: [
          { action: "Click 3, 7, 15, or 30 to set the window in days.", detail: "The page reloads in place; pillar counts and trends update to that window." },
          { action: "Click Custom and pick From and To dates for any other range." },
        ],
      },
      {
        title: "Open the Safety Plan from the Profile (Read-Only for Teachers)",
        whereToFind: "Student Profile header — the Safety Plan button.",
        whenToUseIt: "You want to view the protocol for a student you teach.",
        steps: [
          { action: "Click the Safety Plan button in the header.", detail: "The button reads 'View safety plan' for teachers (read-only) and 'Edit safety plan' for Counselors / Core Team." },
          { action: "Read each section of the plan." },
          { action: "Click Close (or the back arrow) to return to the profile." },
        ],
        watchOutFor: [
          "If something in the plan is wrong or out of date, do NOT try to edit it — you don't have permission. Contact the Guidance Counselor or the case manager listed at the top of the plan.",
        ],
      },
    ],
  },
  // -------------------------------------------------------------------
  {
    title: "12. Insights (Read-only)",
    intro:
      "The Insights area gives you school-wide context — how your students compare on attendance, behavior, and academics. As a teacher you can read every dashboard but cannot change underlying configuration.",
    features: [
      {
        title: "Open and Filter a Dashboard",
        whereToFind: "Sidebar → Insights → pick a dashboard (Engagement, Behavior, Academics, SEB/SEL, Equity, Early Warning).",
        whenToUseIt: "Pre-conference data review, weekly team meeting, picking who to spotlight or intervene with.",
        steps: [
          { action: "Click Insights in the sidebar, then the dashboard you want." },
          { action: "Use the Grade dropdown at the top to limit to a specific grade band (e.g., 9th)." },
          { action: "Use the Time Window dropdown (Week / Month / Quarter / YTD)." },
          { action: "Read the top-N lists.", detail: "These are the students most affected by whatever the dashboard is measuring (e.g., most tardies, lowest FAST scores)." },
          { action: "Click any student row to open their Student Profile with the same filter pre-applied." },
        ],
        tips: [
          "If a dashboard tile is greyed out with 'no data', either the source data hasn't been imported yet or your school doesn't have that feature enabled.",
        ],
      },
      {
        title: "Build Your Personal Watchlist",
        whereToFind: "Sidebar → Insights → Watchlist tab.",
        whenToUseIt: "You want a daily roll-up of just the students you're keeping the closest eye on (regardless of which class they're in).",
        steps: [
          { action: "Click Insights → Watchlist." },
          { action: "Click + Add Student at the top right." },
          { action: "Search for the student and click Add." },
          { action: "(Optional) Click + New Group to create a tag (e.g., 'AM cohort', 'Week 3 SEL') — then drag students into the group." },
          { action: "Read your Daily Roll-Up at the top.", detail: "It surfaces what changed for your watchlisted students yesterday: new incidents, missed interventions, big PBIS changes." },
        ],
        tips: [
          "Your watchlist is private — only you see it.",
          "Star a student from any other screen to add them to your watchlist without coming here first.",
        ],
      },
    ],
  },
  // -------------------------------------------------------------------
  {
    title: "13. Family Communication",
    features: [
      {
        title: "See What a Parent Sees (Family Comm)",
        whereToFind: "Sidebar → Family Communication.",
        whenToUseIt: "Before a parent meeting; troubleshooting a parent's question about what their HeartBEAT report says.",
        steps: [
          { action: "Click Family Communication in the sidebar." },
          { action: "Pick the student.", detail: "You see exactly the panels the parent sees in the Parent Portal — PBIS, hall passes, tardies, accommodations, staff notes — limited to what your school has enabled in Parent Portal Sections." },
          { action: "Click Print Friendly to export a PDF of that view for the meeting." },
        ],
        tips: [
          "If the parent says they cannot see a certain section, your admin probably has it disabled school-wide. Ask them.",
        ],
      },
    ],
  },
  // -------------------------------------------------------------------
  {
    title: "14. Quick Reference & Tips",
    intro: "A grab-bag of habits that make the day go faster.",
    features: [
      {
        title: "Daily Five-Minute Routine",
        whereToFind: "—",
        whenToUseIt: "First five minutes after sign-in.",
        steps: [
          { action: "Glance at the bell icon — if there's a number, click it and clear yesterday's intervention entries.", detail: "Doing this once a morning prevents Friday-night backlog." },
          { action: "Open My Interventions and skim today's owed entries.", detail: "You don't have to fill them now — just know what's coming." },
          { action: "Glance at your Watchlist roll-up for anything new since you signed off." },
          { action: "Open Roster and look for any new red SP pills (a safety plan added overnight).", detail: "If you see a new one, read it before that class begins." },
        ],
      },
      {
        title: "What to Do When Something Looks Wrong",
        whereToFind: "—",
        whenToUseIt: "You see incorrect data or a feature that won't load.",
        steps: [
          { action: "Refresh the page (Ctrl+R or Cmd+R).", detail: "Most stale-data issues clear with a refresh." },
          { action: "If the page is still wrong, sign out and back in.", detail: "Your session may have lost context — happens after long idles." },
          { action: "Take a screenshot showing what you see and send it to your administrator.", detail: "Note the date/time and which student, if any, was on screen — that helps engineering trace it." },
          { action: "Do NOT enter the same data twice as a workaround.", detail: "Duplicates are harder to clean than missing data. Wait for the fix." },
        ],
      },
    ],
  },
];

// =========================================================================
// PDF RENDERING
// =========================================================================

const doc = new PDFDocument({
  size: "LETTER",
  margins: { top: 64, bottom: 64, left: 64, right: 64 },
  bufferPages: true,
  info: {
    Title: "PulseEDU Teacher User Guide",
    Author: "PulseEDU",
    Subject: "Page-by-page, button-by-button instructions for teachers",
  },
});
const stream = createWriteStream(OUT);
doc.pipe(stream);

const F_BODY = "Helvetica";
const F_BOLD = "Helvetica-Bold";
const F_OBL = "Helvetica-Oblique";

function pageBreakIfNear(needed: number) {
  if (doc.y + needed > doc.page.height - doc.page.margins.bottom) doc.addPage();
}
function isAtTopOfPage(): boolean {
  return doc.y <= doc.page.margins.top + 2;
}
function startNewPageIfNotAtTop() {
  if (!isAtTopOfPage()) doc.addPage();
}

function chapterTitle(s: string) {
  doc.font(F_BOLD).fontSize(22).fillColor(C.brand).text(s);
  doc.moveTo(doc.page.margins.left, doc.y + 2)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y + 2)
    .lineWidth(1.2).strokeColor(C.rule).stroke();
  doc.moveDown(0.5);
  doc.fillColor(C.ink);
}

function featureTitle(s: string) {
  pageBreakIfNear(28);
  doc.moveDown(0.7);
  doc.font(F_BOLD).fontSize(15).fillColor(C.accent).text(s);
  doc.moveDown(0.15);
  doc.fillColor(C.ink);
}

function metaLine(label: string, value: string) {
  doc.font(F_BOLD).fontSize(9.5).fillColor(C.inkSoft).text(`${label}: `, { continued: true });
  doc.font(F_BODY).fillColor(C.ink).text(value);
}

function sectionLabel(s: string) {
  pageBreakIfNear(18);
  doc.moveDown(0.3);
  doc.font(F_BOLD).fontSize(10.5).fillColor(C.inkSoft).text(s.toUpperCase(), { characterSpacing: 0.5 });
  doc.moveDown(0.1);
  doc.fillColor(C.ink);
}

function paragraph(s: string, opts: { italic?: boolean; soft?: boolean } = {}) {
  doc.font(opts.italic ? F_OBL : F_BODY).fontSize(10.5).fillColor(opts.soft ? C.inkSoft : C.ink);
  doc.text(s);
  doc.moveDown(0.2);
}

function bullet(s: string, color: string = C.ink) {
  doc.font(F_BODY).fontSize(10).fillColor(color);
  doc.text(`• ${s}`, { indent: 14 });
  doc.moveDown(0.05);
}

function step(num: number, action: string, detail?: string) {
  // Reserve space for the step block so the number does not orphan from
  // its action. ~50px is roughly 3 lines at body size.
  pageBreakIfNear(36);
  const numStr = `${num}.`;
  const numWidth = 22;
  const left = doc.page.margins.left;
  const startY = doc.y;
  doc.font(F_BOLD).fontSize(10.5).fillColor(C.brand).text(numStr, left, startY, {
    width: numWidth,
    lineBreak: false,
  });
  doc.font(F_BODY).fontSize(10.5).fillColor(C.ink).text(action, left + numWidth, startY, {
    width: doc.page.width - doc.page.margins.right - left - numWidth,
  });
  if (detail) {
    doc.font(F_OBL).fontSize(10).fillColor(C.inkSoft).text(detail, left + numWidth, doc.y, {
      width: doc.page.width - doc.page.margins.right - left - numWidth,
    });
  }
  doc.moveDown(0.25);
  doc.x = left;
}

function calloutBox(label: string, items: string[], bg: string, accent: string) {
  if (items.length === 0) return;
  // Reserve roughly 20px label + 16px per item; pdfkit auto-paginates inside.
  pageBreakIfNear(28 + items.length * 14);
  doc.moveDown(0.2);
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const startY = doc.y;
  // Draw label first to get final height after rendering items, then draw
  // a backing rectangle. Simpler: draw rect with estimated height, then text.
  const estHeight = 18 + items.length * 16 + 8;
  doc
    .save()
    .rect(left, startY, right - left, estHeight)
    .fillColor(bg)
    .fill()
    .restore();
  doc.font(F_BOLD).fontSize(9.5).fillColor(accent).text(label.toUpperCase(), left + 10, startY + 6, {
    width: right - left - 20,
    characterSpacing: 0.4,
  });
  let y = doc.y + 2;
  for (const it of items) {
    doc.font(F_BODY).fontSize(9.8).fillColor(C.ink).text(`• ${it}`, left + 10, y, {
      width: right - left - 20,
    });
    y = doc.y + 1;
  }
  doc.y = startY + estHeight + 4;
  doc.x = left;
}

function drawFootersOnAllPages() {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const origBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    doc.font(F_BODY).fontSize(8).fillColor(C.inkFaint);
    doc.text(
      "PulseEDU Teacher User Guide",
      doc.page.margins.left,
      doc.page.height - 40,
      { width: w, align: "left", lineBreak: false },
    );
    doc.text(
      `p. ${i + 1} of ${range.count}`,
      doc.page.margins.left,
      doc.page.height - 40,
      { width: w, align: "right", lineBreak: false },
    );
    doc.page.margins.bottom = origBottom;
  }
}

// ---------- Cover ----------
doc.fillColor(C.brand).font(F_BOLD).fontSize(40).text("PulseEDU");
doc.moveDown(0.2);
doc.fillColor(C.ink).fontSize(28).text("Teacher User Guide");
doc.moveDown(0.4);
doc.fillColor(C.inkSoft).font(F_OBL).fontSize(14);
doc.text("Page-by-page, button-by-button instructions for every feature you'll use as a teacher.");
doc.moveDown(2);
doc.fillColor(C.ink).font(F_BODY).fontSize(11);
doc.text(
  "This guide walks you through each feature of PulseEDU as a teacher: where to find it, when to use it, and the exact steps to take. It is written so you can sit down at the computer, follow the steps, and get the task done — even if it's your first day.",
);
doc.moveDown(0.5);
doc.text(
  "How to use this guide: skim the table of contents below, find the feature you need, and follow the numbered steps in order. Tip and Watch-out boxes flag the small things that trip people up.",
);
doc.moveDown(2);
doc.font(F_BOLD).fontSize(13).fillColor(C.accent).text("Contents");
doc.moveDown(0.4);
doc.font(F_BODY).fontSize(11).fillColor(C.ink);
for (const ch of CHAPTERS) {
  doc.text(`• ${ch.title}`);
  for (const f of ch.features) {
    doc.font(F_OBL).fontSize(10).fillColor(C.inkSoft);
    doc.text(`     – ${f.title}`);
    doc.font(F_BODY).fontSize(11).fillColor(C.ink);
  }
}

// ---------- Chapters ----------
for (const ch of CHAPTERS) {
  startNewPageIfNotAtTop();
  chapterTitle(ch.title);
  if (ch.intro) paragraph(ch.intro, { soft: true });

  for (const f of ch.features) {
    featureTitle(f.title);
    metaLine("Where to find it", f.whereToFind);
    metaLine("When to use it", f.whenToUseIt);

    if (f.beforeYouStart && f.beforeYouStart.length) {
      sectionLabel("Before you start");
      for (const b of f.beforeYouStart) bullet(b);
    }

    sectionLabel("Steps");
    f.steps.forEach((s, i) => step(i + 1, s.action, s.detail));

    if (f.tips && f.tips.length) {
      calloutBox("Tips", f.tips, C.bgTip, C.ok);
    }
    if (f.watchOutFor && f.watchOutFor.length) {
      calloutBox("Watch out for", f.watchOutFor, C.bgWarn, C.warn);
    }
  }
}

// ---------- Closing ----------
startNewPageIfNotAtTop();
chapterTitle("Need help?");
paragraph(
  "If a step in this guide doesn't match what you see on your screen, your school may be on a slightly different feature configuration — start by asking your administrator. For a wider feature outage or a bug, send your administrator a screenshot with the date/time and the student you were working on (if any). They have a direct line to engineering.",
);
paragraph(
  "This guide is updated when features change. The version you are reading was generated from the live source on the date printed on the cover.",
  { soft: true, italic: true },
);

drawFootersOnAllPages();
doc.end();

stream.on("finish", () => {
  console.log(`Wrote ${OUT}`);
});
stream.on("error", (e) => {
  console.error(e);
  process.exit(1);
});
