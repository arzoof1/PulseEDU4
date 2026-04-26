import { useMemo, useState } from "react";
import {
  BookOpen,
  Calculator,
  Filter,
  Info,
  TrendingUp,
} from "lucide-react";
import {
  Layer,
  Rectangle,
  ResponsiveContainer,
  Sankey,
  Tooltip,
} from "recharts";

// =============================================================================
// Program Effectiveness — Sankey
// =============================================================================
// Educlimber-style alluvial / Sankey diagram showing how students moved
// between performance bands from one progress-monitoring window (left)
// to another (right).  PulseEDU stores FAST PM1, PM2, PM3 per
// (student, subject), so the natural left→right pairs are:
//   • PM1 → PM3   (Beginning → End — the headline view)
//   • PM1 → PM2   (Beginning → Middle)
//   • PM2 → PM3   (Middle → End)
// Bands collapse FAST levels 1–5 into the three Educlimber buckets used
// in MTSS conversations:
//   • At/Above Benchmark   (Levels 3, 4, 5)
//   • Below Benchmark      (Level 2)
//   • Well Below Benchmark (Level 1)
//   • N/A                  (no score for that window)
// =============================================================================

type BandKey = "above" | "below" | "well" | "na";

const BANDS: Record<
  BandKey,
  { label: string; color: string; soft: string; ring: string }
> = {
  above: {
    label: "At or Above Benchmark",
    color: "#84cc16", // lime-500
    soft: "rgba(132, 204, 22, 0.55)",
    ring: "ring-lime-500",
  },
  below: {
    label: "Below Benchmark",
    color: "#facc15", // yellow-400
    soft: "rgba(250, 204, 21, 0.55)",
    ring: "ring-yellow-400",
  },
  well: {
    label: "Well Below Benchmark",
    color: "#f87171", // red-400
    soft: "rgba(248, 113, 113, 0.55)",
    ring: "ring-red-400",
  },
  na: {
    label: "N/A",
    color: "#94a3b8", // slate-400
    soft: "rgba(148, 163, 184, 0.45)",
    ring: "ring-slate-400",
  },
};

const BAND_ORDER: BandKey[] = ["above", "below", "well", "na"];

type Subject = "ela" | "math";
type WindowPair = "pm1_pm3" | "pm1_pm2" | "pm2_pm3";
type GradeKey = "all" | "K" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8";

const WINDOW_LABELS: Record<WindowPair, { left: string; right: string }> = {
  pm1_pm3: { left: "PM1 · Beginning", right: "PM3 · End" },
  pm1_pm2: { left: "PM1 · Beginning", right: "PM2 · Middle" },
  pm2_pm3: { left: "PM2 · Middle", right: "PM3 · End" },
};

// -- Synthetic data ----------------------------------------------------------
//
// 16-cell movement matrix (4 starting bands × 4 ending bands).  Numbers
// chosen to look plausible at a school-district scale and to mirror the
// classic Educlimber pattern: most students stay in their starting band,
// a healthy chunk of "well below" climbs into "below", and a smaller
// number of "above" drops down (regression).
//
// Filter dropdowns multiply the base matrix by deterministic factors
// so the user can see the chart respond — purely demo behavior, no real
// query is wired up.

type Matrix = Record<BandKey, Record<BandKey, number>>;

const BASE_MATRIX_ELA: Matrix = {
  above: { above: 1820, below: 280, well: 60, na: 30 },
  below: { above: 410, below: 520, well: 180, na: 25 },
  well: { above: 110, below: 360, well: 580, na: 30 },
  na: { above: 60, below: 90, well: 70, na: 80 },
};

const BASE_MATRIX_MATH: Matrix = {
  above: { above: 1640, below: 340, well: 90, na: 30 },
  below: { above: 320, below: 600, well: 220, na: 25 },
  well: { above: 80, below: 320, well: 720, na: 35 },
  na: { above: 50, below: 100, well: 80, na: 80 },
};

