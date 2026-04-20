import {
  Document,
  Packer,
  Paragraph,
  HeadingLevel,
  TextRun,
  AlignmentType,
} from "docx";
import { writeFileSync } from "node:fs";

const H = (text, level = HeadingLevel.HEADING_1) =>
  new Paragraph({ heading: level, spacing: { before: 240, after: 120 }, children: [new TextRun({ text, bold: true })] });
const P = (text, opts = {}) =>
  new Paragraph({ spacing: { after: 100 }, children: [new TextRun({ text, ...opts })] });
const BULLET = (text, level = 0) =>
  new Paragraph({ bullet: { level }, spacing: { after: 60 }, children: [new TextRun(text)] });
const BULLET_RICH = (runs, level = 0) =>
  new Paragraph({ bullet: { level }, spacing: { after: 60 }, children: runs });
const TITLE = (text) =>
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 240 },
    children: [new TextRun({ text, bold: true, size: 44 })],
  });
const SUB = (text) =>
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 360 },
    children: [new TextRun({ text, italics: true, color: "666666", size: 22 })],
  });

const children = [
  TITLE("PulseED"),
  SUB("School Operations App — Internal Test Build (April 2026)"),

  H("What it is"),
  P(
    "PulseED is a single-page web app that gives a school's staff one unified place to track everyday student-flow events: hall passes, tardies, PBIS points, behavior incidents, accommodations, pullout services, and parent communication. It replaces a stack of paper logs, spreadsheets, and ad-hoc emails with one shared real-time record that any staff member can see and act on from a phone, tablet, Chromebook, or kiosk."
  ),
  P(
    "Access is governed by per-page capabilities. Job titles (Teacher, Dean, Behavior Specialist, ESE Coordinator, PBIS Coordinator, Admin) are presets that pre-flip the right capabilities, but admins can hand-tune any individual staff member's access on the Page Access table."
  ),

  H("Core modules"),

  H("1. Hall Passes", HeadingLevel.HEADING_2),
  BULLET("Any teacher can issue a pass: pick the student, where they're going (Bathroom, Office, Nurse, Counselor, Library, Custom destination, etc.), and start the timer."),
  BULLET("Live dashboard of every active pass across the building, color-coded by elapsed time (green / yellow / red / overdue)."),
  BULLET("End a pass with one click when the student returns."),
  BULLET("Per-student pass history with totals, longest pass, and frequency."),
  BULLET("Per-location coverage grid showing how many students are currently at each destination."),
  BULLET("Permitted-destinations control: each room can be configured to only allow certain destinations from its kiosk."),
  BULLET("Capability gating: regular teachers see and manage their own passes; staff with the \"view all\" capability (deans, admins) see every pass building-wide."),

  H("2. Tardies / Check-Ins", HeadingLevel.HEADING_2),
  BULLET("Quick log for a student arriving late, including reason (overslept, medical, parent note, etc.)."),
  BULLET("Per-student tardy history and running counts."),
  BULLET("Filter by today / all records and by my staff / all staff."),

  H("3. Student Activity", HeadingLevel.HEADING_2),
  BULLET("Search any student and see a unified timeline: hall passes, tardies, PBIS points, behavior interventions, parent contacts, support notes, accommodations, and pullouts."),
  BULLET("Snapshot view of running totals (passes this week, tardies this month, PBIS balance, etc.)."),
  BULLET("One-stop place to research a student before a meeting, parent call, or incident response."),

  H("4. PBIS Points", HeadingLevel.HEADING_2),
  BULLET("Award positive-behavior points to students with a reason tag (respectful, on-task, helpful, leadership, etc.)."),
  BULLET("Per-student running balance."),
  BULLET("PBIS Coordinator (or anyone with the PBIS Manage capability) can edit the list of point reasons and the catalog the school uses."),
  BULLET("Foundation laid for an upcoming PBIS Store / redemption flow (planned)."),

  H("5. Parent Email", HeadingLevel.HEADING_2),
  BULLET("Send a parent a templated message (positive shout-out, concern, attendance, etc.) directly from the student's record."),
  BULLET("Sent via Resend so it lands in real inboxes."),
  BULLET("Logged on the student's timeline so any staff member can see what's already been communicated."),
  BULLET("Test-window note: until the school's sending domain is verified in Resend, mail goes from the default Resend sender; verify the domain before parent-facing rollout."),

  H("6. Support Notes", HeadingLevel.HEADING_2),
  BULLET("Lightweight private staff-to-staff notes attached to a student (\"Mom called, dad has visitation Thursday,\" \"Avoid pairing with X,\" etc.)."),
  BULLET("Visible to other staff on that student's profile so context isn't lost when shifts or teachers change."),

  H("7. Accommodations (ESE / 504)", HeadingLevel.HEADING_2),
  BULLET("Master list of every student with an accommodation, the specific accommodation text, and which staff are responsible."),
  BULLET("\"By Accommodation\" roster view — pick any accommodation, see every student who needs it; useful for substitute coverage and audit."),
  BULLET("ESE Coordinator (or anyone with the Accommodation Manage capability) edits the list; everyone with read access sees it on the student's record."),

  H("8. Behavior Interventions", HeadingLevel.HEADING_2),
  BULLET("Log an intervention (verbal redirect, conference, parent contact, restorative conversation, ISS, etc.) with the staff member, time, and notes."),
  BULLET("Reviewable queue for the Dean / Behavior Specialist / Admin so nothing falls through the cracks."),
  BULLET("Behavior Review page: anyone with the Pullouts Review capability can mark unreviewed incidents as handled."),
  BULLET("Intervention Manage capability controls who can edit the master list of intervention types."),

  H("9. Pullouts", HeadingLevel.HEADING_2),
  BULLET("Teachers can request that a behavior specialist or counselor pull a student out of class — pick the student, the reason (de-escalation, check-in, scheduled session, etc.), and submit."),
  BULLET("Verify queue: staff with the Pullouts Verify capability (typically the Dean) confirm whether the pullout actually happened."),
  BULLET("Review queue: staff with the Pullouts Review capability (typically the Behavior Specialist) close out and document the session."),
  BULLET("Pullout Reasons list is editable by anyone with the Pullouts Review capability."),
  BULLET("4pm weekday digest email summarizes pending and unreviewed pullouts to the Dean / Behavior Specialist (currently disabled for the test window — re-enable by removing the DIGEST_DISABLED flag)."),

  H("10. ISS Dashboard", HeadingLevel.HEADING_2),
  BULLET("Live roster of who is currently in In-School Suspension, when they checked in, and who they're assigned to."),
  BULLET("Visible only to staff with the ISS Dashboard capability."),

  H("11. Kiosk Mode", HeadingLevel.HEADING_2),
  BULLET("Any classroom Chromebook or tablet can be activated as a room kiosk via a one-time activation code."),
  BULLET("Students self-serve a hall pass at the kiosk: tap their name, pick a destination from the room's allowed list, go."),
  BULLET("Teacher confirmation / fraud safeguards built in so students can't kiosk themselves out without staff awareness."),
  BULLET("Future kiosk options (additional confirmation modes 3/4/5) are scaffolded but not enabled in this test build."),

  H("12. Daily Digest Email", HeadingLevel.HEADING_2),
  BULLET("Scheduled email at 4pm on weekdays summarizing the day's pullout activity and any unreviewed backlog."),
  BULLET("Sent via Resend to the configured digest recipient."),
  BULLET("Currently disabled (DIGEST_DISABLED=1 set on the deployment) so the test team isn't spammed during the trial."),

  H("Roles, capabilities, and access control"),
  P(
    "Every page in the app is gated by a named capability stored on the staff record. The role label (Admin, Dean, Behavior Specialist, ESE Coordinator, PBIS Coordinator, Teacher) is just a preset that flips a bundle of capabilities on at once. Once a user is created, an admin can fine-tune any individual capability on the Page Access table — for example, granting one teacher the \"view all hall passes\" capability without making them an admin."
  ),
  P("Capabilities currently in use:", { bold: true }),
  BULLET("capHallPassesViewAll — see every hall pass in the building, not just your own."),
  BULLET("capPbisManage — edit PBIS reasons / catalog."),
  BULLET("capAccommodationManage — edit student accommodations and roster."),
  BULLET("capPulloutsVerify — confirm whether requested pullouts happened (Dean queue)."),
  BULLET("capPulloutsReview — close out completed pullouts and edit pullout reasons (Behavior Specialist queue)."),
  BULLET("capInterventionManage — edit the master list of intervention types and behavior categories."),
  BULLET("capIssDashboard — see the live ISS roster."),
  BULLET("capManageLocations — edit rooms, destinations, and which destinations each room allows."),
  BULLET("capManageStaff — create / edit staff accounts and assign capabilities."),
  P("(Plus a self-lockout safeguard: an admin cannot remove their own capManageStaff while logged in, preventing accidental loss of admin access.)"),

  H("Test team for tonight's launch"),
  BULLET("Brandon Wright — Admin (all capabilities)."),
  BULLET("Chris Clifford — Admin (all capabilities)."),
  BULLET("Carrie LaBarge — Dean of Students (Pullouts Verify, Intervention Manage, plus teacher defaults)."),
  BULLET("Lamon Neal — Behavior Specialist (Pullouts Review, Intervention Manage, plus teacher defaults)."),
  BULLET("Kelly Smith — Teacher / Guidance Counselor (teacher defaults)."),
  BULLET("Jessica Bates — Teacher (teacher defaults)."),
  BULLET("Shannon Brening — Teacher (teacher defaults)."),
  P("Shared test password: PulseED-launch-2026!  (Admins can rotate via the Page Access table.)"),

  H("How the data flows"),
  BULLET("Single shared Postgres database — every action is immediately visible to every other logged-in user."),
  BULLET("All sensitive actions are server-validated against the user's capabilities, so even if the UI is bypassed, the API will reject an unauthorized request with a 403."),
  BULLET("Sessions are cookie-based with a server-side secret; sign-out clears the session immediately."),
  BULLET("Parent emails and digest emails go out through Resend."),
  BULLET("The current test build runs against a demo dataset of ~600 fictional students so testers can exercise every flow without touching real student data."),

  H("UI conventions"),
  BULLET("Top header: PulseED brand, a global \"show today / show all\" filter, a global \"my records / all staff\" filter, and the user's identity / sign-out pill."),
  BULLET("Left sidebar: the Workspace section (the modules a user can use to take action), and below the EKG divider the Tools section (admin / oversight items, only shown to staff with the relevant capability)."),
  BULLET("Sticky table headers — column headers stay visible as you scroll long lists."),
  BULLET("Print-friendly: each card prints cleanly without the sidebar, header, or interactive controls (useful for accommodation rosters, ISS lists, etc.)."),
  BULLET("Mobile / narrow-screen layout: sidebar collapses into a horizontal scroller across the top."),

  H("Known limitations in this test build"),
  BULLET("Shared password — there is no self-serve password change yet. Admins can rotate from the Page Access table."),
  BULLET("No login rate-limiting (acceptable for a 7-person internal test on a demo DB)."),
  BULLET("Resend sending domain is unverified — parent emails will go from the default Resend sender. Don't email real parents during the test."),
  BULLET("Daily digest cron is currently disabled for the test window (DIGEST_DISABLED=1)."),
  BULLET("Demo students are fictional (Alex Thompson, Jordan Martinez, etc.); real student/SIS sync is not in this build."),
  BULLET("Some kiosk confirmation modes (options 3, 4, 5) are scaffolded but not enabled."),

  H("On the post-launch wishlist"),
  BULLET("PBIS Store — students/parents log in to redeem points for items; staff fulfill orders."),
  BULLET("Houses — randomly balanced student houses with a leaderboard and a splash page."),
  BULLET("End-of-day teacher email — period-by-period roster of who left class on a pass plus a kiosk-fraud detector (sibling of the daily digest)."),
  BULLET("Self-serve password change / reset."),
  BULLET("Login rate-limiting and brute-force protection."),
  BULLET("Hall-pass timer recovery on browser refresh."),
  BULLET("Resend domain verification for parent-facing email."),
  BULLET("SMS notifications via Twilio."),

  H("Tech, in plain English"),
  P(
    "PulseED is a React single-page app on the front end, an Express API on the back end, and a Postgres database — all in one deployable bundle. Authentication is session cookies with bcrypt password hashing. Email is via Resend. Scheduled jobs use node-cron. The whole thing lives in a pnpm monorepo so the front end, API, and shared database schema can evolve together without drift."
  ),
];

const doc = new Document({
  creator: "PulseED",
  title: "PulseED — App Overview",
  description: "Internal test build overview",
  styles: {
    default: {
      document: { run: { font: "Calibri", size: 22 } },
    },
  },
  sections: [{ properties: {}, children }],
});

const buffer = await Packer.toBuffer(doc);
const out = "exports/PulseED-Overview.docx";
writeFileSync(out, buffer);
console.log("Wrote", out, buffer.length, "bytes");
