// BenchmarkStar — purple → green gradient star with a bold white count.
//
// Shown on the FAST Benchmarks heatmap column headers and on every row
// of the Benchmark Progress Report so a teacher can see at a glance
// how many times *they* have logged instruction against this standard
// in the current school year.
//
// Visual rules:
//   • count === 0       → faded outline-only star, count hidden.
//   • lastTaughtDaysAgo > 21 → desaturated fill (recency tint).
//   • Tooltip shows the count + last-taught date when count > 0.
//
// Pure presentational component — caller passes the precomputed count
// and lastTaughtOn (YYYY-MM-DD or null).
import type { CSSProperties } from "react";

interface Props {
  count: number;
  lastTaughtOn?: string | null;
  size?: number;
  onClick?: () => void;
  // When provided, used as the tooltip title verbatim (e.g. "Click to log
  // instruction"). Otherwise an auto-generated tooltip is built.
  title?: string;
}

function daysAgo(iso: string | null | undefined): number | null {
  if (!iso) return null;
  // Local-date math, no UTC drift — matches DEFAULT_SCHOOL_TZ usage.
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return null;
  const then = new Date(y, m - 1, d);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.floor((today.getTime() - then.getTime()) / 86400000);
}

export default function BenchmarkStar({
  count,
  lastTaughtOn,
  size = 22,
  onClick,
  title,
}: Props) {
  const ago = daysAgo(lastTaughtOn ?? null);
  const stale = ago !== null && ago > 21;
  const isZero = count <= 0;

  // Gradient — purple to green when active, neutral when zero, washed
  // out gray when stale.
  const gradId = `bmstar-${isZero ? "z" : stale ? "s" : "a"}-${size}`;
  const stops = isZero
    ? ["#e5e7eb", "#d1d5db"]
    : stale
      ? ["#c4b5fd", "#a7f3d0"]
      : ["#7c3aed", "#10b981"];

  const autoTitle = isZero
    ? "Not yet logged this year"
    : `Taught ${count}× • last on ${lastTaughtOn}${stale ? ` (${ago}d ago)` : ""}`;

  const cursor: CSSProperties["cursor"] = onClick ? "pointer" : "default";

  return (
    <span
      onClick={onClick}
      title={title ?? autoTitle}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        position: "relative",
        width: size,
        height: size,
        cursor,
        verticalAlign: "middle",
      }}
      role={onClick ? "button" : undefined}
      aria-label={autoTitle}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        style={{ opacity: isZero ? 0.55 : 1 }}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={stops[0]} />
            <stop offset="100%" stopColor={stops[1]} />
          </linearGradient>
        </defs>
        <path
          d="M12 2.5l2.95 5.97 6.59.96-4.77 4.65 1.13 6.57L12 17.55l-5.9 3.1 1.13-6.57L2.46 9.43l6.59-.96L12 2.5z"
          fill={isZero ? "none" : `url(#${gradId})`}
          stroke={isZero ? "#9ca3af" : "rgba(0,0,0,0.15)"}
          strokeWidth={isZero ? 1.2 : 0.6}
        />
      </svg>
      {!isZero && (
        <span
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "white",
            fontWeight: 800,
            fontSize: Math.max(9, Math.round(size * 0.45)),
            textShadow: "0 1px 1px rgba(0,0,0,0.45)",
            lineHeight: 1,
            pointerEvents: "none",
          }}
        >
          {count > 99 ? "99+" : count}
        </span>
      )}
    </span>
  );
}
