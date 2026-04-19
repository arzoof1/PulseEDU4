import { createRoot } from "react-dom/client";
import App from "./App";
import Kiosk from "./Kiosk";
import "./index.css";

const isKiosk = window.location.pathname.includes("/kiosk");

createRoot(document.getElementById("root")!).render(
  isKiosk ? <Kiosk /> : <App />,
);
