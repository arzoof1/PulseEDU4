import { useMemo, useState } from "react";
import { BookOpen, Calculator, Filter, Info, TrendingUp } from "lucide-react";

// =============================================================================
// Program Effectiveness — Two-Tower Ribbon Flow
// =============================================================================
// Two solid stacked towers (PM1 left, PM3 right) with curved ribbons
// connecting matching band segments.  Same data as the Sankey but
// rendered as a "before/after" object instead of an alluvial diagram.
// =============================================================================

type BandKey = "above" | "below" | "well" | "na";
const BAND_ORDER: BandKey[] = ["above", "below", "well", "na"];

const BANDS: Record<BandKey, { label: string; short: string; color: string; soft: string }> = {
  above: { label: "At or Above Benchmark", short: "At/Above", color: "#84cc16", soft: "rgba(132, 204, 22, 0.55)" },
  below: { label: "Below Benchmark", short: "Below", color: "#facc15", soft: "rgba(250, 204, 21, 0.55)" },
  well: { label: "Well Below Benchmark", short: "Well Below", color: "#f87171", soft: "rgba(248, 113, 113, 0.55)" },
  na: { label: "N/A", short: "N/A", color: "#94a3b8", soft: "rgba(148, 163, 184, 0.4)" },
};

const MATRIX: Record<BandKey, Record<BandKey, number>> = {
  above: { above: 1820, below: 280, well: 60, na: 30 },
  below: { above: 410, below: 520, well: 180, na: 25 },
  well: { above: 110, below: 360, well: 580, na: 30 },
  na: { above: 60, below: 90, well: 70, na: 80 },
};

const W = 900;          // SVG viewBox width
const H = 460;          // SVG viewBox height
const TOWER_W = 80;
const LEFT_X = 180;     // left tower x
const RIGHT_X = W - LEFT_X - TOWER_W;
const TOP = 20;
const BOTTOM = H - 20;
const TOWER_H = BOTTOM - TOP;
const NODE_GAP = 8;     // visual gap between band segments