function scaleMatrix(m: Matrix, factor: number): Matrix {
  const out: Matrix = {
    above: { above: 0, below: 0, well: 0, na: 0 },
    below: { above: 0, below: 0, well: 0, na: 0 },
    well: { above: 0, below: 0, well: 0, na: 0 },
    na: { above: 0, below: 0, well: 0, na: 0 },
  };
  for (const from of BAND_ORDER) {
    for (const to of BAND_ORDER) {
      out[from][to] = Math.max(1, Math.round(m[from][to] * factor));
    }
  }
  return out;
}

// Each grade gets its own scale factor (younger grades = smaller cohort
// in this synthetic district; "all" sums every grade so it dwarfs any
// single grade).  PM2→PM3 is later in the year so a touch more movement.
const GRADE_FACTORS: Record<GradeKey, number> = {
  all: 1.0,
  K: 0.11,
  "1": 0.12,
  "2": 0.12,
  "3": 0.13,
  "4": 0.13,
  "5": 0.13,
  "6": 0.09,
  "7": 0.09,
  "8": 0.08,
};

function buildMatrix(
  subject: Subject,
  grade: GradeKey,
  window: WindowPair,
): Matrix {
  const base = subject === "ela" ? BASE_MATRIX_ELA : BASE_MATRIX_MATH;
  const gradeF = GRADE_FACTORS[grade];
  const windowF =
    window === "pm1_pm3" ? 1.0 : window === "pm1_pm2" ? 0.92 : 1.06;
  return scaleMatrix(base, gradeF * windowF);
}

// -- Chart data shape --------------------------------------------------------
//
// recharts' Sankey takes { nodes: [{name}], links: [{source, target,
// value}] } where source/target are 0-based node indices.  We lay out
// the 4 left nodes first (indices 0–3) and the 4 right nodes after
// (indices 4–7) so the chart stays in band order top→bottom.

interface SankeyNodeData {
  name: string;
  side: "left" | "right";
  band: BandKey;
}
interface SankeyLinkData {
  source: number;
  target: number;
  value: number;
  fromBand: BandKey;
  toBand: BandKey;
}

function buildSankeyData(matrix: Matrix): {
  nodes: SankeyNodeData[];
  links: SankeyLinkData[];
} {
  const nodes: SankeyNodeData[] = [
    ...BAND_ORDER.map(
      (b): SankeyNodeData => ({
        name: BANDS[b].label,
        side: "left",
        band: b,
      }),
    ),
    ...BAND_ORDER.map(
      (b): SankeyNodeData => ({
        name: `${BANDS[b].label} `,
        side: "right",
        band: b,
      }),
    ),
  ];

  const links: SankeyLinkData[] = [];
  BAND_ORDER.forEach((from, fi) => {
    BAND_ORDER.forEach((to, ti) => {
      const value = matrix[from][to];
      if (value > 0) {
        links.push({
          source: fi,
          target: 4 + ti,
          value,
          fromBand: from,
          toBand: to,
        });
      }
    });
  });

  return { nodes, links };
}

// -- Chart renderers ---------------------------------------------------------

// Render function for Sankey nodes.  Each node gets the band color
// (lime / yellow / red / slate) plus an inline label outside the chart
// margin so wide band names like "Well Below Benchmark" don't clip.
function renderSankeyNode(props: {
  x: number;
  y: number;
  width: number;
  height: number;
  index: number;
  payload: SankeyNodeData & { value?: number };
}) {
  const { x, y, width, height, index, payload } = props;
  const side: "left" | "right" = index < 4 ? "left" : "right";
  const band = BAND_ORDER[index % 4];
  const color = BANDS[band].color;
  const labelOnLeft = side === "left";
  const labelX = labelOnLeft ? x - 8 : x + width + 8;
  const value = payload?.value ?? 0;

  return (
    <Layer key={`sankey-node-${index}`}>
      <Rectangle
        x={x}
        y={y}
        width={width}
        height={height}
        fill={color}
        fillOpacity={0.95}
      />
      <text
        textAnchor={labelOnLeft ? "end" : "start"}
        x={labelX}
        y={y + height / 2 - 6}
        fontSize={12}
        fontWeight={700}
        fill="#0f172a"
        dominantBaseline="middle"
        style={{ pointerEvents: "none" }}
      >
        {(payload?.name ?? "").trim()}
      </text>
      <text
        textAnchor={labelOnLeft ? "end" : "start"}
        x={labelX}
        y={y + height / 2 + 10}
        fontSize={11}
        fontWeight={600}
        fill="#475569"
        dominantBaseline="middle"
        style={{ pointerEvents: "none" }}
      >
        {value.toLocaleString()} students
      </text>
    </Layer>
  );
}

