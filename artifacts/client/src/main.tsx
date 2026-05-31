import { createRoot } from "react-dom/client";
import App from "./App";
import Kiosk from "./Kiosk";
import KioskViewer from "./KioskViewer";
import ParentApp from "./parent/ParentApp";
import SignageApp from "./signage/SignageApp";
import PickupApp from "./pickup/PickupApp";
import TourApp from "./tour/TourApp";
import ScannerApp from "./scan/ScannerApp";
import "./index.css";

const path = window.location.pathname;
// Order matters: /kiosk-view/<token> must be checked BEFORE /kiosk so
// the read-only mirror page wins the dispatch instead of falling into
// the full kiosk activation flow.
const isKioskViewer = path.includes("/kiosk-view");
const isKiosk = !isKioskViewer && path.includes("/kiosk");
const isParent = path.includes("/parent");
const isSignage = path.includes("/signage");
const isPickup = path.includes("/pickup");
// Public, unauthenticated School Tours surface (brag page + request form +
// post-tour survey). Dispatched before the staff <App/>.
const isTour = path.includes("/tour");
// Gate admission scanner for Event Ticketing. Two modes off the URL:
//   /scan             — staff scanner (requires staff session)
//   /scan/<linkToken> — no-login volunteer scanner
const isScan = path.includes("/scan");

createRoot(document.getElementById("root")!).render(
  isSignage ? <SignageApp />
    : isKioskViewer ? <KioskViewer />
    : isKiosk ? <Kiosk />
    : isParent ? <ParentApp />
    : isPickup ? <PickupApp />
    : isTour ? <TourApp />
    : isScan ? <ScannerApp />
    : <App />,
);
