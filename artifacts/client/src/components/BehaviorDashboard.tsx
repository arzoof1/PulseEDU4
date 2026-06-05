// Behavior Dashboard — school-level eduCLIMBER-style "Behavior" domain.
// Renders the totals, trend overlays, and top-N lists returned by
// GET /api/insights/behavior. Click a student name → opens that student's
// profile via onOpenProfile (same wiring engagement + watchlist use).
//
// Permission: backend gates this to core team (Admin / SuperUser /
// Behavior Specialist / MTSS Coord / PBIS Coord). The caller (App.tsx)
// should only mount this when the user passes that bar; we still render
// a clean error message if the backend rejects.

import { useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from "recharts";
import { authFetch } from "../lib/authToken";
import { HowToUseHelp, HowToSection, howtoListStyle } from "./HowToUseHelp";
import PulloutNoteTemplatesAdmin from "./PulloutNoteTemplatesAdmin";
import {
  EMPTY_FILTERS,
  filtersToQuery,
  type InsightsFilterValue,
} from "./InsightsFilterBar";
import InsightsPicker, {
  csvFilename,
  downloadCsv,
  extractTopLists,
  topListsToCsv,
} from "./InsightsPicker";

type WindowKey = "7" | "15" | "30" | "custom";

interface TopByCount {
  studentId: string;
  studentName: string;
  count: number;
}

interface TopReason {
  reason: string;
  count: number;
}

interface TopStaff {
  staffName: string;
  count: number;
}

interface BehaviorResponse {
  window: { from: string; to: string; label: string; days: number | null };
  grade: string | null;
  totals: {
    positives: number;
    negatives: number;
    netPoints: number;
    ratio: number | null;
    studentsRecognized: number;
    studentsWithNegatives: number;
  };
  trends: {
    positivesByDay: { date: string; count: number }[];
    negativesByDay: { date: string; count: number }[];
  };
  topLists: {
    recognizedStudents: TopByCount[];
    concerningStudents: TopByCount[];
    positiveReasons: TopReason[];
    negativeReasons: TopReason[];
    recognizingStaff: TopStaff[];
    issuingStaff: TopStaff[];
  };
}

interface Props {
  onOpenProfile: (studentId: string) => void;
}

const POSITIVE_COLOR = "#16a34a"; // green-600
const NEGATIVE_COLOR = "#dc2626"; // red-600

export default function BehaviorDashboard({ onOpenProfile }: Props) {
  const [windowKey, setWindowKey] = useState<WindowKey>("30");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [selectedGrades, setSelectedGrades] = useState<string[]>([]);
  const [filters, setFilters] = useState<InsightsFilterValue>(EMPTY_FILTERS);
  const [data, setData] = useState<BehaviorResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const queryString = useMemo(() => {
    const p = new URLSearchParams();
    if (windowKey === "custom") {
      if (!customFrom || !customTo) return null;
      p.set("window", "custom");
      p.set("from", customFrom);
      p.set("to", customTo);
    } else {
      p.set("window", windowKey);
    }
    if (selectedGrades.length > 0) p.set("grades", selectedGrades.join(","));
    for (const [k, v] of filtersToQuery(filters)) p.set(k, v);
    return p.toString();
  }, [windowKey, customFrom, customTo, selectedGrades, filters]);

  useEffect(() => {
    if (queryString === null) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    authFetch(`/api/insights/behavior?${queryString}`)
      .then(async (r) => {
        if (cancelled) return;
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          setError(body.error || `Request failed (${r.status})`);
          setData(null);
          return;
        }
        const json = (await r.json()) as BehaviorResponse;
        if (!cancelled) setData(json);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e?.message ?? e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [queryString]);

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "0.5rem",
        }}
      >
        <div>
          <h2 style={{ margin: 0 }}>Behavior</h2>
          <p style={{ color: "var(--text-subtle)", margin: "0.25rem 0 0" }}>
            PBIS positives and negatives — who's getting recognized, who
            needs support, and which behaviors are trending.
          </p>
        </div>
        <WindowChips
          windowKey={windowKey}
          setWindowKey={setWindowKey}
          customFrom={customFrom}
          setCustomFrom={setCustomFrom}
          customTo={customTo}
          setCustomTo={setCustomTo}
        />
      </div>

      <InsightsPicker
        grades={selectedGrades}
        onGradesChange={setSelectedGrades}
        filters={filters}
        onFiltersChange={setFilters}
        onDownloadCsv={() => {
          if (!data) return;
          downloadCsv(
            csvFilename("behavior", selectedGrades),
            topListsToCsv(extractTopLists(data)),
          );
        }}
        csvDisabled={!data}
      />

      <HowToUseHelp title="How to use Behavior">
        <HowToSection title="What this dashboard is">
          The school-wide PBIS picture for a chosen time window. Positive
          recognitions on one side, negative incidents on the other, and
          the trend line that shows whether the ratio is moving in the
          right direction. The point: spot the kids who need a check-in
          this week, and the kids who deserve a shout-out.
        </HowToSection>

        <HowToSection title="What the KPIs mean">
          <p style={{ margin: "0 0 0.5rem" }}>
            A <strong>KPI</strong> (Key Performance Indicator) is one of the
            headline numbers at the top of the dashboard — a single value that
            summarizes one slice of what's happening so you can read the whole
            picture at a glance.
          </p>
          <ul style={howtoListStyle}>
            <li>
              <strong>Positives / Negatives</strong> — total PBIS entries of
              each polarity in the selected window. Voided entries are
              excluded.
            </li>
            <li>
              <strong>Net points</strong> — positives minus negatives.
              Positive number = the school issued more recognitions than
              consequences this window.
            </li>
            <li>
              <strong>Ratio</strong> — positives divided by negatives. The
              research benchmark is roughly <strong>4-to-1</strong> (Tier 1
              healthy). Shown as "—" if there were no negatives in the
              window (the ratio is mathematically undefined).
            </li>
            <li>
              <strong>Students recognized</strong> — unique students who
              received at least one positive entry in the window.
            </li>
            <li>
              <strong>Students with negatives</strong> — unique students who
              received at least one negative entry. Compare these two
              numbers — a healthy month has the recognized count well above
              the negatives count.
            </li>
          </ul>
        </HowToSection>

        <HowToSection title="How to read the chart and lists">
          <ul style={howtoListStyle}>
            <li>
              <strong>Trend overlay</strong> — positives in{" "}
              <span style={{ color: "#16a34a", fontWeight: 700 }}>green</span>,
              negatives in{" "}
              <span style={{ color: "#dc2626", fontWeight: 700 }}>red</span>.
              Watch the gap: when red climbs and green stays flat, the
              culture is drifting and the team should respond.
            </li>
            <li>
              <strong>Top recognized / concerning students</strong> — names
              are clickable. Open a profile to see what the entries were
              actually about before reaching out.
            </li>
            <li>
              <strong>Top reasons</strong> (positive and negative) — the
              fastest read on what's driving the totals. If "talking out"
              dominates the negative list, that's a Tier 1 instructional
              decision, not a Tier 3 referral.
            </li>
            <li>
              <strong>Top staff</strong> — who is recognizing kids the
              most, and who is logging the most negatives. Useful for
              coaching and for spreading recognition habits.
            </li>
          </ul>
        </HowToSection>

        <HowToSection title="How to use it day-to-day">
          <ul style={howtoListStyle}>
            <li>
              <strong>Pick a window.</strong> 7d for "what happened this
              week", 30d for the monthly MTSS meeting, custom for a
              specific event window (post-break, after a schedule change,
              etc.).
            </li>
            <li>
              <strong>Filter by grade</strong> when you want to look at
              one grade-level team's caseload.
            </li>
            <li>
              <strong>Work the "Concerning students" list first.</strong>{" "}
              These are the kids the team should triage at MTSS. Click a
              row to open the student profile and see the full context.
            </li>
            <li>
              <strong>Use "Recognized students" for shout-outs.</strong>{" "}
              Same data, opposite intent — these are the kids to celebrate
              in announcements, newsletters, or staff meetings.
            </li>
          </ul>
        </HowToSection>

        <HowToSection title="A few caveats">
          <ul style={howtoListStyle}>
            <li>
              Voided PBIS entries are not counted on either side, so a
              corrected log won't show up here.
            </li>
            <li>
              The ratio is shown as "—" when negatives = 0 — that's not a
              missing value, that's a perfect window.
            </li>
            <li>
              All counts respect the window picker, so changing the window
              re-runs the totals, the chart, and the top-N lists together.
            </li>
          </ul>
        </HowToSection>
      </HowToUseHelp>

      {loading && (
        <p style={{ color: "var(--text-subtle)", marginTop: "1rem" }}>
          Loading behavior data…
        </p>
      )}
      {error && (
        <p style={{ color: "#b91c1c", marginTop: "1rem" }}>{error}</p>
      )}

      {data && !loading && !error && (
        <Body data={data} onOpenProfile={onOpenProfile} />
      )}

      {/* Behavior Specialist tools: edit the canned parent messages
          shown in the pullout Verify modal. Server gates writes to
          admin / behavior specialist / MTSS / dean / SuperUser. */}
      <PulloutNoteTemplatesAdmin />
    </div>
  );
}

