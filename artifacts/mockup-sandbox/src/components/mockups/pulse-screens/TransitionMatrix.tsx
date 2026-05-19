import { useMemo, useState } from "react";
import { BookOpen, Calculator, Filter, Info, TrendingUp } from "lucide-react";

// =============================================================================
// Program Effectiveness — Transition Matrix Heatmap
// =============================================================================
// 4×4 grid: rows = PM1 band (where students started), columns = PM3 band
// (where they ended).  Cell color = movement type (diagonal = stayed,
// upper-right = climbed, lower-left = fell).  Cell intensity = student
// count.  Square chess-board read instead of a flow diagram.
// =============================================================================

type BandKey = "above" | "below" | "well" | "na";
const BAND_ORDER: BandKey[] = ["above", "below", "well", "na"];

const BANDS: Record<BandKey, { label: string; short: string; color: string }> = {
  above: { label: "At or Above Benchmark", short: "At/Above", color: "#84cc16" },
  below: { label: "Below Benchmark", short: "Below", color: "#facc15" },
  well: { label: "Well Below Benchmark", short: "Well Below", color: "#f87171" },
  na: { label: "N/A", short: "N/A", color: "#94a3b8" },
};

// Same matrix as the Sankey — totals match the screenshot (4,705 students).
const MATRIX: Record<BandKey, Record<BandKey, number>> = {
  above: { above: 1820, below: 280, well: 60, na: 30 },
  below: { above: 410, below: 520, well: 180, na: 25 },
  well: { above: 110, below: 360, well: 580, na: 30 },
  na: { above: 60, below: 90, well: 70, na: 80 },
};

const RANK: Record<BandKey, number> = { well: 0, below: 1, above: 2, na: -1 };

type CellMove = "stayed" | "up" | "down" | "na";
function moveType(from: BandKey, to: BandKey): CellMove {
  if (from === "na" || to === "na") return "na";
  if (from === to) return "stayed";
  return RANK[to] > RANK[from] ? "up" : "down";
}

// Color ramps per movement type, intensity by % within row.
function cellColor(move: CellMove, intensity: number): string {
  // intensity 0..1
  const a = 0.15 + intensity * 0.85;
  if (move === "up")     return `rgba(16, 185, 129, ${a})`;   // emerald
  if (move === "down")   return `rgba(244, 63, 94, ${a})`;    // rose
  if (move === "stayed") return `rgba(100, 116, 139, ${a * 0.5 + 0.1})`; // slate, muted
  return `rgba(148, 163, 184, ${a * 0.4 + 0.08})`;            // na, very muted
}

