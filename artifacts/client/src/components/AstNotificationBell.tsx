// AST clock pill for the global header — ADMIN side only.
// Visible only to approvers when the queue has items. Shows the clock
// icon with the word "AST" and a count badge so it reads as
// "AST queue has work" at a glance. Click jumps to the approvals page.
//
// The staff-side counterpart is a small badge rendered next to the
// "AST" item in the left sidebar (see AstSidebarBadge).
import { useEffect, useState } from "react";
import { authFetch } from "../lib/authToken";

interface Props {
  refreshKey: number;
  canApproveAst: boolean;
  onOpenAdmin: () => void;
}

const STYLE_ID = "ast-bell-animations";
function ensureStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    @keyframes astBellTick {
      0%, 100% { transform: rotate(0deg); }
      25%      { transform: rotate(-10deg); }
      75%      { transform: rotate(10deg); }
    }
    @keyframes astBellGlow {
      0%, 100% {
        box-shadow:
          0 0 0 0 rgba(59, 130, 246, 0.55),
          0 0 14px 3px rgba(59, 130, 246, 0.35);
      }
      50% {
        box-shadow:
          0 0 0 6px rgba(59, 130, 246, 0),
          0 0 22px 6px rgba(59, 130, 246, 0.7);
      }
    }
    .ast-bell-btn {
      animation: astBellGlow 2.2s ease-in-out infinite;
    }
    .ast-bell-btn .ast-bell-icon {
      display: inline-block;
      transform-origin: 50% 50%;
      animation: astBellTick 2.4s ease-in-out infinite;
    }
    @media (prefers-reduced-motion: reduce) {
      .ast-bell-btn,
      .ast-bell-btn .ast-bell-icon { animation: none !important; }
    }
  `;
  document.head.appendChild(style);
}

export default function AstNotificationBell({
  refreshKey,
  canApproveAst,
  onOpenAdmin,
}: Props) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    ensureStyles();
  }, []);

  useEffect(() => {
    if (!canApproveAst) {
      setCount(0);
      return;
    }
    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;

    async function poll() {
      try {
        const r = await authFetch("/api/ast/admin-pending-count", {
          cache: "no-store",
        });
        if (!r.ok) return;
        const d = (await r.json()) as { count?: number };
        if (cancelled) return;
        setCount(Number(d?.count ?? 0));
      } catch {
        /* swallow */
      }
    }

    void poll();
    interval = setInterval(poll, 60_000);
    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  }, [refreshKey, canApproveAst]);

  if (!canApproveAst || count <= 0) return null;
  const title = `${count} AST request${count === 1 ? "" : "s"} awaiting your approval`;

  return (
    <button
      type="button"
      onClick={onOpenAdmin}
      className="ast-bell-btn"
      title={title}
      aria-label={title}
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        background: "rgba(59, 130, 246, 0.12)",
        border: "1px solid rgba(59, 130, 246, 0.55)",
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
        className="ast-bell-icon"
        aria-hidden="true"
        style={{ fontSize: "1.15rem" }}
      >
        ⏰
      </span>
      <span style={{ fontWeight: 600, fontSize: "0.85rem" }}>AST</span>
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
