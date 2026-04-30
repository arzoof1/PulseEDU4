// Notification bell for the global header. Shows the count of
// "owed-today" intervention rows for the signed-in teacher (Tier 2 daily
// + Tier 3 weekly day-of-week). Hidden for Core Team users (the server
// returns visible:false in that case).
//
// Polls every 60s plus on a manual refresh trigger so callers can force
// a re-poll after saving an entry.
import { useEffect, useState } from "react";
import { authFetch } from "../lib/authToken";

interface OwedPayload {
  visible: boolean;
  tier2: Array<{ studentId: string }>;
  tier3: Array<{ studentId: string }>;
}

interface Props {
  refreshKey: number;
  onClick: () => void;
}

// Inject the bell's keyframes once. Doing it inside the component
// instead of in a global stylesheet keeps the animation co-located
// with the only thing that uses it. We guard against double-insertion
// in case the component remounts (e.g. role swap).
const BELL_STYLE_ID = "interventions-bell-animations";
function ensureBellStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(BELL_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = BELL_STYLE_ID;
  style.textContent = `
    @keyframes pulseBellShake {
      0%   { transform: rotate(0deg); }
      8%   { transform: rotate(-14deg); }
      16%  { transform: rotate(12deg); }
      24%  { transform: rotate(-8deg); }
      32%  { transform: rotate(6deg); }
      40%  { transform: rotate(0deg); }
      100% { transform: rotate(0deg); }
    }
    @keyframes pulseBellGlow {
      0%, 100% {
        box-shadow:
          0 0 0 0 rgba(168, 85, 247, 0.55),
          0 0 14px 3px rgba(168, 85, 247, 0.35);
      }
      50% {
        box-shadow:
          0 0 0 6px rgba(168, 85, 247, 0),
          0 0 22px 6px rgba(168, 85, 247, 0.7);
      }
    }
    .interventions-bell-btn {
      animation: pulseBellGlow 1.8s ease-in-out infinite;
    }
    .interventions-bell-btn .interventions-bell-icon {
      display: inline-block;
      transform-origin: 50% 10%;
      animation: pulseBellShake 2.2s ease-in-out infinite;
    }
    @media (prefers-reduced-motion: reduce) {
      .interventions-bell-btn,
      .interventions-bell-btn .interventions-bell-icon {
        animation: none !important;
      }
    }
  `;
  document.head.appendChild(style);
}

export default function InterventionsBell({ refreshKey, onClick }: Props) {
  const [count, setCount] = useState(0);
  const [visible, setVisible] = useState(false);

  // Inject the shake/glow keyframes once on mount.
  useEffect(() => {
    ensureBellStyles();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;

    async function poll() {
      try {
        // `cache: "no-store"` is critical here. Without it the browser
        // will send an `If-None-Match` from the previous response's
        // ETag and the server returns 304 with an empty body; `r.ok`
        // is then false (304 is outside the 2xx success range) and we
        // silently exit, leaving the bell hidden after a logout / re-
        // login cycle even though the user has owed interventions.
        const r = await authFetch("/api/interventions/owed-today", {
          cache: "no-store",
        });
        if (!r.ok) return;
        const data = (await r.json()) as OwedPayload;
        if (cancelled) return;
        const total =
          (Array.isArray(data.tier2) ? data.tier2.length : 0) +
          (Array.isArray(data.tier3) ? data.tier3.length : 0);
        setVisible(Boolean(data.visible) && total > 0);
        setCount(total);
      } catch {
        /* swallow */
      }
    }

    poll();
    interval = setInterval(poll, 60_000);
    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  }, [refreshKey]);

  if (!visible || count <= 0) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      className="interventions-bell-btn"
      title={`${count} intervention${count === 1 ? "" : "s"} to log today`}
      style={{
        position: "relative",
        background: "rgba(168, 85, 247, 0.12)",
        border: "1px solid rgba(168, 85, 247, 0.55)",
        cursor: "pointer",
        padding: "0.3rem 0.55rem",
        fontSize: "1.25rem",
        borderRadius: 999,
        marginRight: "0.25rem",
      }}
      aria-label={`${count} interventions owed today`}
    >
      <span className="interventions-bell-icon" aria-hidden="true">
        🔔
      </span>
      <span
        style={{
          position: "absolute",
          top: -4,
          right: -4,
          background: "#dc2626",
          color: "white",
          fontSize: "0.7rem",
          padding: "1px 5px",
          borderRadius: 999,
          fontWeight: 700,
          minWidth: 18,
          boxShadow: "0 0 0 2px white",
        }}
      >
        {count}
      </span>
    </button>
  );
}
