import { createRoot } from "react-dom/client";
import App from "./App";
import Kiosk from "./Kiosk";
import ParentApp from "./parent/ParentApp";
import SignageApp from "./signage/SignageApp";
import "./index.css";

const path = window.location.pathname;
const isKiosk = path.includes("/kiosk");
const isParent = path.includes("/parent");
const isSignage = path.includes("/signage");

createRoot(document.getElementById("root")!).render(
  isSignage ? <SignageApp />
    : isKiosk ? <Kiosk />
    : isParent ? <ParentApp />
    : <App />,
);