export function TransitionMatrix() {
  const [selected, setSelected] = useState<{ from: BandKey; to: BandKey } | null>(
    { from: "well", to: "below" },
  );

  const rowTotals = useMemo(() => {
    const t: Record<BandKey, number> = { above: 0, below: 0, well: 0, na: 0 };
    BAND_ORDER.forEach((from) =>
      BAND_ORDER.forEach((to) => (t[from] += MATRIX[from][to])),
    );
    return t;
  }, []);

  const colTotals = useMemo(() => {
    const t: Record<BandKey, number> = { above: 0, below: 0, well: 0, na: 0 };
    BAND_ORDER.forEach((from) =>
      BAND_ORDER.forEach((to) => (t[to] += MATRIX[from][to])),
    );
    return t;
  }, []);

  const total = useMemo(
    () => Object.values(rowTotals).reduce((s, v) => s + v, 0),
    [rowTotals],
  );

  const movedUp = useMemo(() => {
    let n = 0;
    BAND_ORDER.forEach((f) =>
      BAND_ORDER.forEach((t) => {
        if (moveType(f, t) === "up") n += MATRIX[f][t];
      }),
    );
    return n;
  }, []);
  const movedDown = useMemo(() => {
    let n = 0;
    BAND_ORDER.forEach((f) =>
      BAND_ORDER.forEach((t) => {
        if (moveType(f, t) === "down") n += MATRIX[f][t];
      }),
    );
    return n;
  }, []);
  const stayed = total - movedUp - movedDown;

  return (
    <div className="min-h-screen w-full bg-slate-50 text-slate-900 flex flex-col">
      {/* HEADER */}
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
                View: Transition Matrix
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
            <Stat label="Stayed" value={stayed.toLocaleString()} />
          </div>
        </div>
      </header>

      {/* BODY */}
      <main className="flex-1 px-8 py-6 flex gap-6 min-h-0">
        {/* MATRIX */}
        <div className="flex-1 bg-white rounded-2xl border border-slate-200 shadow-sm p-6 flex flex-col">
          {/* Column header */}
          <div className="text-[10px] uppercase tracking-wider text-slate-500 font-bold text-center mb-2">
            PM3 · End — Where students landed
          </div>

          <div className="flex-1 grid" style={{ gridTemplateColumns: "120px repeat(4, 1fr) 64px", gridTemplateRows: "auto repeat(4, 1fr) auto", gap: 4 }}>
            {/* corner */}
            <div />
            {/* col headers */}
            {BAND_ORDER.map((to) => (
              <div key={`ch-${to}`} className="flex flex-col items-center justify-end pb-2">
                <span className="inline-block h-2.5 w-2.5 rounded-sm mb-1" style={{ background: BANDS[to].color }} />
                <div className="text-[11px] font-bold text-slate-800 leading-tight text-center">
                  {BANDS[to].short}
                </div>
                <div className="text-[10px] text-slate-500 tabular-nums">
                  {colTotals[to].toLocaleString()}
                </div>
              </div>
            ))}
            <div className="text-[10px] font-bold text-slate-400 text-center pb-2 self-end">
              ROW Σ
            </div>

            {/* rows */}
            {BAND_ORDER.map((from) => (
              <>
                <div key={`rh-${from}`} className="flex items-center justify-end pr-3">
                  <div className="text-right">
                    <div className="text-[11px] font-bold text-slate-800 leading-tight">
                      {BANDS[from].short}
                    </div>
                    <div className="text-[10px] text-slate-500 tabular-nums">
                      PM1
                    </div>
                  </div>
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-sm ml-2"
                    style={{ background: BANDS[from].color }}
                  />
                </div>
                {BAND_ORDER.map((to) => {
                  const v = MATRIX[from][to];
                  const rowMax = Math.max(...BAND_ORDER.map((b) => MATRIX[from][b]));
                  const intensity = v / rowMax;
                  const move = moveType(from, to);
                  const pct = Math.round((v / rowTotals[from]) * 100);
                  const isSelected =
                    selected && selected.from === from && selected.to === to;
                  return (
                    <button
                      key={`c-${from}-${to}`}
                      onClick={() => setSelected({ from, to })}
                      className={[
                        "relative rounded-lg flex flex-col items-center justify-center transition-all text-slate-900 ring-1 ring-inset ring-slate-200/60 hover:ring-slate-900/50 hover:scale-[1.02]",
                        isSelected ? "ring-2 ring-slate-900 shadow-lg" : "",
                      ].join(" ")}
                      style={{ background: cellColor(move, intensity), minHeight: 72 }}
                    >
                      {move === "stayed" && (
                        <span className="absolute top-1 left-1.5 text-[8px] font-bold uppercase tracking-wider text-slate-700/70">
                          stayed
                        </span>
                      )}
                      {move === "up" && (
                        <span className="absolute top-1 left-1.5 text-[9px] font-bold text-emerald-900">
                          ▲
                        </span>
                      )}
                      {move === "down" && (
                        <span className="absolute top-1 left-1.5 text-[9px] font-bold text-rose-900">
                          ▼
                        </span>
                      )}
                      <div className="text-2xl font-black tabular-nums leading-none">
                        {v.toLocaleString()}
                      </div>
                      <div className="text-[10px] font-semibold opacity-70 mt-0.5">
                        {pct}% of row
                      </div>
                    </button>
                  );
                })}
                <div className="flex items-center justify-center text-[12px] font-bold text-slate-600 tabular-nums">
                  {rowTotals[from].toLocaleString()}
                </div>
              </>
            ))}

            {/* col totals row */}
            <div className="text-[10px] font-bold text-slate-400 text-right pr-3 pt-1">
              COL Σ
            </div>
            {BAND_ORDER.map((to) => (
              <div
                key={`cs-${to}`}
                className="text-center text-[12px] font-bold text-slate-600 tabular-nums pt-1"
              >
                {colTotals[to].toLocaleString()}
              </div>
            ))}
            <div className="text-center text-[12px] font-black text-slate-900 tabular-nums pt-1">
              {total.toLocaleString()}
            </div>
          </div>

          <div className="text-[10px] uppercase tracking-wider text-slate-500 font-bold text-center mt-2">
            ↑ Each row = students who started in that band
          </div>
        </div>

        {/* SIDE PANEL */}
        <div className="w-72 flex flex-col gap-4">
          {/* Legend */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4">
            <div className="text-[10px] uppercase tracking-wider text-slate-500 font-bold mb-2">
              How to read
            </div>
            <div className="space-y-1.5 text-[12px]">
              <LegendRow color="rgba(16, 185, 129, 0.6)" label="Climbed bands ▲" />
              <LegendRow color="rgba(100, 116, 139, 0.35)" label="Stayed in band" />
              <LegendRow color="rgba(244, 63, 94, 0.6)" label="Fell bands ▼" />
              <LegendRow color="rgba(148, 163, 184, 0.25)" label="N/A row or column" />
            </div>
            <div className="text-[10px] text-slate-500 mt-2 leading-snug">
              Cell intensity = share within that starting band.
              Bigger color = bigger movement story for that cohort.
            </div>
          </div>

          {/* Selected cell drilldown */}
          {selected && (
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 flex-1">
              <div className="text-[10px] uppercase tracking-wider text-slate-500 font-bold mb-1">
                Selected transition
              </div>
              <div className="flex items-center gap-2">
                <span className="inline-block h-3 w-3 rounded-sm" style={{ background: BANDS[selected.from].color }} />
                <span className="text-[12px] font-bold text-slate-800">
                  {BANDS[selected.from].short}
                </span>
                <span className="text-slate-400">→</span>
                <span className="inline-block h-3 w-3 rounded-sm" style={{ background: BANDS[selected.to].color }} />
                <span className="text-[12px] font-bold text-slate-800">
                  {BANDS[selected.to].short}
                </span>
              </div>
              <div className="mt-3 flex items-baseline gap-2">
                <div className="text-4xl font-black tabular-nums text-slate-900">
                  {MATRIX[selected.from][selected.to].toLocaleString()}
                </div>
                <div className="text-[11px] text-slate-500">students</div>
              </div>
              <div className="text-[11px] text-slate-600 mt-0.5">
                {Math.round(
                  (MATRIX[selected.from][selected.to] / rowTotals[selected.from]) * 100,
                )}
                % of {BANDS[selected.from].short} starters ·{" "}
                {Math.round(
                  (MATRIX[selected.from][selected.to] / total) * 100,
                )}
                % of all students
              </div>

              <div className="mt-4 border-t border-slate-100 pt-3 space-y-2">
                <div className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">
                  Why this matters
                </div>
                <div className="text-[11px] text-slate-700 leading-snug">
                  {moveType(selected.from, selected.to) === "up" && (
                    <>
                      This is a <span className="font-bold text-emerald-700">success</span> cell — students moved up a band during this window.
                    </>
                  )}
                  {moveType(selected.from, selected.to) === "down" && (
                    <>
                      This is a <span className="font-bold text-rose-700">regression</span> cell — students moved down a band. Worth a Tier 1/2 conversation.
                    </>
                  )}
                  {moveType(selected.from, selected.to) === "stayed" && (
                    <>
                      Students stayed in the same band. Healthy on the top row, a flag on the bottom rows.
                    </>
                  )}
                  {moveType(selected.from, selected.to) === "na" && (
                    <>
                      One side of this transition has no FAST score — likely new enrollees or absences.
                    </>
                  )}
                </div>
                <button className="mt-1 text-[11px] font-bold text-emerald-700 hover:underline">
                  View {MATRIX[selected.from][selected.to]} students →
                </button>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* FOOTER */}
      <footer className="px-8 py-3 border-t border-slate-200 bg-white text-xs text-slate-500 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Info className="h-3.5 w-3.5" />
          Rows = PM1 starting band · columns = PM3 ending band · click any cell to drill in.
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
function LegendRow({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="inline-block h-4 w-6 rounded" style={{ background: color }} />
      <span className="text-slate-700">{label}</span>
    </div>
  );
}
