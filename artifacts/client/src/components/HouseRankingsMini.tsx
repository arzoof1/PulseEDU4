import { useEffect, useState } from "react";
import * as LucideIcons from "lucide-react";
import { authFetch } from "../lib/authToken";

// Compact House standings widget for the left sidebar Quick Access strip.
// Lives directly below "PBIS Points" so teachers always see how their
// house is doing while they navigate the app — a passive, glanceable
// nudge that complements the active Spotlight award flow.
//
// Design constraints:
// - Must fit the narrow sidebar width without horizontal scroll.
// - Refreshes on a slow interval (60s) so totals stay roughly current
//   without hammering the API. Spotlight awards still update the bars
//   instantly inside SpotlightPanel; this widget catches drift from
//   awards happening elsewhere (PBIS Hub, classroom store, etc).
// - Hidden when there are no houses configured for the school.

interface HouseRow {
  id: number;
  name: string;
  color: string;
  iconKey: string | null;
  totalPoints: number;
}

function resolveLucideIcon(
  key: string | null,
): React.ComponentType<{ size?: number; strokeWidth?: number }> | null {
  if (!key) return null;
  const all = LucideIcons as unknown as Record<string, unknown>;
  const candidate = all[key];
  if (typeof candidate === "function" || typeof candidate === "object") {
    return candidate as React.ComponentType<{
      size?: number;
      strokeWidth?: number;
    }>;
  }
  return null;
}

export default function HouseRankingsMini() {
  const [houses, setHouses] = useState<HouseRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await authFetch("/api/houses?windowDays=7", {
          credentials: "include",
        });
        if (!res.ok) return;
        const body = (await res.json()) as { houses?: HouseRow[] };
        if (cancelled) return;
        setHouses(body.houses ?? []);
      } catch {
        // Best-effort: a network blip just leaves the previous values
        // visible, which is the right UX for a passive widget.
      }
    }
    void load();
    // 60s refresh — slow enough to be cheap, fast enough that points
    // awarded in another tab/teacher's session show up within a class
    // period. Spotlight's own award path still updates instantly.
    const t = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, []);

  if (!houses || houses.length === 0) return null;

  const sorted = [...houses].sort((a, b) => b.totalPoints - a.totalPoints);
  const max = Math.max(1, ...sorted.map((h) => h.totalPoints));

  return (
    <div
      style={{
        margin: "0.4rem 0.5rem 0.6rem",
        padding: "0.55rem 0.6rem 0.6rem",
        background: "rgba(255,255,255,0.04)",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 10,
      }}
      aria-label="House standings"
    >
      <div
        style={{
          fontSize: "0.65rem",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          opacity: 0.65,
          fontWeight: 700,
          marginBottom: "0.4rem",
        }}
      >
        House Rankings
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
        {sorted.map((h, i) => {
          const Icon = resolveLucideIcon(h.iconKey);
          const pct = Math.round((h.totalPoints / max) * 100);
          return (
            <div
              key={h.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.4rem",
                fontSize: "0.78rem",
              }}
              title={`${h.name}: ${h.totalPoints.toLocaleString()} pts (rank ${i + 1})`}
            >
              <span
                style={{
                  width: 14,
                  textAlign: "right",
                  opacity: 0.55,
                  fontWeight: 600,
                  flexShrink: 0,
                }}
              >
                {i + 1}
              </span>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 18,
                  height: 18,
                  borderRadius: "50%",
                  background: h.color,
                  color: "#fff",
                  flexShrink: 0,
                }}
              >
                {Icon ? (
                  <Icon size={11} strokeWidth={2.5} />
                ) : (
                  <span style={{ fontSize: "0.6rem", fontWeight: 800 }}>
                    {h.name.charAt(0).toUpperCase()}
                  </span>
                )}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: "0.4rem",
                    lineHeight: 1.1,
                  }}
                >
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      fontWeight: 600,
                    }}
                  >
                    {h.name}
                  </span>
                  <span style={{ opacity: 0.75, flexShrink: 0 }}>
                    {h.totalPoints.toLocaleString()}
                  </span>
                </div>
                <div
                  style={{
                    marginTop: 2,
                    height: 4,
                    background: "rgba(255,255,255,0.08)",
                    borderRadius: 999,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: `${pct}%`,
                      height: "100%",
                      background: h.color,
                      borderRadius: 999,
                      transition: "width 400ms ease-out",
                    }}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
