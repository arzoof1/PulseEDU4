import { useEffect, useMemo, useState } from "react";
import { BookOpen, Calculator, Filter, Info, TrendingUp } from "lucide-react";

// =============================================================================
// Program Effectiveness — Cohort Dot Migration
// =============================================================================
// Every student is one dot.  PM1 column on the left, PM3 column on the
// right.  Dots are colored by journey type (climbed = emerald, held =
// slate, fell = rose, n/a = grey).  On load, dots animate from their
// PM1 slot to their PM3 slot, then settle.  4,705 dots fit comfortably
// in a 1280×800 tile because each dot is ~6 px square.
// =============================================================================

type BandKey = "above" | "below" | "well" | "na";
const BAND_ORDER: BandKey[] = ["above", "below", "well", "na"];

const BANDS: Record<BandKey, { label: string; short: string; color: string }> = {
  above: { label: "At or Above Benchmark", short: "At/Above", color: "#84cc16" },
  below: { label: "Below Benchmark", short: "Below", color: "#facc15" },
  well: { label: "Well Below Benchmark", short: "Well Below", color: "#f87171" },
  na: { label: "N/A", short: "N/A", color: "#94a3b8" },
};

const MATRIX: Record<BandKey, Record<BandKey, number>> = {
  above: { above: 1820, below: 280, well: 60, na: 30 },
  below: { above: 410, below: 520, well: 180, na: 25 },
  well: { above: 110, below: 360, well: 580, na: 30 },
  na: { above: 60, below: 90, well: 70, na: 80 },
};

const RANK: Record<BandKey, number> = { well: 0, below: 1, above: 2, na: -1 };
type Journey = "climbed" | "held" | "fell" | "na";
function journey(from: BandKey, to: BandKey): Journey {
  if (from === "na" || to === "na") return "na";
  if (from === to) return "held";
  return RANK[to] > RANK[from] ? "climbed" : "fell";
}
const JOURNEY_COLOR: Record<Journey, string> = {
  climbed: "#10b981",
  held: "#94a3b8",
  fell: "#f43f5e",
  na: "#cbd5e1",
};

// Build the dot list once from the matrix.  Scale down by ~5× so we
// render ~940 dots instead of 4,705 — keeps the SVG light without
// changing the visual story.
const SCALE = 5;

interface Dot {
  from: BandKey;
  to: BandKey;
  j: Journey;
}

function buildDots(): Dot[] {
  const out: Dot[] = [];
  BAND_ORDER.forEach((from) => {
    BAND_ORDER.forEach((to) => {
      const n = Math.round(MATRIX[from][to] / SCALE);
      for (let i = 0; i < n; i++) out.push({ from, to, j: journey(from, to) });
    });
  });
  return out;
}

// Grid placement: for a given band, lay dots out in a tight grid inside
// a band-colored "column".  Columns are stacked vertically (above on
// top → na on bottom).  Each band column is sized proportionally to its
// student count.
const COL_W = 280;       // px width per grid column
const COL_PAD_Y = 8;
const COL_GAP = 10;
const DOT_SIZE = 5;
const DOT_GAP = 1;
const TOWER_TOP = 4;
const TOWER_HEIGHT = 500;

function packGrid(count: number, width: number, height: number) {
  // Fit count dots in width×height, return per-dot (x,y) within the column.
  const cell = DOT_SIZE + DOT_GAP;
  const cols = Math.max(1, Math.floor(width / cell));
  const rows = Math.ceil(count / cols);
  // If too tall, shrink dot size proportionally (caller will rescale).
  return { cols, rows, cellW: cell, cellH: cell, fits: rows * cell <= height };
}

interface Slot { x: number; y: number; bandY: number; bandH: number }

function computeSlots(side: "left" | "right", totalsByBand: Record<BandKey, number>): Map<string, Slot[]> {
  const total = Object.values(totalsByBand).reduce((s, v) => s + v, 0);
  const usable = TOWER_HEIGHT - COL_PAD_Y * 2 - COL_GAP * (BAND_ORDER.length - 1);

  const baseX = side === "left" ? 0 : 0;
  const map = new Map<string, Slot[]>();
  let y = TOWER_TOP + COL_PAD_Y;

  BAND_ORDER.forEach((b) => {
    const n = totalsByBand[b];
    const bandH = (n / total) * usable;
    const { cols, cellW, cellH } = packGrid(n, COL_W, bandH);
    const slots: Slot[] = [];
    for (let i = 0; i < n; i++) {
      const r = Math.floor(i / cols);
      const c = i % cols;
      slots.push({
        x: baseX + c * cellW + 2,
        y: y + r * cellH + 2,
        bandY: y,
        bandH,
      });
    }
    map.set(b, slots);
    y += bandH + COL_GAP;
  });
  return map;
}

