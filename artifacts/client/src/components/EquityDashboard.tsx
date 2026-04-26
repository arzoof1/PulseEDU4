// Equity Dashboard — school-level eduCLIMBER-style "Whole Child" view of
// outcomes broken out by demographic subgroup, with **risk ratio** as the
// headline metric. Designed for district-level conversations: "Where are
// the disparities, how big are they, and which subgroups should we look at
// first?"
//
// Renders the totals, disparity flags top-N, and per-subgroup snapshot
// grid returned by GET /api/insights/equity. Subgroups: ELL, IEP, 504,
// gender (Female/Male), 7 race buckets (White/Hispanic/Black/Asian/
// Multi-Race/Native/Pacific) and a separate Hispanic ethnicity flag
// (federal-style: race and ethnicity are independent fields per OMB
// Directive 15). FRL is still a known followup tied to the SIS import.
//
// Permission: backend gates this to the core team. The caller (App.tsx)
// should only mount this when the user passes that bar; we still render
// a clean error message if the backend rejects.

import { useEffect, useRef, useState } from "react";
import { authFetch } from "../lib/authToken";

// ------------------------- API contract types ------------------------------

type SubgroupKey =
  | "ELL"
  | "IEP"
  | "504"
  | "Female"
  | "Male"
  | "White"
  | "Hispanic"
  | "Black"
  | "Asian"
  | "Multi-Race"
  | "Native"
  | "Pacific"
  | "Hispanic Ethnicity";
type WorseDirection = "higher" | "lower";

interface DisparityFlag {
  subgroup: SubgroupKey;
  subgroupSize: number;
  peerSize: number;
  metric: string;
  metricKey: string;
  worseDirection: WorseDirection;
  inGroupValue: number | null;
  outGroupValue: number | null;
  riskRatio: number | null;
  concerning: boolean;
}

interface SubgroupSnapshotMetric {
  key: string;
  name: string;
  worseDirection: WorseDirection;
  inGroupValue: number | null;
  outGroupValue: number | null;
  riskRatio: number | null;
}

interface SubgroupSnapshot {
  subgroup: SubgroupKey;
  inGroupSize: number;
  outGroupSize: number;
  metrics: SubgroupSnapshotMetric[];
}

interface EquityResponse {
  grade: string | null;
  windowDays: number;
  totals: {
    cohortStudents: number;
    ellCount: number;
    ellPct: number;
    iepCount: number;
    iepPct: number;
    students504Count: number;
    students504Pct: number;
    femaleCount: number;
    femalePct: number;
    maleCount: number;
    malePct: number;
    unknownGenderCount: number;
    unknownGenderPct: number;
    raceMix: {
      white: { count: number; pct: number };
      hispanic: { count: number; pct: number };
      black: { count: number; pct: number };
      asian: { count: number; pct: number };
      multi: { count: number; pct: number };
      native: { count: number; pct: number };
      pacific: { count: number; pct: number };
      unknown: { count: number; pct: number };
    };
    ethnicityHispanicCount: number;
    ethnicityHispanicPct: number;
    ethnicityUnknownCount: number;
    ethnicityUnknownPct: number;
    highDisparityFlagCount: number;
    maxRiskRatio: number | null;
  };
  disparityFlags: DisparityFlag[];
  subgroupSnapshots: SubgroupSnapshot[];
  sources: {
    plans: number;
    accommodations: number;
    negativePbisLast30d: number;
    positivePbisLast30d: number;
    fastBq: number;
    engagementLast30d: number;
  };
}

interface Props {
  onOpenProfile: (studentId: string) => void;
}

const GRADE_OPTIONS = [
  { value: "", label: "All grades" },
  { value: "K", label: "K" },
  ...Array.from({ length: 12 }, (_, i) => ({
    value: String(i + 1),
    label: `Grade ${i + 1}`,
  })),
];