// Render function for Sankey links.  Recharts passes layout-computed
// coords + the original payload; we color each ribbon by the END band
// (matches the Educlimber screenshot — viewer's eye follows the green
// ribbons to "where students landed").
function renderSankeyLink(props: {
  sourceX: number;
  targetX: number;
  sourceY: number;
  targetY: number;
  sourceControlX: number;
  targetControlX: number;
  linkWidth: number;
  index: number;
  payload: SankeyLinkData;
}) {
  const {
    sourceX,
    targetX,
    sourceY,
    targetY,
    sourceControlX,
    targetControlX,
    linkWidth,
    index,
    payload,
  } = props;
  const toBand: BandKey = payload?.toBand ?? "na";
  const fill = BANDS[toBand].soft;

  // Recharts hands sourceY/targetY pre-centered for the link's thickness,
  // so we draw the centerline directly and let strokeWidth fill it in.
  return (
    <path
      key={`sankey-link-${index}`}
      d={`
        M${sourceX},${sourceY}
        C${sourceControlX},${sourceY}
         ${targetControlX},${targetY}
         ${targetX},${targetY}
      `}
      fill="none"
      stroke={fill}
      strokeWidth={linkWidth}
      strokeOpacity={1}
    />
  );
}

// =============================================================================
// Main component
// =============================================================================

