import { createRoot } from "react-dom/client";
import App from "./App";
import Kiosk from "./Kiosk";
import ParentApp from "./parent/ParentApp";
import "./index.css";

const path = window.location.pathname;
const isKiosk = path.includes("/kiosk");
const isParent = path.includes("/parent");

createRoot(document.getElementById("root")!).render(
  isKiosk ? <Kiosk /> : isParent ? <ParentApp /> : <App />,
);
