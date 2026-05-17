import { existsSync, mkdirSync, createWriteStream, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../");
const SHOTS_DIR = path.join(repoRoot, "attached_assets/userguide_screens");
const OUT_PATH = path.join(repoRoot, "attached_assets/PulseEDU_User_Guide.pdf");
if (!existsSync(path.dirname(OUT_PATH))) {
  mkdirSync(path.dirname(OUT_PATH), { recursive: true });
}

type Role =
  | "Teacher"
  | "Admin"
  | "Counselor"
  | "MTSS Coord"
  | "Front office"
  | "Parent"
  | "Any";

interface Feature {
  n: number;
  file: string;
  title: string;
  top12: boolean;
  role: Role;
  whatItIs: string;
  howToUse: string[];
  section: string;
}

const FEATURES: Feature[] = [
  {
    n: 1, file: "01-hallpass-queue.png", title: "Hall Pass — Live Queue", top12: true, role: "Teacher",
    section: "Hall Pass + Tardy",
    whatItIs: "Real-time view of who is out of the room, where they went, and how long they've been gone. Auto-resets at each bell period.",
    howToUse: [
      "Open Sidebar → Hall Passes to see your active queue.",
      "Timers turn yellow at 5 min, red at 10 min — long passes flag for follow-up.",
      "Tap a row to close the pass when the student returns.",
    ],
  },
  {
    n: 2, file: "02-hallpass-create.png", title: "Hall Pass — Create Pass", top12: true, role: "Teacher",
    section: "Hall Pass + Tardy",
    whatItIs: "Issue a hall pass from a per-teacher allowlist of destinations. Restrooms group to the left so the closest one is a single click.",
    howToUse: [
      "Click '+ New pass' and pick the student.",
      "Pick a destination — your allowed list comes from your room's location.",
      "Pass appears in the queue immediately.",
    ],
  },
  {
    n: 3, file: "03-hallpass-tardy.png", title: "Hall Pass — Tardy Pass", top12: true, role: "Teacher",
    section: "Hall Pass + Tardy",
    whatItIs: "Late-to-class tardy passes that count toward tardy reports without polluting hall-pass minutes.",
    howToUse: [
      "From Hall Passes, switch to the Tardy tab.",
      "Pick the student and (optionally) the reason.",
      "Tardy logs feed Insights → Behavior so you can spot patterns.",
    ],
  },
  {
    n: 4, file: "04-pbis-hub.png", title: "PBIS Hub", top12: true, role: "Teacher",
    section: "Behavior & PBIS",
    whatItIs: "Class-level positive-behavior point center. Award points, see house affiliation, redeem in the Classroom Store.",
    howToUse: [
      "Open Sidebar → PBIS Hub to see your roster with house badges.",
      "Tap a student card → pick a PBIS reason → points post immediately.",
      "Roster cards show running point totals and recent recognitions.",
    ],
  },
  {
    n: 5, file: "05-pbis-spotlight.png", title: "PBIS Spotlight", top12: false, role: "Teacher",
    section: "Behavior & PBIS",
    whatItIs: "Random-student recognition draw with a quartile-tiered governor that keeps the house race fair when one house runs away with the lead.",
    howToUse: [
      "From PBIS Hub, click 'Spotlight'.",
      "A student is selected at random; the reveal shows the point value (1–10) that was awarded.",
      "Award persists immediately — no second confirmation step.",
    ],
  },
  {
    n: 6, file: "06-pbis-houses.png", title: "House Standings", top12: true, role: "Any",
    section: "Behavior & PBIS",
    whatItIs: "Live school-wide house leaderboard. Drives the spotlight governor and the digital signage standings tile.",
    howToUse: [
      "Visible on PBIS Hub and on any signage TV that includes the standings tile.",
      "Totals update in real time as points are awarded.",
    ],
  },
  {
    n: 7, file: "07-school-store.png", title: "School Store", top12: true, role: "Admin",
    section: "PBIS Rewards",
    whatItIs: "School-wide reward catalog. Admins/PBIS coordinators edit; teachers see read-only and redeem from a student's points.",
    howToUse: [
      "Open Sidebar → School Store.",
      "Click '+ Add item' to upload an image, name, and point cost.",
      "Items go live to the whole school immediately.",
    ],
  },
  {
    n: 8, file: "08-classroom-store.png", title: "Classroom Store", top12: false, role: "Teacher",
    section: "PBIS Rewards",
    whatItIs: "Each teacher's personal reward catalog. Live alongside the School Store; teachers fully control their own.",
    howToUse: [
      "Open Sidebar → Classroom Store.",
      "Add items, set point costs, mark in-stock counts.",
      "Redeem from a student's PBIS Hub card.",
    ],
  },
  {
    n: 9, file: "09-pickup-curb.png", title: "Pickup — Curb Keypad", top12: true, role: "Front office",
    section: "Parent Pick-Up",
    whatItIs: "Phone-first numeric keypad at the curb. Parent enters their tag number; their authorized students roll up automatically.",
    howToUse: [
      "Open a kiosk to /pickup/curb.",
      "Front-office staff types the parent's 4-digit tag number.",
      "Authorized students appear; tap each to release to the car.",
      "Restricted tags require a justification override.",
    ],
  },
  {
    n: 10, file: "10-pickup-walkers.png", title: "Pickup — Walker Gate", top12: false, role: "Front office",
    section: "Parent Pick-Up",
    whatItIs: "Walker dismissal gate. Enforces the bell window so walkers can't leave before dismissal.",
    howToUse: [
      "Open /pickup/walkers.",
      "Before the bell window, the gate shows a 'not yet open' banner.",
      "Inside the window, staff can release walkers individually.",
    ],
  },
  {
    n: 11, file: "11-pickup-tags.png", title: "Pickup — Tag Management", top12: false, role: "Admin",
    section: "Parent Pick-Up",
    whatItIs: "Admin tool to issue and reissue parent pickup tags. Bulk start-of-year assign, lost-tag reissue, batch PDF printing with QR codes.",
    howToUse: [
      "Settings → Pickup Tags.",
      "Use 'Bulk start-of-year' to assign every active student's primary guardian.",
      "Click 'Print PDF' to generate single or batch tag sheets.",
      "Warning fires at 80% of the number range.",
    ],
  },
  {
    n: 12, file: "12-pickup-still-on-campus.png", title: "Pickup — Still on Campus", top12: false, role: "Admin",
    section: "Parent Pick-Up",
    whatItIs: "Post-cutoff reconciliation tile in the Admin Hub. Groups students still on campus by their dismissal mode so the office can clear the building.",
    howToUse: [
      "After the dismissal cutoff time, the tile appears on the Admin Hub.",
      "Students are grouped by dismissal mode (bus, car, walker, ASP).",
      "Resolve each row by marking the student as picked up or moved to ASP.",
    ],
  },
  {
    n: 13, file: "13-safety-plans-list.png", title: "Safety Plans — List", top12: true, role: "Counselor",
    section: "Safety Plans",
    whatItIs: "Per-student behavioral and physical safety checklists. Guidance counselors and Core Team edit; all staff view.",
    howToUse: [
      "Sidebar → Safety Plans to see all active plans.",
      "Plans are indexed on the student profile and in teacher rosters.",
      "Audit log captures every edit.",
    ],
  },
  {
    n: 14, file: "14-safety-plans-edit.png", title: "Safety Plans — Editor", top12: false, role: "Counselor",
    section: "Safety Plans",
    whatItIs: "Checklist editor backed by a shared library of approved items. Add/remove rows, attach notes, set effective dates.",
    howToUse: [
      "From the plan list, click a student to open the editor.",
      "Pick items from the library or add custom rows.",
      "Save publishes to the student's profile and notifies their teachers.",
    ],
  },
  {
    n: 15, file: "15-mtss-plans.png", title: "MTSS Intervention Plans", top12: true, role: "MTSS Coord",
    section: "MTSS",
    whatItIs: "Tier 2/3 intervention plan tracking with goal setting, strategy categories, and weekly progress monitoring.",
    howToUse: [
      "Sidebar → MTSS Plans to see active plans.",
      "Open a plan to set the goal, frequency, and intervention strategy.",
      "Bell notifications fire when a weekly check-in is due.",
    ],
  },
  {
    n: 16, file: "16-mtss-progress.png", title: "MTSS — Progress Monitoring", top12: false, role: "MTSS Coord",
    section: "MTSS",
    whatItIs: "Weekly progress chart with trend line and goal line. Drives the completion report at plan close-out.",
    howToUse: [
      "From a plan, switch to Progress tab.",
      "Add a weekly data point; the chart auto-updates.",
      "Close the plan to generate a completion report PDF.",
    ],
  },
  {
    n: 17, file: "17-teacher-roster.png", title: "Teacher Roster", top12: true, role: "Teacher",
    section: "Roster",
    whatItIs: "Each teacher's class roster with FAST scores, ESE/504/ELL program flags, and safety-plan indicators in one view.",
    howToUse: [
      "Sidebar → Roster.",
      "Click any student to drill into their profile.",
      "Core Team members can switch to any teacher's roster.",
    ],
  },
  {
    n: 18, file: "18-display-playlists.png", title: "Displays — Playlist Editor", top12: true, role: "Admin",
    section: "Display Management",
    whatItIs: "Per-school playlist builder for signage TVs. Supports images, video, audio, PDF, and live tiles (PBIS standings, active hall passes, Heartbeat).",
    howToUse: [
      "Sidebar → Displays.",
      "Create a playlist; add items; set duration per item.",
      "Schedule a playlist to a specific TV by location.",
    ],
  },
  {
    n: 19, file: "19-display-signage-tile.png", title: "Displays — Live Signage View", top12: false, role: "Any",
    section: "Display Management",
    whatItIs: "Browser view a TV opens to. Rotates through scheduled items and live tiles.",
    howToUse: [
      "Point the TV's browser at /signage/<playlistId>.",
      "Playlist starts automatically; live tiles refresh on their own cadence.",
    ],
  },
  {
    n: 20, file: "20-parent-portal.png", title: "Parent Portal", top12: true, role: "Parent",
    section: "Parent Outreach",
    whatItIs: "Secure portal for parents to view their student's HeartBEAT data — PBIS, hall passes, tardies, accommodations, staff notes.",
    howToUse: [
      "Parent logs in at /parent with the admin-issued invite.",
      "Sibling switcher lets one parent view multiple students.",
      "Configurable section visibility per school; PDF export available.",
    ],
  },
  {
    n: 21, file: "21-parent-invite-admin.png", title: "Parent Portal — Invites", top12: false, role: "Admin",
    section: "Parent Outreach",
    whatItIs: "Admin tool to issue parent portal invitations and reset access.",
    howToUse: [
      "Settings → Parent invites.",
      "Send invite to the guardian's email of record.",
      "Reset access here if a parent loses their login.",
    ],
  },
  {
    n: 22, file: "22-insights-engagement.png", title: "Insights — Engagement", top12: true, role: "Admin",
    section: "Insights",
    whatItIs: "Engagement dashboard: attendance, tardies, hall-pass volume, on-time check-ins. Trends and top-N lists.",
    howToUse: [
      "Sidebar → Insights → Engagement.",
      "Filter by grade and window; charts re-aggregate in place.",
      "Click any student name to jump into their profile.",
    ],
  },
  {
    n: 23, file: "23-insights-behavior.png", title: "Insights — Behavior", top12: false, role: "Admin",
    section: "Insights",
    whatItIs: "Behavior dashboard: PBIS points by reason, behavior referrals, ISS/OSS counts, top-receivers and top-givers.",
    howToUse: [
      "Sidebar → Insights → Behavior.",
      "Disaggregate by demographic to surface equity gaps.",
    ],
  },
  {
    n: 24, file: "24-insights-early-warning.png", title: "Insights — Early Warning", top12: false, role: "Admin",
    section: "Insights",
    whatItIs: "Composite risk list combining attendance, behavior, and academics. Surfaces students who need outreach this week.",
    howToUse: [
      "Sidebar → Insights → Early Warning.",
      "Sort by risk score; click any row to drill into the student profile.",
    ],
  },
  {
    n: 25, file: "25-data-importer.png", title: "Data Importer", top12: false, role: "Admin",
    section: "Data Operations",
    whatItIs: "Generic CSV importer for assessments, rosters, and behavior data. Template mapping, preview, commit, and rollback.",
    howToUse: [
      "Settings → Data Importer.",
      "Pick the template that matches your file shape.",
      "Upload → preview the parsed rows → commit.",
      "Rollback link is preserved per import run.",
    ],
  },
];

// ---------- PDF ----------
const doc = new PDFDocument({
  size: "LETTER",
  margins: { top: 56, bottom: 56, left: 56, right: 56 },
  bufferPages: true,
  info: {
    Title: "PulseEDU — User Guide",
    Author: "PulseEDU",
    Subject: "Feature-by-feature user guide with screenshots",
  },
});
doc.pipe(createWriteStream(OUT_PATH));

const F_BOLD = "Helvetica-Bold";
const F_BODY = "Helvetica";
const C = {
  brand: "#0369a1",
  brandDark: "#0c4a6e",
  ink: "#0f172a",
  inkSoft: "#475569",
  rule: "#e2e8f0",
  badge: "#facc15",
  badgeInk: "#713f12",
  panel: "#f1f5f9",
};
const pageW = doc.page.width;
const pageH = doc.page.height;
const ML = doc.page.margins.left;
const MR = doc.page.margins.right;
const MT = doc.page.margins.top;
const MB = doc.page.margins.bottom;
const contentW = pageW - ML - MR;

// ---------- Cover ----------
doc.save().rect(0, 0, pageW, 220).fillColor(C.brandDark).fill().restore();
doc.fillColor("#ffffff").font(F_BOLD).fontSize(38).text("PulseEDU", ML, 70);
doc.fillColor("#cbd5e1").font(F_BODY).fontSize(16).text("User Guide", ML, 118);
doc.fillColor("#7dd3fc").font(F_BODY).fontSize(11)
  .text("Feature-by-feature walkthrough with screenshots", ML, 144);
doc.fillColor(C.ink).font(F_BODY).fontSize(11).text(
  `Generated ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}`,
  ML, 260,
);
doc.fillColor(C.ink).font(F_BOLD).fontSize(13).text("How this guide is organized", ML, 290);
doc.fillColor(C.ink).font(F_BODY).fontSize(11).text(
  "The first 12 features (marked ★ TOP) cover what most staff will touch every day. " +
  "The remaining 13 round out the catalog for admins, specialists, and family-facing flows. " +
  "Each entry shows what the feature is, who can use it, how to open it, and a screenshot.",
  ML, doc.y + 4, { width: contentW },
);

// ---------- TOC ----------
doc.addPage();
doc.fillColor(C.ink).font(F_BOLD).fontSize(20).text("Contents", ML, MT);
let tocY = doc.y + 12;
const top12 = FEATURES.filter((f) => f.top12);
const rest = FEATURES.filter((f) => !f.top12);
doc.fillColor(C.brand).font(F_BOLD).fontSize(12).text("Top 12 — daily-use features", ML, tocY);
tocY = doc.y + 6;
for (const f of top12) {
  doc.fillColor(C.ink).font(F_BODY).fontSize(10.5)
    .text(`${String(f.n).padStart(2, "0")}.  ${f.title}`, ML + 8, tocY)
    .text(f.role, ML + contentW - 80, tocY, { width: 80, align: "right" });
  tocY = doc.y + 2;
}
tocY += 8;
doc.fillColor(C.brand).font(F_BOLD).fontSize(12).text("Full catalog (13 more)", ML, tocY);
tocY = doc.y + 6;
for (const f of rest) {
  doc.fillColor(C.ink).font(F_BODY).fontSize(10.5)
    .text(`${String(f.n).padStart(2, "0")}.  ${f.title}`, ML + 8, tocY)
    .text(f.role, ML + contentW - 80, tocY, { width: 80, align: "right" });
  tocY = doc.y + 2;
}

// ---------- Feature pages ----------
function drawScreenshotOrPlaceholder(filename: string, x: number, y: number, w: number, h: number) {
  const filePath = path.join(SHOTS_DIR, filename);
  if (existsSync(filePath)) {
    try {
      doc.image(filePath, x, y, { fit: [w, h], align: "center", valign: "center" });
      doc.save().rect(x, y, w, h).lineWidth(0.5).strokeColor(C.rule).stroke().restore();
      return;
    } catch {
      // fall through to placeholder
    }
  }
  doc.save()
    .rect(x, y, w, h).fillColor(C.panel).fill()
    .rect(x, y, w, h).lineWidth(1).strokeColor(C.rule).dash(4, { space: 4 }).stroke()
    .restore();
  doc.fillColor(C.inkSoft).font(F_BOLD).fontSize(11)
    .text("Screenshot pending", x, y + h / 2 - 18, { width: w, align: "center" });
  doc.fillColor(C.inkSoft).font(F_BODY).fontSize(9)
    .text(`attached_assets/userguide_screens/${filename}`, x, y + h / 2 - 2, { width: w, align: "center" });
}

function renderFeature(f: Feature) {
  doc.addPage();
  // Header strip with number + title + role + top12 badge
  doc.fillColor(C.brand).font(F_BOLD).fontSize(11).text(`${String(f.n).padStart(2, "0")} — ${f.section}`, ML, MT);
  doc.fillColor(C.ink).font(F_BOLD).fontSize(22).text(f.title, ML, doc.y + 2);

  // Role + Top12 badges
  const badgeY = doc.y + 6;
  let bx = ML;
  const roleW = doc.font(F_BOLD).fontSize(9).widthOfString(f.role) + 14;
  doc.save().roundedRect(bx, badgeY, roleW, 16, 8).fillColor(C.brandDark).fill().restore();
  doc.fillColor("#ffffff").font(F_BOLD).fontSize(9).text(f.role, bx + 7, badgeY + 4, { lineBreak: false });
  bx += roleW + 6;
  if (f.top12) {
    const topW = doc.font(F_BOLD).fontSize(9).widthOfString("★ TOP 12") + 14;
    doc.save().roundedRect(bx, badgeY, topW, 16, 8).fillColor(C.badge).fill().restore();
    doc.fillColor(C.badgeInk).font(F_BOLD).fontSize(9).text("★ TOP 12", bx + 7, badgeY + 4, { lineBreak: false });
  }

  // Screenshot frame — landscape ~6.5" x 4"
  const shotY = badgeY + 30;
  const shotW = contentW;
  const shotH = 290;
  drawScreenshotOrPlaceholder(f.file, ML, shotY, shotW, shotH);

  // What it is
  let y = shotY + shotH + 18;
  doc.fillColor(C.brand).font(F_BOLD).fontSize(12).text("What it is", ML, y);
  y = doc.y + 2;
  doc.fillColor(C.ink).font(F_BODY).fontSize(11).text(f.whatItIs, ML, y, { width: contentW });
  y = doc.y + 10;

  // How to use
  doc.fillColor(C.brand).font(F_BOLD).fontSize(12).text("How to use it", ML, y);
  y = doc.y + 4;
  for (const step of f.howToUse) {
    doc.fillColor(C.brand).font(F_BOLD).fontSize(11).text("•", ML, y, { lineBreak: false, width: 10 });
    doc.fillColor(C.ink).font(F_BODY).fontSize(11).text(step, ML + 14, y, { width: contentW - 14 });
    y = doc.y + 3;
  }

  // Footer
  doc.fillColor(C.inkSoft).font(F_BODY).fontSize(9)
    .text(`PulseEDU — User Guide`, ML, pageH - MB + 10, { lineBreak: false })
    .text(`Page ${doc.bufferedPageRange().count}`, ML, pageH - MB + 10, { width: contentW, align: "right" });
}

for (const f of FEATURES) {
  renderFeature(f);
}

doc.end();
console.log(`Wrote ${OUT_PATH}`);
