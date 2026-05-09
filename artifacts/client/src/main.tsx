import { createRoot } from "react-dom/client";
import App from "./App";
import Kiosk from "./Kiosk";
import KioskViewer from "./KioskViewer";
import ParentApp from "./parent/ParentApp";
import SignageApp from "./signage/SignageApp";
import "./index.css";

const path = window.location.pathname;
// Order matters: /kiosk-view/<token> must be checked BEFORE /kiosk so
// the read-only mirror page wins the dispatch instead of falling into
// the full kiosk activation flow.
const isKioskViewer = path.includes("/kiosk-view");
const isKiosk = !isKioskViewer && path.includes("/kiosk");
const isParent = path.includes("/parent");
const isSignage = path.includes("/signage");

createRoot(document.getElementById("root")!).render(
  isSignage ? <SignageApp />
    : isKioskViewer ? <KioskViewer />
    : isKiosk ? <Kiosk />
    : isParent ? <ParentApp />
    : <App />,
);