// Palette: distinct from the prior four dashboards (which used violet/blue/red).
//   - teal     = demographic counts (neutral cohort makeup)
//   - amber    = secondary headline (flag count)
//   - rose-600 = the BIG headline (max risk ratio) — high contrast for demo
//   - slate    = dark accent for the per-subgroup grid headers
const TEAL = "#0d9488";
const AMBER = "#d97706";
const ROSE = "#e11d48";
const SLATE = "#334155";

// Risk-ratio coloring. Two functions:
//  - tone()  → "good" | "neutral" | "bad" given ratio + worseDirection
//  - toneColor() → CSS color for that tone
type Tone = "good" | "neutral" | "bad";
function tone(ratio: number | null, dir: WorseDirection): Tone {
  if (ratio == null) return "neutral";
  // 30% gap in either direction is the "concerning" threshold.
  const HIGH = 1.3;
  const LOW = 1 / HIGH;
  if (dir === "higher") {
    if (ratio >= HIGH) return "bad";
    if (ratio <= LOW) return "good";
    return "neutral";
  }
  // dir === "lower" — high ratio means in-group has MORE of the metric,
  // and the metric itself is desirable, so high = good.
  if (ratio >= HIGH) return "good";
  if (ratio <= LOW) return "bad";
  return "neutral";
}
function toneColor(t: Tone): string {
  if (t === "bad") return "#dc2626"; // red-600
  if (t === "good") return "#059669"; // emerald-600
  return "#475569"; // slate-600
}

// Subgroup chip palette so each subgroup reads visually distinct in the
// disparity flags table at a glance.
const SUBGROUP_COLORS: Record<SubgroupKey, { bg: string; fg: string }> = {
  // Demographic flags — warm chip family.
  ELL: { bg: "#fef3c7", fg: "#92400e" }, // amber
  IEP: { bg: "#ede9fe", fg: "#6d28d9" }, // violet
  "504": { bg: "#dbeafe", fg: "#1e40af" }, // blue
  Female: { bg: "#fce7f3", fg: "#9d174d" }, // pink
  Male: { bg: "#cffafe", fg: "#155e75" }, // cyan
  // Race chips — cool/neutral palette so they read as a distinct family
  // from the demographic flags above.
  White: { bg: "#f1f5f9", fg: "#334155" }, // slate
  Hispanic: { bg: "#fff7ed", fg: "#9a3412" }, // orange
  Black: { bg: "#f5f3ff", fg: "#5b21b6" }, // deep violet
  Asian: { bg: "#ecfeff", fg: "#0e7490" }, // teal
  "Multi-Race": { bg: "#f0fdf4", fg: "#166534" }, // green
  Native: { bg: "#fef2f2", fg: "#991b1b" }, // muted red
  Pacific: { bg: "#eff6ff", fg: "#1d4ed8" }, // indigo
  // Ethnicity — single chip for Hispanic origin Y/N.
  "Hispanic Ethnicity": { bg: "#fef3c7", fg: "#78350f" }, // dark amber
};

