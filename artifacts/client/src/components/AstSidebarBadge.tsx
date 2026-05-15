// Tiny sidebar badge that sits next to the "AST" nav item. Shows a
// blue ⏰ + numeric count when the staff member has UNREAD admin
// replies (preapprove/deny/confirm). The count zeroes out as soon as
// the staff member opens the AST page (StaffAstPage POSTs
// /api/ast/acknowledge on mount).
//
// Polls every 60s; hidden entirely when the count is 0 so the
// sidebar stays calm.
import { useEffect, useState } from "react";
import { authFetch } from "../lib/authToken";

interface Props {
  refreshKey: number;
}

export default function AstSidebarBadge({ refreshKey }: Props) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;
    async function poll() {
      try {
        const r = await authFetch("/api/ast/my-actionable-count", {
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
  }, [refreshKey]);

  if (count <= 0) return null;
  const title = `${count} unread AST repl${count === 1 ? "y" : "ies"} from admin`;
  return (
    <span
      title={title}
      aria-label={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        marginLeft: 6,
        background: "rgba(59, 130, 246, 0.15)",
        border: "1px solid rgba(59, 130, 246, 0.55)",
        color: "#1d4ed8",
        fontSize: "0.7rem",
        fontWeight: 700,
        padding: "1px 6px",
        borderRadius: 999,
        lineHeight: 1.2,
      }}
    >
      <span aria-hidden="true">⏰</span>
      {count}
    </span>
  );
}