export function DotMigration() {
  const [phase, setPhase] = useState<"pm1" | "pm3">("pm1");
  const [filter, setFilter] = useState<Journey | "all">("all");

  const dots = useMemo(() => buildDots(), []);

  const leftTotals = useMemo(() => {
    const t: Record<BandKey, number> = { above: 0, below: 0, well: 0, na: 0 };
    dots.forEach((d) => (t[d.from] += 1));
    return t;
  }, [dots]);
  const rightTotals = useMemo(() => {
    const t: Record<BandKey, number> = { above: 0, below: 0, well: 0, na: 0 };
    dots.forEach((d) => (t[d.to] += 1));
    return t;
  }, [dots]);

  const total = dots.length;
  const counts = useMemo(() => {
    const c = { climbed: 0, held: 0, fell: 0, na: 0 } as Record<Journey, number>;
    dots.forEach((d) => (c[d.j] += 1));
    return c;
  }, [dots]);

  // Slots per side, indexed by band.  Assign dots to slots in array order;
  // the dot's identity stays the same across PM1/PM3 so the animation works.
  const leftSlots = useMemo(() => computeSlots("left", leftTotals), [leftTotals]);
  const rightSlots = useMemo(() => computeSlots("right", rightTotals), [rightTotals]);

  // Walk the dots once, deterministically assigning each dot a left slot
  // (within its `from` band) and a right slot (within its `to` band).
  const placed = useMemo(() => {
    const leftCursor: Record<BandKey, number> = { above: 0, below: 0, well: 0, na: 0 };
    const rightCursor: Record<BandKey, number> = { above: 0, below: 0, well: 0, na: 0 };
    return dots.map((d, i) => {
      const ls = leftSlots.get(d.from)![leftCursor[d.from]++];
      const rs = rightSlots.get(d.to)![rightCursor[d.to]++];
      return { id: i, ...d, ls, rs };
    });
  }, [dots, leftSlots, rightSlots]);

  // Auto-trigger the migration after first paint.
  useEffect(() => {
    const t = setTimeout(() => setPhase("pm3"), 800);
    return () => clearTimeout(t);
  }, []);

  const leftColX = 70;
  const rightColX = 700;

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
                View: Cohort Dot Migration
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
            <span>FAST aReading · Each dot ≈ {SCALE} students</span>
          </div>
          <div className="flex items-center gap-4 text-xs">
            <Stat label="Total students" value={(total * SCALE).toLocaleString()} />
            <Stat label="Climbed" value={(counts.climbed * SCALE).toLocaleString()} tone="up" />
            <Stat label="Fell" value={(counts.fell * SCALE).toLocaleString()} tone="down" />
            <Stat label="Held" value={(counts.held * SCALE).toLocaleString()} />
          </div>
        </div>
      </header>

      <main className="flex-1 px-8 py-6 flex flex-col gap-4 min-h-0">
        {/* Controls */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <FilterPill active={filter === "all"} onClick={() => setFilter("all")} color="#0f172a" label="All cohorts" />
            <FilterPill active={filter === "climbed"} onClick={() => setFilter("climbed")} color={JOURNEY_COLOR.climbed} label={`Climbed (${(counts.climbed * SCALE).toLocaleString()})`} />
            <FilterPill active={filter === "held"} onClick={() => setFilter("held")} color={JOURNEY_COLOR.held} label={`Held (${(counts.held * SCALE).toLocaleString()})`} />
            <FilterPill active={filter === "fell"} onClick={() => setFilter("fell")} color={JOURNEY_COLOR.fell} label={`Fell (${(counts.fell * SCALE).toLocaleString()})`} />
            <FilterPill active={filter === "na"} onClick={() => setFilter("na")} color={JOURNEY_COLOR.na} label={`N/A (${(counts.na * SCALE).toLocaleString()})`} />
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPhase((p) => (p === "pm1" ? "pm3" : "pm1"))}
              className="rounded-full bg-slate-900 text-white text-xs font-bold px-4 py-1.5 hover:bg-slate-700"
            >
              {phase === "pm1" ? "▶ Play PM1 → PM3" : "⟲ Reset to PM1"}
            </button>
          </div>
        </div>

        {/* Dot canvas */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 relative" style={{ height: 520 }}>
          <svg width="100%" height="100%" viewBox={`0 0 ${rightColX + COL_W + 80} ${TOWER_TOP + TOWER_HEIGHT + 20}`} preserveAspectRatio="xMidYMid meet">
            {/* Band column backgrounds with labels */}
            {(["left", "right"] as const).map((side) => {
              const totals = side === "left" ? leftTotals : rightTotals;
              const usable = TOWER_HEIGHT - COL_PAD_Y * 2 - COL_GAP * (BAND_ORDER.length - 1);
              const totalCount = Object.values(totals).reduce((s, v) => s + v, 0);
              const baseX = side === "left" ? leftColX : rightColX;
              let y = TOWER_TOP + COL_PAD_Y;
              return (
                <g key={side}>
                  {BAND_ORDER.map((b) => {
                    const h = (totals[b] / totalCount) * usable;
                    const node = (
                      <g key={`${side}-${b}`}>
                        <rect
                          x={baseX - 6}
                          y={y - 4}
                          width={COL_W + 12}
                          height={h + 8}
                          rx={8}
                          fill={BANDS[b].color}
                          fillOpacity={0.08}
                          stroke={BANDS[b].color}
                          strokeOpacity={0.4}
                        />
                        <text
                          x={side === "left" ? baseX - 12 : baseX + COL_W + 12}
                          y={y + h / 2}
                          textAnchor={side === "left" ? "end" : "start"}
                          fontSize={11}
                          fontWeight={800}
                          fill="#0f172a"
                          dominantBaseline="middle"
                        >
                          {BANDS[b].short}
                        </text>
                        <text
                          x={side === "left" ? baseX - 12 : baseX + COL_W + 12}
                          y={y + h / 2 + 14}
                          textAnchor={side === "left" ? "end" : "start"}
                          fontSize={10}
                          fontWeight={600}
                          fill="#64748b"
                          dominantBaseline="middle"
                        >
                          {(totals[b] * SCALE).toLocaleString()}
                        </text>
                      </g>
                    );
                    y += h + COL_GAP;
                    return node;
                  })}
                </g>
              );
            })}

            {/* Column headers */}
            <text x={leftColX + COL_W / 2} y={TOWER_TOP - 6} textAnchor="middle" fontSize={11} fontWeight={800} fill="#64748b" letterSpacing="2">
              PM1 · BEGINNING
            </text>
            <text x={rightColX + COL_W / 2} y={TOWER_TOP - 6} textAnchor="middle" fontSize={11} fontWeight={800} fill="#64748b" letterSpacing="2">
              PM3 · END
            </text>

            {/* Dots */}
            {placed.map((d) => {
              const dim = filter !== "all" && d.j !== filter;
              const x = phase === "pm1" ? leftColX + d.ls.x : rightColX + d.rs.x;
              const y = phase === "pm1" ? d.ls.y : d.rs.y;
              return (
                <rect
                  key={d.id}
                  x={x}
                  y={y}
                  width={DOT_SIZE}
                  height={DOT_SIZE}
                  rx={1}
                  fill={JOURNEY_COLOR[d.j]}
                  opacity={dim ? 0.05 : 0.95}
                  style={{ transition: "x 1400ms cubic-bezier(.4,.0,.2,1), y 1400ms cubic-bezier(.4,.0,.2,1), opacity 220ms" }}
                />
              );
            })}
          </svg>

          {/* Phase indicator */}
          <div className="absolute bottom-3 right-4 text-[10px] uppercase tracking-widest font-bold text-slate-500">
            Showing: <span className="text-slate-900">{phase === "pm1" ? "PM1 positions" : "PM3 positions"}</span>
          </div>
        </div>
      </main>

      <footer className="px-8 py-3 border-t border-slate-200 bg-white text-xs text-slate-500 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Info className="h-3.5 w-3.5" />
          Each dot ≈ {SCALE} students · color = journey (climbed / held / fell / n/a) · press play to watch the migration.
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
function FilterPill({ active, onClick, color, label }: { active: boolean; onClick: () => void; color: string; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold border transition-colors ${active ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-700 border-slate-300 hover:bg-slate-100"}`}
    >
      <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: color }} />
      {label}
    </button>
  );
}