export function ProgramEffectivenessSankey() {
  const [subject, setSubject] = useState<Subject>("ela");
  const [grade, setGrade] = useState<GradeKey>("all");
  const [windowPair, setWindowPair] = useState<WindowPair>("pm1_pm3");

  const matrix = useMemo(
    () => buildMatrix(subject, grade, windowPair),
    [subject, grade, windowPair],
  );
  const { nodes, links } = useMemo(() => buildSankeyData(matrix), [matrix]);

  const total = useMemo(
    () =>
      BAND_ORDER.reduce(
        (sum, from) =>
          sum +
          BAND_ORDER.reduce((s2, to) => s2 + matrix[from][to], 0),
        0,
      ),
    [matrix],
  );

  // Per-band totals on each side, for the legend strip below the chart.
  const leftTotals = useMemo<Record<BandKey, number>>(() => {
    const t: Record<BandKey, number> = {
      above: 0,
      below: 0,
      well: 0,
      na: 0,
    };
    for (const from of BAND_ORDER) {
      for (const to of BAND_ORDER) t[from] += matrix[from][to];
    }
    return t;
  }, [matrix]);
  const rightTotals = useMemo<Record<BandKey, number>>(() => {
    const t: Record<BandKey, number> = {
      above: 0,
      below: 0,
      well: 0,
      na: 0,
    };
    for (const from of BAND_ORDER) {
      for (const to of BAND_ORDER) t[to] += matrix[from][to];
    }
    return t;
  }, [matrix]);

  const movedUp = useMemo(() => {
    // Students who finished in a higher band than they started.  N/A
    // doesn't count either way.
    let count = 0;
    const rank: Record<BandKey, number> = {
      well: 0,
      below: 1,
      above: 2,
      na: -1,
    };
    for (const from of BAND_ORDER) {
      for (const to of BAND_ORDER) {
        if (rank[from] >= 0 && rank[to] > rank[from])
          count += matrix[from][to];
      }
    }
    return count;
  }, [matrix]);

  const movedDown = useMemo(() => {
    let count = 0;
    const rank: Record<BandKey, number> = {
      well: 0,
      below: 1,
      above: 2,
      na: -1,
    };
    for (const from of BAND_ORDER) {
      for (const to of BAND_ORDER) {
        if (rank[from] >= 0 && rank[to] >= 0 && rank[to] < rank[from])
          count += matrix[from][to];
      }
    }
    return count;
  }, [matrix]);

  const winLabel = WINDOW_LABELS[windowPair];

  return (
    <div className="min-h-screen w-full bg-slate-50 text-slate-900 flex flex-col">
      {/* HEADER -------------------------------------------------------- */}
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
            </div>
          </div>

          {/* Filters --------------------------------------------------- */}
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <div className="flex items-center gap-1 text-xs font-semibold text-slate-500 mr-1">
              <Filter className="h-3.5 w-3.5" />
              FILTERS
            </div>
            <SubjectChip
              value="ela"
              active={subject === "ela"}
              onClick={() => setSubject("ela")}
              icon={BookOpen}
              label="ELA"
            />
            <SubjectChip
              value="math"
              active={subject === "math"}
              onClick={() => setSubject("math")}
              icon={Calculator}
              label="Math"
            />
            <Select
              value={grade}
              onChange={(v) => setGrade(v as GradeKey)}
              options={[
                { value: "all", label: "All grades" },
                { value: "K", label: "Grade K" },
                { value: "1", label: "Grade 1" },
                { value: "2", label: "Grade 2" },
                { value: "3", label: "Grade 3" },
                { value: "4", label: "Grade 4" },
                { value: "5", label: "Grade 5" },
                { value: "6", label: "Grade 6" },
                { value: "7", label: "Grade 7" },
                { value: "8", label: "Grade 8" },
              ]}
            />
            <Select
              value={windowPair}
              onChange={(v) => setWindowPair(v as WindowPair)}
              options={[
                { value: "pm1_pm3", label: "PM1 → PM3" },
                { value: "pm1_pm2", label: "PM1 → PM2" },
                { value: "pm2_pm3", label: "PM2 → PM3" },
              ]}
            />
          </div>
        </div>

        {/* Window pair label strip + summary stats */}
        <div className="mt-4 flex items-center justify-between text-sm">
          <div className="flex items-center gap-2 text-slate-600">
            <span className="font-semibold text-slate-900">{winLabel.left}</span>
            <span className="text-slate-400">→</span>
            <span className="font-semibold text-slate-900">{winLabel.right}</span>
            <span className="text-slate-400 mx-2">·</span>
            <span>
              {subject === "ela" ? "FAST aReading" : "FAST aMath"}
              {grade !== "all" ? ` · ${gradeLabel(grade)}` : ""}
            </span>
          </div>
          <div className="flex items-center gap-4 text-xs">
            <Stat label="Total students" value={total.toLocaleString()} />
            <Stat
              label="Moved up"
              value={movedUp.toLocaleString()}
              tone="up"
            />
            <Stat
              label="Moved down"
              value={movedDown.toLocaleString()}
              tone="down"
            />
            <Stat
              label="Stayed"
              value={(total - movedUp - movedDown).toLocaleString()}
            />
          </div>
        </div>
      </header>

      {/* SANKEY -------------------------------------------------------- */}
      <main className="flex-1 px-8 py-6 flex flex-col gap-4 min-h-0">
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6" style={{ height: 460 }}>
          <ResponsiveContainer width="100%" height="100%">
            <Sankey
              data={{ nodes, links }}
              nodePadding={28}
              nodeWidth={14}
              linkCurvature={0.55}
              iterations={64}
              margin={{ top: 10, right: 200, bottom: 10, left: 200 }}
              node={renderSankeyNode as never}
              link={renderSankeyLink as never}
            >
              <Tooltip
                content={<SankeyTooltip />}
                cursor={false}
                wrapperStyle={{ outline: "none" }}
              />
            </Sankey>
          </ResponsiveContainer>
        </div>

        {/* LEGEND + per-band tallies */}
        <div className="grid grid-cols-4 gap-3">
          {BAND_ORDER.map((b) => {
            const left = leftTotals[b];
            const right = rightTotals[b];
            const delta = right - left;
            return (
              <div
                key={b}
                className={`rounded-xl border border-slate-200 bg-white px-4 py-3 ring-1 ring-transparent ${BANDS[b].ring} ring-opacity-30`}
              >
                <div className="flex items-center gap-2 mb-2">
                  <span
                    className="inline-block h-3 w-3 rounded-sm"
                    style={{ backgroundColor: BANDS[b].color }}
                  />
                  <div className="text-xs font-bold uppercase tracking-wider text-slate-700">
                    {BANDS[b].label}
                  </div>
                </div>
                <div className="flex items-baseline gap-3">
                  <div className="text-2xl font-black tabular-nums text-slate-900">
                    {right.toLocaleString()}
                  </div>
                  <div
                    className={`text-xs font-semibold tabular-nums ${
                      b === "na"
                        ? "text-slate-500"
                        : delta > 0
                          ? "text-emerald-600"
                          : delta < 0
                            ? "text-rose-600"
                            : "text-slate-500"
                    }`}
                  >
                    {b === "na"
                      ? "—"
                      : delta > 0
                        ? `+${delta.toLocaleString()} vs ${winLabel.left.split(" ")[0]}`
                        : delta < 0
                          ? `${delta.toLocaleString()} vs ${winLabel.left.split(" ")[0]}`
                          : `no change`}
                  </div>
                </div>
                <div className="mt-1 text-[11px] text-slate-500">
                  {winLabel.left.split(" ")[0]}: {left.toLocaleString()} · {winLabel.right.split(" ")[0]}: {right.toLocaleString()}
                </div>
              </div>
            );
          })}
        </div>
      </main>

      {/* FOOTER -------------------------------------------------------- */}
      <footer className="px-8 py-3 border-t border-slate-200 bg-white text-xs text-slate-500 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Info className="h-3.5 w-3.5" />
          Ribbon thickness = student count · color = ending band ·
          students with no score in either window are bucketed as "N/A".
        </div>
        <div className="text-slate-400">
          PulseEDU · Insights · Mock data for design review
        </div>
      </footer>
    </div>
  );
}

