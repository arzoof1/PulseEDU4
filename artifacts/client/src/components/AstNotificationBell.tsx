// AST clock bell for the global header. One badge serves both audiences:
//   - Staff side: counts requests THEY need to act on (preapproved earns
//     awaiting completion submission, plus recently-decided requests).
//   - Admin/approver side: counts items in the approval queue.
// Click routes to whichever surface has work — admin queue if the user
// is an approver and there is something pending there, otherwise the
// staff page. Polls every 60s plus on a manual refresh trigger.
import { useEffect, useState } from "react";
import { authFetch } from "../lib/authToken";

interface Props {
  refreshKey: number;
  canApproveAst: boolean;
  onOpenStaff: () => void;
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
  onOpenStaff,
  onOpenAdmin,
}: Props) {
  const [staffCount, setStaffCount] = useState(0);
  const [adminCount, setAdminCount] = useState(0);

  useEffect(() => {
    ensureStyles();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;

    async function poll() {
      try {
        const calls: Promise<Response>[] = [
          authFetch("/api/ast/my-actionable-count", { cache: "no-store" }),
        ];
        if (canApproveAst) {
          calls.push(
            authFetch("/api/ast/admin-pending-count", { cache: "no-store" }),
          );
        }
        const results = await Promise.all(calls);
        if (cancelled) return;
        if (results[0]?.ok) {
          const d = (await results[0].json()) as { count?: number };
          setStaffCount(Number(d?.count ?? 0));
        }
        if (canApproveAst && results[1]?.ok) {
          const d = (await results[1].json()) as { count?: number };
          setAdminCount(Number(d?.count ?? 0));
        }
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
  }, [refreshKey, canApproveAst]);

  const total = staffCount + adminCount;
  if (total <= 0) return null;

  const goAdmin = canApproveAst && adminCount > 0;
  const title = goAdmin
    ? `${adminCount} AST request${adminCount === 1 ? "" : "s"} awaiting your approval`
    : `${staffCount} AST update${staffCount === 1 ? "" : "s"} for you`;

  return (
    <button
      type="button"
      onClick={goAdmin ? onOpenAdmin : onOpenStaff}
      className="ast-bell-btn"
      title={title}
      aria-label={title}
      style={{
        position: "relative",
        background: "rgba(59, 130, 246, 0.12)",
        border: "1px solid rgba(59, 130, 246, 0.55)",
        cursor: "pointer",
        padding: "0.3rem 0.55rem",
        fontSize: "1.25rem",
        borderRadius: 999,
        marginRight: "0.25rem",
        lineHeight: 1,
      }}
    >
      <span className="ast-bell-icon" aria-hidden="true">
        ⏰
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
        {total}
      </span>
    </button>
  );
}
