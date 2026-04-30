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
  totalOwed: number;
}

interface Props {
  refreshKey: number;
  onClick: () => void;
}

export default function InterventionsBell({ refreshKey, onClick }: Props) {
  const [count, setCount] = useState(0);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;

    async function poll() {
      try {
        const r = await authFetch("/api/interventions/owed-today");
        if (!r.ok) return;
        const data = (await r.json()) as OwedPayload;
        if (cancelled) return;
        setVisible(Boolean(data.visible));
        setCount(data.totalOwed ?? 0);
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
      title={`${count} intervention${count === 1 ? "" : "s"} to log today`}
      style={{
        position: "relative",
        background: "transparent",
        border: "none",
        cursor: "pointer",
        padding: "0.3rem 0.5rem",
        fontSize: "1.25rem",
      }}
      aria-label={`${count} interventions owed today`}
    >
      🔔
      <span
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          background: "#dc2626",
          color: "white",
          fontSize: "0.7rem",
          padding: "1px 5px",
          borderRadius: 999,
          fontWeight: 700,
          minWidth: 18,
        }}
      >
        {count}
      </span>
    </button>
  );
}