export default function EquityDashboard({ onOpenProfile: _ }: Props) {
  // _ retained in props signature for future drill-in (matches sibling
  // dashboards' Props shape so App.tsx wiring stays uniform), but the v1
  // equity view is aggregate-only — no per-student lists yet.
  const [grade, setGrade] = useState("");
  const [data, setData] = useState<EquityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    const qs = new URLSearchParams();
    if (grade) qs.set("grade", grade);
    authFetch(`/api/insights/equity?${qs.toString()}`)
      .then(async (r) => {
        if (cancelled) return;
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          setError(body.error || `Request failed (${r.status})`);
          setData(null);
          return;
        }
        const json = (await r.json()) as EquityResponse;
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
  }, [grade]);

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
          <h2 style={{ margin: 0 }}>Equity</h2>
          <p style={{ color: "var(--text-subtle)", margin: "0.25rem 0 0" }}>
            Risk ratios across ELL, IEP, 504, and gender — surfaces where
            outcomes diverge from peer rates so the team can act before the
            disparity widens.
          </p>
        </div>
        <div
          style={{
            display: "flex",
            gap: "0.5rem",
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <select
            value={grade}
            onChange={(e) => setGrade(e.target.value)}
            style={selectStyle}
          >
            {GRADE_OPTIONS.map((g) => (
              <option key={g.value} value={g.value}>
                {g.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {loading && (
        <p style={{ color: "var(--text-subtle)", marginTop: "1rem" }}>
          Loading equity data…
        </p>
      )}
      {error && <p style={{ color: "#b91c1c", marginTop: "1rem" }}>{error}</p>}

      {data && !loading && !error && <Body data={data} />}
    </div>
  );
}

// ---------------------------- Body ----------------------------------------

function Body({ data }: { data: EquityResponse }) {
  const t = data.totals;
  const allEmpty = t.cohortStudents === 0;
  // No demographic data populated. Means the SIS import (or seed) hasn't
  // landed yet for this cohort. Distinct from "everything is zero" — show
  // the friendly importer prompt rather than a blank dashboard.
  const noDemographics =
    !allEmpty &&
    t.ellCount === 0 &&
    t.iepCount === 0 &&
    t.students504Count === 0 &&
    t.femaleCount === 0 &&
    t.maleCount === 0;

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
        <Kpi label="Cohort size" value={fmtInt(t.cohortStudents)} accent={SLATE} />
        <Kpi
          label="ELL"
          value={fmtInt(t.ellCount)}
          accent={TEAL}
          sub={`${pctFmt(t.ellPct)} of cohort`}
        />
        <Kpi
          label="IEP"
          value={fmtInt(t.iepCount)}
          accent={TEAL}
          sub={`${pctFmt(t.iepPct)} of cohort`}
        />
        <Kpi
          label="504"
          value={fmtInt(t.students504Count)}
          accent={TEAL}
          sub={`${pctFmt(t.students504Pct)} of cohort`}
        />
        {/* HEADLINE TILE — visually dominant by virtue of the rose accent
            + larger value text. This is the number district staff lock onto
            during a presentation. */}
        <Kpi
          label="Max risk ratio"
          value={t.maxRiskRatio == null ? "—" : `${t.maxRiskRatio.toFixed(2)}x`}
          accent={ROSE}
          big
          sub={
            t.maxRiskRatio == null
              ? "No subgroups large enough"
              : "Most extreme in-group vs peer gap"
          }
        />
        <Kpi
          label="Disparity flags"
          value={fmtInt(t.highDisparityFlagCount)}
          accent={AMBER}
          sub="≥ 30% gap, ≥ 10 students"
        />
      </div>

      {allEmpty && (
        <p style={{ color: "var(--text-subtle)", margin: "0.5rem 0 1.5rem" }}>
          No students in this cohort
          {data.grade ? ` (grade ${data.grade})` : ""}. Try a different grade.
        </p>
      )}

      {noDemographics && (
        <div
          style={{
            border: "1px dashed #cbd5e1",
            borderRadius: 8,
            padding: "1rem 1.25rem",
            background: "#f8fafc",
            marginBottom: "1.5rem",
            color: "#475569",
            fontSize: 14,
          }}
        >
          No demographic data yet for this cohort. Import a SIS roster with
          ELL / ESE / 504 / gender fields to populate this view.
        </div>
      )}

      {!allEmpty && !noDemographics && (
        <>
          <DisparityFlagsPanel flags={data.disparityFlags} />
          <ReorderableSubgroupGrid snapshots={data.subgroupSnapshots} />
        </>
      )}

      {/* Footer: data sources + demo-data disclaimer. */}
      <div
        style={{
          marginTop: "1.25rem",
          paddingTop: "0.75rem",
          borderTop: "1px solid #f1f5f9",
          color: "var(--text-subtle, #64748b)",
          fontSize: 11,
          lineHeight: 1.6,
        }}
      >
        <div>
          Window: last {data.windowDays} days. Sources:{" "}
          {data.sources.plans} active plans · {data.sources.accommodations}{" "}
          accommodations · {data.sources.negativePbisLast30d} neg PBIS ·{" "}
          {data.sources.positivePbisLast30d} pos PBIS ·{" "}
          {data.sources.fastBq} BQ flags · {data.sources.engagementLast30d}{" "}
          engagement events.
        </div>
        <div style={{ marginTop: 4, fontStyle: "italic" }}>
          Demo seed includes mild correlations between risk signals and
          demographics for illustrative purposes — real disparities will
          reflect your school's actual data once SIS rosters are imported.
        </div>
      </div>
    </div>
  );
}

// --------------------- Disparity flags top-N panel ------------------------

function DisparityFlagsPanel({ flags }: { flags: DisparityFlag[] }) {
  return (
    <div style={panelStyle(ROSE)}>
      <div style={panelTitleStyle}>
        Disparity flags — biggest in-group vs peer gaps
      </div>
      {flags.length === 0 ? (
        <p style={emptyRowStyle}>
          No subgroups currently exceed the 30% disparity threshold (with at
          least 10 students in-group). The cohort's outcomes are roughly
          consistent across demographic lines.
        </p>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr style={{ color: "#64748b", fontSize: 11 }}>
              <th style={{ textAlign: "left", padding: "0.4rem 0", fontWeight: 500 }}>
                Subgroup
              </th>
              <th style={{ textAlign: "left", padding: "0.4rem 0.5rem", fontWeight: 500 }}>
                Metric
              </th>
              <th
                style={{
                  textAlign: "right",
                  padding: "0.4rem 0.5rem",
                  fontWeight: 500,
                }}
              >
                In-group
              </th>
              <th
                style={{
                  textAlign: "right",
                  padding: "0.4rem 0.5rem",
                  fontWeight: 500,
                }}
              >
                Peers
              </th>
              <th
                style={{ textAlign: "right", padding: "0.4rem 0", fontWeight: 500 }}
              >
                Risk ratio
              </th>
            </tr>
          </thead>
          <tbody>
            {flags.map((f, i) => {
              const t = tone(f.riskRatio, f.worseDirection);
              const ratioColor = toneColor(t);
              return (
                <tr
                  key={`${f.subgroup}-${f.metricKey}-${i}`}
                  style={{ borderTop: "1px solid #f1f5f9" }}
                >
                  <td style={{ padding: "0.55rem 0", verticalAlign: "middle" }}>
                    <SubgroupChip k={f.subgroup} />
                    <div
                      style={{
                        fontSize: 11,
                        color: "#64748b",
                        marginTop: 2,
                      }}
                    >
                      n={f.subgroupSize.toLocaleString()} vs{" "}
                      {f.peerSize.toLocaleString()}
                    </div>
                  </td>
                  <td
                    style={{
                      padding: "0.55rem 0.5rem",
                      verticalAlign: "middle",
                      fontSize: 13,
                    }}
                  >
                    {f.metric}
                    <div
                      style={{ fontSize: 10, color: "#94a3b8", marginTop: 2 }}
                    >
                      {f.worseDirection === "higher" ? "↑ = concern" : "↓ = concern"}
                    </div>
                  </td>
                  <td
                    style={{
                      padding: "0.55rem 0.5rem",
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                      fontSize: 13,
                      verticalAlign: "middle",
                    }}
                  >
                    {fmtMetricValue(f.inGroupValue, f.metricKey)}
                  </td>
                  <td
                    style={{
                      padding: "0.55rem 0.5rem",
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                      fontSize: 13,
                      color: "#64748b",
                      verticalAlign: "middle",
                    }}
                  >
                    {fmtMetricValue(f.outGroupValue, f.metricKey)}
                  </td>
                  <td
                    style={{
                      padding: "0.55rem 0",
                      textAlign: "right",
                      verticalAlign: "middle",
                    }}
                  >
                    <span
                      style={{
                        display: "inline-block",
                        fontSize: 22,
                        fontWeight: 700,
                        color: ratioColor,
                        fontVariantNumeric: "tabular-nums",
                        letterSpacing: "-0.02em",
                      }}
                    >
                      {f.riskRatio == null ? "—" : `${f.riskRatio.toFixed(2)}x`}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// --------------------- Per-subgroup snapshot grid -------------------------

// Apply a saved order to incoming snapshots. Snapshots not present in the
// saved order land at the end (so a newly-added subgroup shows up without
// the user having to re-save). Saved entries that don't match any current
// snapshot are silently dropped.
function applySavedOrder(
  snapshots: SubgroupSnapshot[],
  saved: SubgroupKey[] | null,
): SubgroupSnapshot[] {
  if (!saved || saved.length === 0) return snapshots;
  const bySub = new Map<SubgroupKey, SubgroupSnapshot>();
  for (const s of snapshots) bySub.set(s.subgroup, s);
  const out: SubgroupSnapshot[] = [];
  const used = new Set<SubgroupKey>();
  for (const k of saved) {
    const s = bySub.get(k);
    if (s) {
      out.push(s);
      used.add(k);
    }
  }
  for (const s of snapshots) {
    if (!used.has(s.subgroup)) out.push(s);
  }
  return out;
}

// Reorderable wrapper around SubgroupSnapshotGrid. Owns the order state,
// loads/saves it via /api/me/ui-prefs/equity-subgroup-order, and wires
// HTML5 drag-and-drop. Save is debounced (400ms) so a quick sequence of
// re-arrangements only hits the server once.
function ReorderableSubgroupGrid({
  snapshots,
}: {
  snapshots: SubgroupSnapshot[];
}) {
  // ordered = the snapshots in their current display order. Source of
  // truth for what's rendered. Initialised from the server response and
  // re-derived whenever the parent's `snapshots` prop identity changes.
  const [ordered, setOrdered] = useState<SubgroupSnapshot[]>(snapshots);
  // dragKey = which tile is currently being dragged (for opacity cue).
  const [dragKey, setDragKey] = useState<SubgroupKey | null>(null);
  // overKey = which tile we're hovering over as a drop target.
  const [overKey, setOverKey] = useState<SubgroupKey | null>(null);
  // savedOrder = last order loaded from / saved to the server. Held in a
  // ref so we don't re-fetch when the parent re-renders.
  const savedOrderRef = useRef<SubgroupKey[] | null>(null);
  const loadedRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);

  // Load saved order once on mount. We tolerate failure silently: a 401
  // on this endpoint just means the prefs feature isn't reachable
  // (signed-out edge case), in which case we use the server's natural
  // order.
  useEffect(() => {
    let cancelled = false;
    authFetch("/api/me/ui-prefs/equity-subgroup-order")
      .then(async (r) => {
        if (cancelled) return;
        if (!r.ok) {
          loadedRef.current = true;
          return;
        }
        const body = (await r.json().catch(() => ({}))) as {
          order?: SubgroupKey[] | null;
        };
        savedOrderRef.current = body.order ?? null;
        loadedRef.current = true;
        // Re-apply the saved order to whatever snapshots prop we have.
        setOrdered((prev) => applySavedOrder(prev, body.order ?? null));
      })
      .catch(() => {
        loadedRef.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Whenever the parent gives us a fresh snapshots array (e.g. user
  // changed the grade filter), re-apply whatever saved order we have.
  useEffect(() => {
    setOrdered(applySavedOrder(snapshots, savedOrderRef.current));
  }, [snapshots]);

  // Persist the current order to the server, debounced. Updates the ref
  // optimistically so subsequent applySavedOrder calls (e.g. after a
  // grade-filter refetch) line up with what the user just chose.
  function scheduleSave(next: SubgroupSnapshot[]) {
    const order = next.map((s) => s.subgroup);
    savedOrderRef.current = order;
    if (saveTimerRef.current != null) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      authFetch("/api/me/ui-prefs/equity-subgroup-order", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ order }),
      }).catch(() => {
        // Network blip — savedOrderRef still holds the user's choice
        // for the rest of the session, so the UI feels persistent even
        // if the server didn't get the write. Next reorder will retry.
      });
    }, 400);
  }

  // Reorder handler: insert `from` immediately before `to` (or after,
  // if `from` was earlier in the list, so dragging right "pushes past").
  function reorder(from: SubgroupKey, to: SubgroupKey) {
    if (from === to) return;
    setOrdered((prev) => {
      const fromIdx = prev.findIndex((s) => s.subgroup === from);
      const toIdx = prev.findIndex((s) => s.subgroup === to);
      if (fromIdx < 0 || toIdx < 0) return prev;
      const next = prev.slice();
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      scheduleSave(next);
      return next;
    });
  }

  // Flush any pending save on unmount so a quick "drag then navigate"
  // doesn't lose the choice.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current != null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        const order = savedOrderRef.current;
        if (order) {
          // Fire-and-forget; can't await in a cleanup.
          authFetch("/api/me/ui-prefs/equity-subgroup-order", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ order }),
          }).catch(() => {});
        }
      }
    };
  }, []);

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
        gap: "0.75rem",
        marginTop: "1rem",
      }}
    >
      {ordered.map((s) => (
        <DraggableSnapshotCard
          key={s.subgroup}
          snapshot={s}
          isDragging={dragKey === s.subgroup}
          isDropTarget={overKey === s.subgroup && dragKey !== s.subgroup}
          onDragStart={() => setDragKey(s.subgroup)}
          onDragEnd={() => {
            setDragKey(null);
            setOverKey(null);
          }}
          onDragOver={() => {
            if (overKey !== s.subgroup) setOverKey(s.subgroup);
          }}
          onDrop={(from) => {
            reorder(from, s.subgroup);
            setDragKey(null);
            setOverKey(null);
          }}
        />
      ))}
    </div>
  );
}