// ---------- Filter strip ----------------------------------------------------

function WindowChips({
  windowKey,
  setWindowKey,
  customFrom,
  setCustomFrom,
  customTo,
  setCustomTo,
}: {
  windowKey: WindowKey;
  setWindowKey: (w: WindowKey) => void;
  customFrom: string;
  setCustomFrom: (s: string) => void;
  customTo: string;
  setCustomTo: (s: string) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: "0.5rem",
        alignItems: "center",
        flexWrap: "wrap",
      }}
    >
      {(["7", "15", "30", "custom"] as WindowKey[]).map((w) => (
        <button
          key={w}
          type="button"
          onClick={() => setWindowKey(w)}
          style={{
            ...chipStyle,
            background: w === windowKey ? "#1d4ed8" : "white",
            color: w === windowKey ? "white" : "#1f2937",
            borderColor: w === windowKey ? "#1d4ed8" : "#cbd5e1",
          }}
        >
          {w === "custom" ? "Custom" : `${w}d`}
        </button>
      ))}
      {windowKey === "custom" && (
        <>
          <input
            type="date"
            value={customFrom}
            onChange={(e) => setCustomFrom(e.target.value)}
            style={selectStyle}
          />
          <span style={{ color: "var(--text-subtle)" }}>→</span>
          <input
            type="date"
            value={customTo}
            onChange={(e) => setCustomTo(e.target.value)}
            style={selectStyle}
          />
        </>
      )}
    </div>
  );
}