// -- small UI helpers -------------------------------------------------------

function gradeLabel(g: GradeKey): string {
  return g === "K" ? "Kindergarten" : `Grade ${g}`;
}

function SubjectChip({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  value: Subject;
  active: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold border transition-colors ${
        active
          ? "bg-slate-900 text-white border-slate-900"
          : "bg-white text-slate-700 border-slate-300 hover:bg-slate-100"
      }`}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}

function Select<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: ReadonlyArray<{ value: T; label: string }>;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className="rounded-full px-3 py-1.5 text-sm font-semibold border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "up" | "down";
}) {
  const valueColor =
    tone === "up"
      ? "text-emerald-600"
      : tone === "down"
        ? "text-rose-600"
        : "text-slate-900";
  return (
    <div className="flex flex-col items-end">
      <div className={`text-base font-black tabular-nums leading-none ${valueColor}`}>
        {value}
      </div>
      <div className="text-[10px] uppercase tracking-wider text-slate-500 mt-0.5">
        {label}
      </div>
    </div>
  );
}

interface TooltipPayload {
  payload?: SankeyLinkData &
    SankeyNodeData & {
      source?: SankeyNodeData | number;
      target?: SankeyNodeData | number;
      value?: number;
    };
}

function SankeyTooltip(props: { active?: boolean; payload?: TooltipPayload[] }) {
  // Recharts Sankey hands the active item as `payload[0].payload`
  // (one extra `.payload` was a hover bug — tooltips were never showing).
  const item = props.payload?.[0]?.payload;
  if (!props.active || !item) return null;

  // Links carry from/to band keys; nodes carry a single band + name.
  const isLink =
    "fromBand" in item && "toBand" in item && item.fromBand && item.toBand;

  if (isLink) {
    const from = item.fromBand ?? "na";
    const to = item.toBand ?? "na";
    return (
      <div className="rounded-lg bg-slate-900 text-white px-3 py-2 shadow-xl text-xs">
        <div className="font-bold">
          {(item.value ?? 0).toLocaleString()} students
        </div>
        <div className="opacity-80 mt-0.5">
          {BANDS[from].label} → {BANDS[to].label}
        </div>
      </div>
    );
  }

  // Node tooltip — show band name + total value.
  if ("band" in item && item.band) {
    return (
      <div className="rounded-lg bg-slate-900 text-white px-3 py-2 shadow-xl text-xs">
        <div className="font-bold">{BANDS[item.band].label}</div>
        <div className="opacity-80 mt-0.5">
          {(item.value ?? 0).toLocaleString()} students
        </div>
      </div>
    );
  }
  return null;
}

export default ProgramEffectivenessSankey;
