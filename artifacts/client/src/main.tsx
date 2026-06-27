import { createRoot } from "react-dom/client";
import App from "./App";
import Kiosk from "./Kiosk";
import KioskViewer from "./KioskViewer";
import KioskCodeMirror from "./KioskCodeMirror";
import ParentApp from "./parent/ParentApp";
import StudentApp from "./student/StudentApp";
import SignageApp from "./signage/SignageApp";
import PickupApp from "./pickup/PickupApp";
import TourApp from "./tour/TourApp";
import ScannerApp from "./scan/ScannerApp";
import StaffResetApp from "./StaffResetApp";
import SignApp from "./sign/SignApp";
import RecordingStudio from "./studio/RecordingStudio";
import "./index.css";

const path = window.location.pathname;
// Order matters: /kiosk-view/<token> must be checked BEFORE /kiosk so
// the read-only mirror page wins the dispatch instead of falling into
// the full kiosk activation flow.
const isKioskViewer = path.includes("/kiosk-view");
// Phone "carry over" mirror for a teacher's activation code
// (/kiosk-code#t=...&p=...). Checked before /kiosk so the read-only display
// page wins the dispatch instead of falling into the full activation flow.
const isKioskCode = path.includes("/kiosk-code");
const isKiosk = !isKioskViewer && !isKioskCode && path.includes("/kiosk");
const isParent = path.includes("/parent");
// Student HeartBEAT portal (/student). Anchored to the path SEGMENT
// (exactly "/student" or "/student/...") so it never collides with staff
// deep links that merely contain the substring (e.g. "/student-lookup").
const isStudent = /\/student(?:\/|$)/.test(path);
// Public, unauthenticated staff self-service password reset pages
// (/forgot-password, /reset-password/<token>). Checked AFTER isParent
// because the parent portal owns its own /parent/...-prefixed variants
// which contain these same substrings.
const isStaffReset =
  !isParent &&
  (path.includes("/forgot-password") || path.includes("/reset-password"));
const isSignage = path.includes("/signage");
const isPickup = path.includes("/pickup");
// Public, unauthenticated School Tours surface (brag page + request form +
// post-tour survey). Dispatched before the staff <App/>.
const isTour = path.includes("/tour");
// Gate admission scanner for Event Ticketing. Two modes off the URL:
//   /scan             — staff scanner (requires staff session)
//   /scan/<linkToken> — no-login volunteer scanner
const isScan = path.includes("/scan");
// Public, unauthenticated document e-sign page (/sign/<token>). Must be
// checked AFTER isSignage — "/signage" also contains the "/sign" substring,
// and the signage player must win that dispatch.
const isSign = !isSignage && path.includes("/sign");
// Standalone video Recording Studio (/studio) — opened in its own tab so the
// camera/mic work outside the Replit preview iframe.
const isStudio = path.includes("/studio");

createRoot(document.getElementById("root")!).render(
  isStudio ? <RecordingStudio />
    : isSignage ? <SignageApp />
    : isKioskViewer ? <KioskViewer />
    : isKioskCode ? <KioskCodeMirror />
    : isKiosk ? <Kiosk />
    : isParent ? <ParentApp />
    : isStudent ? <StudentApp />
    : isStaffReset ? <StaffResetApp />
    : isPickup ? <PickupApp />
    : isTour ? <TourApp />
    : isScan ? <ScannerApp />
    : isSign ? <SignApp />
    : <App />,
);