// ---------- Body (KPIs + trends + top-N tables) ----------------------------

function Body({
  data,
  onOpenProfile,
}: {
  data: BehaviorResponse;
  onOpenProfile: (id: string) => void;
}) {
  const allZero = data.totals.positives === 0 && data.totals.negatives === 0;

  // Merge the two daily series into one row per date so the overlaid
  // AreaChart can read both `positives` and `negatives` from the same
  // record. The two server-side series are guaranteed to span the same
  // date range and order (denseSeries above), so we zip by index.
  const trendData = useMemo(() => {
    const len = Math.max(
      data.trends.positivesByDay.length,
      data.trends.negativesByDay.length,
    );
    const out: { date: string; positives: number; negatives: number }[] = [];
    for (let i = 0; i < len; i++) {
      const p = data.trends.positivesByDay[i];
      const n = data.trends.negativesByDay[i];
      out.push({
        date: p?.date ?? n?.date ?? "",
        positives: p?.count ?? 0,
        negatives: n?.count ?? 0,
      });
    }
    return out;
  }, [data.trends.positivesByDay, data.trends.negativesByDay]);

  return (
    <div style={{ marginTop: "1rem" }}>
      {/* KPI strip */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: "0.75rem",
          marginBottom: "1.25rem",
        }}
      >
        <Kpi
          label="Positives"
          value={data.totals.positives}
          accent={POSITIVE_COLOR}
        />
        <Kpi
          label="Negatives"
          value={data.totals.negatives}
          accent={NEGATIVE_COLOR}
        />
        <Kpi
          label="Pos : Neg ratio"
          rawValue={data.totals.ratio === null ? "—" : `${data.totals.ratio} : 1`}
          sub={
            data.totals.ratio !== null && data.totals.ratio < 4
              ? "below 4:1 healthy floor"
              : undefined
          }
        />
        <Kpi label="Net points" value={data.totals.netPoints} />
        <Kpi
          label="Students recognized"
          value={data.totals.studentsRecognized}
        />
        <Kpi
          label="Students w/ negatives"
          value={data.totals.studentsWithNegatives}
        />
      </div>

      {allZero && (
        <p style={{ color: "var(--text-subtle)", margin: "0.5rem 0 1.5rem" }}>
          No PBIS entries recorded in this window
          {data.grade ? ` for grade ${data.grade}` : ""}. Try a wider window
          or a different grade cohort.
        </p>
      )}

      {/* Trend overlay: positive vs negative on the same axis */}
      {!allZero && (
        <div
          style={{
            border: "1px solid var(--border, #e5e7eb)",
            borderRadius: 8,
            padding: "0.85rem 1rem",
            background: "var(--card-bg, white)",
            marginBottom: "1.25rem",
          }}
        >
          <div
            style={{
              fontSize: 12,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              color: "var(--text-subtle, #64748b)",
              marginBottom: "0.5rem",
            }}
          >
            Positives vs negatives / day
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart
              data={trendData}
              margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 10 }}
                tickFormatter={(d: string) => d.slice(5)}
                interval="preserveStartEnd"
                minTickGap={20}
              />
              <YAxis tick={{ fontSize: 10 }} allowDecimals={false} width={28} />
              <Tooltip contentStyle={{ fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Area
                type="monotone"
                dataKey="positives"
                name="Positives"
                stroke={POSITIVE_COLOR}
                fill={POSITIVE_COLOR}
                fillOpacity={0.18}
                strokeWidth={2}
              />
              <Area
                type="monotone"
                dataKey="negatives"
                name="Negatives"
                stroke={NEGATIVE_COLOR}
                fill={NEGATIVE_COLOR}
                fillOpacity={0.18}
                strokeWidth={2}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Top-N tables */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
          gap: "0.75rem",
        }}
      >
        <TopStudentTable
          title="Top recognized students"
          rows={data.topLists.recognizedStudents}
          unit="positives"
          onOpenProfile={onOpenProfile}
          accent={POSITIVE_COLOR}
        />
        <TopStudentTable
          title="Top concerning students"
          rows={data.topLists.concerningStudents}
          unit="negatives"
          onOpenProfile={onOpenProfile}
          accent={NEGATIVE_COLOR}
        />
        <TopValueTable
          title="Top positive reasons"
          rows={data.topLists.positiveReasons.map((r) => ({
            label: r.reason,
            value: r.count,
          }))}
          unit="awards"
          accent={POSITIVE_COLOR}
        />
        <TopValueTable
          title="Top negative reasons"
          rows={data.topLists.negativeReasons.map((r) => ({
            label: r.reason,
            value: r.count,
          }))}
          unit="entries"
          accent={NEGATIVE_COLOR}
        />
        <TopValueTable
          title="Top recognizing staff"
          rows={data.topLists.recognizingStaff.map((r) => ({
            label: r.staffName,
            value: r.count,
          }))}
          unit="positives"
        />
        <TopValueTable
          title="Top issuing staff (negatives)"
          rows={data.topLists.issuingStaff.map((r) => ({
            label: r.staffName,
            value: r.count,
          }))}
          unit="negatives"
        />
      </div>

      <p
        style={{
          color: "var(--text-subtle)",
          fontSize: 12,
          marginTop: "1rem",
        }}
      >
        Window: {data.window.label}
        {data.grade ? ` · Grade ${data.grade}` : ""}
      </p>
    </div>
  );
}