function DraggableSnapshotCard({
  snapshot,
  isDragging,
  isDropTarget,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: {
  snapshot: SubgroupSnapshot;
  isDragging: boolean;
  isDropTarget: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver: () => void;
  onDrop: (from: SubgroupKey) => void;
}) {
  // We use the HTML5 drag-and-drop API. `application/x-equity-subgroup`
  // is a custom MIME type so we don't pick up text drags from elsewhere
  // on the page.
  const MIME = "application/x-equity-subgroup";
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(MIME, snapshot.subgroup);
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={(e) => {
        // Only intercept if this is one of our drags.
        if (!e.dataTransfer.types.includes(MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        onDragOver();
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes(MIME)) return;
        e.preventDefault();
        const from = e.dataTransfer.getData(MIME) as SubgroupKey;
        if (from) onDrop(from);
      }}
      style={{
        cursor: "grab",
        opacity: isDragging ? 0.4 : 1,
        outline: isDropTarget ? "2px dashed #6366f1" : "none",
        outlineOffset: 2,
        borderRadius: 8,
        transition: "opacity 120ms ease, outline-color 120ms ease",
      }}
      title="Drag to reorder"
    >
      <SnapshotCard snapshot={snapshot} />
    </div>
  );
}

function SnapshotCard({ snapshot }: { snapshot: SubgroupSnapshot }) {
  const empty = snapshot.inGroupSize === 0;
  return (
    <div style={panelStyle(SUBGROUP_COLORS[snapshot.subgroup].fg)}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: "0.5rem",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
          <SubgroupChip k={snapshot.subgroup} />
        </div>
        <div style={{ fontSize: 11, color: "#64748b" }}>
          n={snapshot.inGroupSize.toLocaleString()} vs{" "}
          {snapshot.outGroupSize.toLocaleString()}
        </div>
      </div>
      {empty ? (
        <p style={emptyRowStyle}>No students in this subgroup.</p>
      ) : (
        <table style={tableStyle}>
          <tbody>
            {snapshot.metrics.map((m) => {
              const t = tone(m.riskRatio, m.worseDirection);
              const ratioColor = toneColor(t);
              return (
                <tr key={m.key} style={{ borderTop: "1px solid #f8fafc" }}>
                  <td
                    style={{
                      padding: "0.35rem 0",
                      fontSize: 12,
                      color: "#475569",
                      width: "55%",
                    }}
                  >
                    {m.name}
                  </td>
                  <td
                    style={{
                      padding: "0.35rem 0.4rem",
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                      fontSize: 12,
                      color: "#475569",
                    }}
                  >
                    {fmtMetricValue(m.inGroupValue, m.key)}{" "}
                    <span style={{ color: "#94a3b8" }}>
                      vs {fmtMetricValue(m.outGroupValue, m.key)}
                    </span>
                  </td>
                  <td
                    style={{
                      padding: "0.35rem 0",
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                      fontSize: 13,
                      fontWeight: 600,
                      color: ratioColor,
                      width: 56,
                    }}
                  >
                    {m.riskRatio == null ? "—" : `${m.riskRatio.toFixed(2)}x`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function SubgroupChip({ k }: { k: SubgroupKey }) {
  const c = SUBGROUP_COLORS[k];
  return (
    <span
      style={{
        display: "inline-block",
        background: c.bg,
        color: c.fg,
        padding: "2px 8px",
        borderRadius: 4,
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: "0.02em",
      }}
    >
      {k}
    </span>
  );
}

// ---------- Formatting helpers ---------------------------------------------

// Format a metric value based on its key. Pct metrics (rates) render as
// percentages with one decimal; ratio metrics keep two decimals; averages
// keep three decimals (since avg neg PBIS in 30d is small).
function fmtMetricValue(v: number | null, key: string): string {
  if (v == null) return "—";
  if (key === "pctOnPlan" || key === "pctBq") return `${(v * 100).toFixed(1)}%`;
  if (key === "posNegRatio") return `${v.toFixed(2)}:1`;
  if (key === "avgNegPbis" || key === "avgEngagementEvents") {
    return v.toFixed(2);
  }
  return v.toFixed(2);
}

function pctFmt(p: number): string {
  if (!Number.isFinite(p) || p <= 0) return "0%";
  return `${(p * 100).toFixed(1)}%`;
}

function fmtInt(n: number): string {
  return n.toLocaleString();
}

// ---------- Reusable bits --------------------------------------------------

function Kpi({
  label,
  value,
  sub,
  accent,
  big,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
  big?: boolean;
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
      <div
        style={{
          fontSize: big ? 28 : 22,
          fontWeight: 700,
          color: big ? accent : "inherit",
          lineHeight: 1.1,
          fontVariantNumeric: "tabular-nums",
          letterSpacing: big ? "-0.02em" : undefined,
        }}
      >
        {value}
      </div>
      {sub && (
        <div
          style={{
            color: "var(--text-subtle, #64748b)",
            fontSize: 11,
            marginTop: "0.2rem",
          }}
        >
          {sub}
        </div>
      )}
    </div>
  );
}

// ---------- Style atoms ----------------------------------------------------

function panelStyle(accent?: string): React.CSSProperties {
  return {
    border: "1px solid var(--border, #e5e7eb)",
    borderTop: accent ? `3px solid ${accent}` : undefined,
    borderRadius: 8,
    padding: "0.85rem 1rem",
    background: "var(--card-bg, white)",
  };
}

const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 13,
};

const emptyRowStyle: React.CSSProperties = {
  color: "var(--text-subtle)",
  fontSize: 13,
  margin: 0,
};

const selectStyle: React.CSSProperties = {
  padding: "0.4rem 0.6rem",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  background: "white",
  font: "inherit",
  fontSize: 13,
};

const panelTitleStyle: React.CSSProperties = {
  fontSize: 12,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "var(--text-subtle, #64748b)",
  marginBottom: "0.5rem",
};
