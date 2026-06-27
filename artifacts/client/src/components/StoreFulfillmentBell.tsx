// Pulsing cart pill for the global header — Core Team / PBIS-coordinator
// fulfillment crew only. Visible only when the School Store has redemptions
// awaiting action (approval or fulfillment). Shows a cart icon with the word
// "Store" and a count badge so it reads as "Store has orders to fill" at a
// glance. Click jumps to the fulfillment dashboard.
import { useEffect, useState } from "react";
import { authFetch } from "../lib/authToken";

interface Props {
  refreshKey: number;
  canFulfillStore: boolean;
  onOpen: () => void;
}

const STYLE_ID = "store-bell-animations";
function ensureStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    @keyframes storeBellTick {
      0%, 100% { transform: rotate(0deg); }
      25%      { transform: rotate(-9deg); }
      75%      { transform: rotate(9deg); }
    }
    @keyframes storeBellGlow {
      0%, 100% {
        box-shadow:
          0 0 0 0 rgba(147, 51, 234, 0.55),
          0 0 14px 3px rgba(147, 51, 234, 0.35);
      }
      50% {
        box-shadow:
          0 0 0 6px rgba(147, 51, 234, 0),
          0 0 22px 6px rgba(147, 51, 234, 0.7);
      }
    }
    .store-bell-btn {
      animation: storeBellGlow 2.2s ease-in-out infinite;
    }
    .store-bell-btn .store-bell-icon {
      display: inline-block;
      transform-origin: 50% 50%;
      animation: storeBellTick 2.4s ease-in-out infinite;
    }
    @media (prefers-reduced-motion: reduce) {
      .store-bell-btn,
      .store-bell-btn .store-bell-icon { animation: none !important; }
    }
  `;
  document.head.appendChild(style);
}

export default function StoreFulfillmentBell({
  refreshKey,
  canFulfillStore,
  onOpen,
}: Props) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    ensureStyles();
  }, []);

  useEffect(() => {
    if (!canFulfillStore) {
      setCount(0);
      return;
    }
    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;

    async function poll() {
      try {
        const r = await authFetch("/api/school-store/pending-count", {
          cache: "no-store",
        });
        if (!r.ok) return;
        const d = (await r.json()) as { total?: number };
        if (cancelled) return;
        setCount(Number(d?.total ?? 0));
      } catch {
        /* swallow */
      }
    }

    void poll();
    interval = setInterval(poll, 30_000);
    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  }, [refreshKey, canFulfillStore]);

  if (!canFulfillStore || count <= 0) return null;
  const title = `${count} School Store order${count === 1 ? "" : "s"} awaiting fulfillment`;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="store-bell-btn"
      title={title}
      aria-label={title}
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        background: "rgba(147, 51, 234, 0.12)",
        border: "1px solid rgba(147, 51, 234, 0.6)",
        cursor: "pointer",
        padding: "0.3rem 0.65rem",
        fontSize: "1rem",
        borderRadius: 999,
        marginRight: "0.25rem",
        lineHeight: 1,
        color: "var(--text, #0f172a)",
      }}
    >
      <span
        className="store-bell-icon"
        aria-hidden="true"
        style={{ fontSize: "1.15rem" }}
      >
        🛒
      </span>
      <span style={{ fontWeight: 600, fontSize: "0.85rem" }}>Store</span>
      <span
        style={{
          position: "absolute",
          top: -4,
          right: -4,
          background: "#7c3aed",
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