// ---------- Reusable bits ---------------------------------------------------

function Kpi({
  label,
  value,
  rawValue,
  sub,
  accent,
}: {
  label: string;
  value?: number;
  rawValue?: string;
  sub?: string;
  accent?: string;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--border, #e5e7eb)",
        borderLeft: accent ? `3px solid ${accent}` : undefined,
        borderRadius: 8,
        padding: "0.85rem 1rem",
        background: "var(--card-bg, white)",
      }}
    >
      <div
        style={{
          fontSize: 11,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "var(--text-subtle, #64748b)",
          marginBottom: "0.25rem",
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: "1.6rem", fontWeight: 600 }}>
        {rawValue ?? (value ?? 0).toLocaleString()}
      </div>
      {sub && (
        <div style={{ fontSize: 11, color: "var(--text-subtle, #94a3b8)" }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function TopStudentTable({
  title,
  rows,
  unit,
  onOpenProfile,
  accent,
}: {
  title: string;
  rows: { studentId: string; studentName: string; count: number }[];
  unit: string;
  onOpenProfile: (id: string) => void;
  accent?: string;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--border, #e5e7eb)",
        borderTop: accent ? `3px solid ${accent}` : undefined,
        borderRadius: 8,
        padding: "0.85rem 1rem",
        background: "var(--card-bg, white)",
      }}
    >
      <div
        style={{
          fontSize: 12,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          color: "var(--text-subtle, #64748b)",
          marginBottom: "0.5rem",
        }}
      >
        {title}
      </div>
      {rows.length === 0 ? (
        <p style={{ color: "var(--text-subtle)", fontSize: 13, margin: 0 }}>
          No data in this window.
        </p>
      ) : (
        <table className="pulse-table"
          style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}
        >
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.studentId}
                style={{ borderBottom: "1px solid #f1f5f9" }}
              >
                <td style={{ padding: "0.35rem 0" }}>
                  <button
                    type="button"
                    onClick={() => onOpenProfile(r.studentId)}
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "#1d4ed8",
                      cursor: "pointer",
                      padding: 0,
                      font: "inherit",
                      textAlign: "left",
                    }}
                  >
                    {r.studentName}
                  </button>
                </td>
                <td
                  style={{
                    padding: "0.35rem 0",
                    textAlign: "right",
                    fontVariantNumeric: "tabular-nums",
                    color: "var(--text-subtle, #475569)",
                  }}
                >
                  {r.count.toLocaleString()} {unit}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function TopValueTable({
  title,
  rows,
  unit,
  accent,
}: {
  title: string;
  rows: { label: string; value: number }[];
  unit: string;
  accent?: string;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--border, #e5e7eb)",
        borderTop: accent ? `3px solid ${accent}` : undefined,
        borderRadius: 8,
        padding: "0.85rem 1rem",
        background: "var(--card-bg, white)",
      }}
    >
      <div
        style={{
          fontSize: 12,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          color: "var(--text-subtle, #64748b)",
          marginBottom: "0.5rem",
        }}
      >
        {title}
      </div>
      {rows.length === 0 ? (
        <p style={{ color: "var(--text-subtle)", fontSize: 13, margin: 0 }}>
          No data in this window.
        </p>
      ) : (
        <table className="pulse-table"
          style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}
        >
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} style={{ borderBottom: "1px solid #f1f5f9" }}>
                <td style={{ padding: "0.35rem 0" }}>{r.label}</td>
                <td
                  style={{
                    padding: "0.35rem 0",
                    textAlign: "right",
                    fontVariantNumeric: "tabular-nums",
                    color: "var(--text-subtle, #475569)",
                  }}
                >
                  {r.value.toLocaleString()} {unit}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  padding: "0.4rem 0.6rem",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  background: "white",
  font: "inherit",
  fontSize: 13,
};

const chipStyle: React.CSSProperties = {
  padding: "0.4rem 0.7rem",
  border: "1px solid #cbd5e1",
  borderRadius: 999,
  cursor: "pointer",
  font: "inherit",
  fontSize: 13,
};