export function TwoTowerFlow() {
  const [hover, setHover] = useState<{ from: BandKey; to: BandKey } | null>(null);

  // Per-side totals
  const leftTotals = useMemo(() => {
    const t: Record<BandKey, number> = { above: 0, below: 0, well: 0, na: 0 };
    BAND_ORDER.forEach((f) => BAND_ORDER.forEach((to) => (t[f] += MATRIX[f][to])));
    return t;
  }, []);
  const rightTotals = useMemo(() => {
    const t: Record<BandKey, number> = { above: 0, below: 0, well: 0, na: 0 };
    BAND_ORDER.forEach((f) => BAND_ORDER.forEach((to) => (t[to] += MATRIX[f][to])));
    return t;
  }, []);
  const total = useMemo(() => Object.values(leftTotals).reduce((s, v) => s + v, 0), [leftTotals]);

  const movedUp = useMemo(() => {
    const rank: Record<BandKey, number> = { well: 0, below: 1, above: 2, na: -1 };
    let n = 0;
    BAND_ORDER.forEach((f) => BAND_ORDER.forEach((to) => {
      if (rank[f] >= 0 && rank[to] > rank[f]) n += MATRIX[f][to];
    }));
    return n;
  }, []);
  const movedDown = useMemo(() => {
    const rank: Record<BandKey, number> = { well: 0, below: 1, above: 2, na: -1 };
    let n = 0;
    BAND_ORDER.forEach((f) => BAND_ORDER.forEach((to) => {
      if (rank[f] >= 0 && rank[to] >= 0 && rank[to] < rank[f]) n += MATRIX[f][to];
    }));
    return n;
  }, []);

  // Compute tower segment positions (y, height) in band order.
  const usableH = TOWER_H - NODE_GAP * (BAND_ORDER.length - 1);
  const leftSegs = useMemo(() => {
    let y = TOP;
    const out: Record<BandKey, { y: number; h: number }> = {} as never;
    BAND_ORDER.forEach((b) => {
      const h = (leftTotals[b] / total) * usableH;
      out[b] = { y, h };
      y += h + NODE_GAP;
    });
    return out;
  }, [leftTotals, total, usableH]);
  const rightSegs = useMemo(() => {
    let y = TOP;
    const out: Record<BandKey, { y: number; h: number }> = {} as never;
    BAND_ORDER.forEach((b) => {
      const h = (rightTotals[b] / total) * usableH;
      out[b] = { y, h };
      y += h + NODE_GAP;
    });
    return out;
  }, [rightTotals, total, usableH]);

  // For ribbons: each from-segment is sliced into 4 sub-rectangles (one per to-band),
  // and likewise each to-segment.  We walk top→bottom inside each segment to lay
  // them out in band order (matches the Sankey screenshot's visual logic).
  const ribbons = useMemo(() => {
    const out: { from: BandKey; to: BandKey; value: number; path: string; fill: string }[] = [];
    // Track running cursor inside each segment.
    const leftCursor: Record<BandKey, number> = { above: 0, below: 0, well: 0, na: 0 };
    const rightCursor: Record<BandKey, number> = { above: 0, below: 0, well: 0, na: 0 };

    BAND_ORDER.forEach((from) => {
      BAND_ORDER.forEach((to) => {
        const v = MATRIX[from][to];
        if (v <= 0) return;
        const leftH = (v / leftTotals[from]) * leftSegs[from].h;
        const rightH = (v / rightTotals[to]) * rightSegs[to].h;

        const sy0 = leftSegs[from].y + leftCursor[from];
        const sy1 = sy0 + leftH;
        const ty0 = rightSegs[to].y + rightCursor[to];
        const ty1 = ty0 + rightH;

        leftCursor[from] += leftH;
        rightCursor[to] += rightH;

        const sx = LEFT_X + TOWER_W;
        const tx = RIGHT_X;
        const cx1 = sx + (tx - sx) * 0.5;
        const cx2 = tx - (tx - sx) * 0.5;

        // Two cubic curves: top edge and bottom edge, then close.
        const path = [
          `M ${sx} ${sy0}`,
          `C ${cx1} ${sy0} ${cx2} ${ty0} ${tx} ${ty0}`,
          `L ${tx} ${ty1}`,
          `C ${cx2} ${ty1} ${cx1} ${sy1} ${sx} ${sy1}`,
          `Z`,
        ].join(" ");

        out.push({ from, to, value: v, path, fill: BANDS[to].soft });
      });
    });

    return out;
  }, [leftSegs, rightSegs, leftTotals, rightTotals]);

  const hoverInfo = hover ? { ...hover, value: MATRIX[hover.from][hover.to] } : null;

  return (
    <div className="min-h-screen w-full bg-slate-50 text-slate-900 flex flex-col">
      <header className="px-8 py-5 border-b border-slate-200 bg-white">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-emerald-500 to-cyan-500 grid place-items-center shadow">
              <TrendingUp className="h-6 w-6 text-white" />
            </div>
            <div>
              <div className="text-xs font-bold tracking-[0.2em] text-slate-500 uppercase">
                Insights · MTSS
              </div>
              <h1 className="text-2xl font-black leading-tight">
                Program Effectiveness
              </h1>
              <div className="text-[11px] font-semibold text-emerald-700 mt-0.5">
                View: Two-Tower Flow
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap justify-end">
            <div className="flex items-center gap-1 text-xs font-semibold text-slate-500 mr-1">
              <Filter className="h-3.5 w-3.5" />
              FILTERS
            </div>
            <Chip active icon={BookOpen} label="ELA" />
            <Chip icon={Calculator} label="Math" />
            <FakeSelect label="All grades" />
            <FakeSelect label="PM1 → PM3" />
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between text-sm">
          <div className="flex items-center gap-2 text-slate-600">
            <span className="font-semibold text-slate-900">PM1 · Beginning</span>
            <span className="text-slate-400">→</span>
            <span className="font-semibold text-slate-900">PM3 · End</span>
            <span className="text-slate-400 mx-2">·</span>
            <span>FAST aReading</span>
          </div>
          <div className="flex items-center gap-4 text-xs">
            <Stat label="Total students" value={total.toLocaleString()} />
            <Stat label="Moved up" value={movedUp.toLocaleString()} tone="up" />
            <Stat label="Moved down" value={movedDown.toLocaleString()} tone="down" />
            <Stat label="Stayed" value={(total - movedUp - movedDown).toLocaleString()} />
          </div>
        </div>
      </header>

      <main className="flex-1 px-8 py-6 flex flex-col gap-4 min-h-0">
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 relative" style={{ height: 480 }}>
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-full" preserveAspectRatio="xMidYMid meet">
            {/* PM1/PM3 column labels */}
            <text x={LEFT_X + TOWER_W / 2} y={TOP - 4} textAnchor="middle" fontSize={11} fontWeight={800} fill="#64748b" letterSpacing="1.5">
              PM1
            </text>
            <text x={RIGHT_X + TOWER_W / 2} y={TOP - 4} textAnchor="middle" fontSize={11} fontWeight={800} fill="#64748b" letterSpacing="1.5">
              PM3
            </text>

            {/* Ribbons (drawn first so towers sit on top) */}
            {ribbons.map((r, i) => {
              const isHover = hover && hover.from === r.from && hover.to === r.to;
              return (
                <path
                  key={i}
                  d={r.path}
                  fill={r.fill}
                  opacity={hover ? (isHover ? 1 : 0.18) : 0.95}
                  stroke={isHover ? "#0f172a" : "none"}
                  strokeWidth={isHover ? 1.5 : 0}
                  onMouseEnter={() => setHover({ from: r.from, to: r.to })}
                  onMouseLeave={() => setHover(null)}
                  style={{ cursor: "pointer", transition: "opacity 150ms" }}
                />
              );
            })}

            {/* Towers */}
            {BAND_ORDER.map((b) => (
              <g key={`l-${b}`}>
                <rect
                  x={LEFT_X}
                  y={leftSegs[b].y}
                  width={TOWER_W}
                  height={leftSegs[b].h}
                  fill={BANDS[b].color}
                  rx={4}
                />
                <text
                  x={LEFT_X - 10}
                  y={leftSegs[b].y + leftSegs[b].h / 2 - 5}
                  textAnchor="end"
                  fontSize={12}
                  fontWeight={800}
                  fill="#0f172a"
                  dominantBaseline="middle"
                >
                  {BANDS[b].short}
                </text>
                <text
                  x={LEFT_X - 10}
                  y={leftSegs[b].y + leftSegs[b].h / 2 + 9}
                  textAnchor="end"
                  fontSize={11}
                  fontWeight={600}
                  fill="#475569"
                  dominantBaseline="middle"
                >
                  {leftTotals[b].toLocaleString()}
                </text>
              </g>
            ))}
            {BAND_ORDER.map((b) => (
              <g key={`r-${b}`}>
                <rect
                  x={RIGHT_X}
                  y={rightSegs[b].y}
                  width={TOWER_W}
                  height={rightSegs[b].h}
                  fill={BANDS[b].color}
                  rx={4}
                />
                <text
                  x={RIGHT_X + TOWER_W + 10}
                  y={rightSegs[b].y + rightSegs[b].h / 2 - 5}
                  textAnchor="start"
                  fontSize={12}
                  fontWeight={800}
                  fill="#0f172a"
                  dominantBaseline="middle"
                >
                  {BANDS[b].short}
                </text>
                <text
                  x={RIGHT_X + TOWER_W + 10}
                  y={rightSegs[b].y + rightSegs[b].h / 2 + 9}
                  textAnchor="start"
                  fontSize={11}
                  fontWeight={600}
                  fill="#475569"
                  dominantBaseline="middle"
                >
                  {rightTotals[b].toLocaleString()}
                  {(() => {
                    const d = rightTotals[b] - leftTotals[b];
                    if (b === "na") return "";
                    const sign = d > 0 ? "+" : "";
                    const color = d > 0 ? "#059669" : d < 0 ? "#e11d48" : "#64748b";
                    return (
                      <tspan dx="6" fill={color} fontWeight={800}>
                        {sign}{d}
                      </tspan>
                    );
                  })()}
                </text>
              </g>
            ))}

            {/* Hover tooltip */}
            {hoverInfo && (
              <g pointerEvents="none">
                <rect x={W / 2 - 100} y={H - 56} width={200} height={42} rx={8} fill="#0f172a" />
                <text x={W / 2} y={H - 38} textAnchor="middle" fontSize={11} fontWeight={700} fill="#cbd5e1">
                  {BANDS[hoverInfo.from].short} → {BANDS[hoverInfo.to].short}
                </text>
                <text x={W / 2} y={H - 22} textAnchor="middle" fontSize={14} fontWeight={900} fill="#fff">
                  {hoverInfo.value.toLocaleString()} students
                </text>
              </g>
            )}
          </svg>
        </div>

        <div className="grid grid-cols-4 gap-3">
          {BAND_ORDER.map((b) => {
            const left = leftTotals[b];
            const right = rightTotals[b];
            const delta = right - left;
            return (
              <div key={b} className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                <div className="flex items-center gap-2 mb-2">
                  <span className="inline-block h-3 w-3 rounded-sm" style={{ backgroundColor: BANDS[b].color }} />
                  <div className="text-xs font-bold uppercase tracking-wider text-slate-700">
                    {BANDS[b].label}
                  </div>
                </div>
                <div className="flex items-baseline gap-3">
                  <div className="text-2xl font-black tabular-nums text-slate-900">
                    {right.toLocaleString()}
                  </div>
                  <div className={`text-xs font-semibold tabular-nums ${b === "na" ? "text-slate-500" : delta > 0 ? "text-emerald-600" : delta < 0 ? "text-rose-600" : "text-slate-500"}`}>
                    {b === "na" ? "—" : delta > 0 ? `+${delta} vs PM1` : delta < 0 ? `${delta} vs PM1` : "no change"}
                  </div>
                </div>
                <div className="mt-1 text-[11px] text-slate-500">
                  PM1: {left.toLocaleString()} · PM3: {right.toLocaleString()}
                </div>
              </div>
            );
          })}
        </div>
      </main>

      <footer className="px-8 py-3 border-t border-slate-200 bg-white text-xs text-slate-500 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Info className="h-3.5 w-3.5" />
          Tower height = student count · ribbon color = ending band · hover any ribbon to isolate that cohort.
        </div>
        <div className="text-slate-400">
          PulseEDU · Insights · Mock data for design review
        </div>
      </footer>
    </div>
  );
}

function Chip({ active, icon: Icon, label }: { active?: boolean; icon: React.ComponentType<{ className?: string }>; label: string }) {
  return (
    <button className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold border ${active ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-700 border-slate-300 hover:bg-slate-100"}`}>
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}
function FakeSelect({ label }: { label: string }) {
  return (
    <div className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold border border-slate-300 bg-white text-slate-700">
      {label}
      <span className="text-slate-400">▾</span>
    </div>
  );
}
function Stat({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  const valueColor = tone === "up" ? "text-emerald-600" : tone === "down" ? "text-rose-600" : "text-slate-900";
  return (
    <div className="flex flex-col items-end">
      <div className={`text-base font-black tabular-nums leading-none ${valueColor}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-slate-500 mt-0.5">{label}</div>
    </div>
  );
}
