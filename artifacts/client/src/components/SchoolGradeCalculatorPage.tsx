import { useCallback, useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/authToken";

// =============================================================================
// School Grade Estimated Calculator (Phase 1) — middle school.
//
// Admin tool that estimates a Florida school grade for a PM window. Six FAST
// components compute from the roster (with PM1/PM2 learning gains shown as
// projections); three manual components (Science / Civics / Acceleration) are
// hand-entered. A year-over-year history table mirrors the district
// spreadsheet, four insight panels (Celebrate / Weakness / Focus / Growth)
// summarize the latest run, and everything exports to CSV. Survey 2/3 uploads
// are accepted as placeholders for the Phase 2 matched-cohort calculation.
//
// Talks to /api/school-grade/* via authFetch (no OpenAPI codegen), matching
// the Tours / Class Composer precedent.
// =============================================================================

type PmWindow = "pm1" | "pm2" | "pm3";

interface ComponentDef {
  key: string;
  label: string;
  shortLabel: string;
  source: "fast" | "manual";
  subject?: "ela" | "math";
  metric?: "achievement" | "lg" | "lg_l25";
}

interface RunComponent {
  key: string;
  label: string;
  value: number | null;
  source: "fast" | "manual";
  status: "computed" | "manual" | "pending" | "projected";
  testedPct?: number | null;
  testedCount?: number | null;
  eligibleCount?: number | null;
  numerator?: number | null;
  denominator?: number | null;
  note?: string | null;
}

interface RunParticipation {
  ela?: { testedPct: number; tested: number; eligible: number };
  math?: { testedPct: number; tested: number; eligible: number };
}

interface RunRow {
  id: number;
  schoolYear: string;
  pmWindow: PmWindow;
  status: string;
  totalPoints: number;
  totalPossible: number;
  percent: number;
  letter: string;
  createdAt: string;
  detail: { components: RunComponent[]; participation?: RunParticipation };
}

interface HistoryTotals {
  totalPoints: number;
  totalPossible: number;
  percent: number;
  letter: string;
}

interface HistoryRow {
  id: number;
  yearLabel: string;
  displayOrder: number;
  elaAch: number | null;
  mathAch: number | null;
  sciAch: number | null;
  ssAch: number | null;
  elaLg: number | null;
  mathLg: number | null;
  elaLgL25: number | null;
  mathLgL25: number | null;
  accel: number | null;
  totalOverride: number | null;
  letterOverride: string | null;
  totals: HistoryTotals;
}

interface ManualInput {
  science: number | null;
  socialStudies: number | null;
  acceleration: number | null;
}

interface SurveyRow {
  id: number;
  survey: string;
  filename: string;
  byteSize: number;
  rowCount: number | null;
  status: string;
  uploadedAt: string;
}

interface OverviewResponse {
  schoolYear: string;
  schoolType: string;
  components: ComponentDef[];
  participationThreshold: number;
  history: HistoryRow[];
  manualInputs: Record<string, ManualInput | undefined>;
  surveys: SurveyRow[];
  latestRuns: Record<string, RunRow | undefined>;
}

const WINDOW_LABEL: Record<PmWindow, string> = {
  pm1: "PM1 (Fall)",
  pm2: "PM2 (Winter)",
  pm3: "PM3 (Spring)",
};

// PM3 end-of-year result uploads. These EOC / subject-area results only exist
// at PM3 (end of year), so the upload request appears only when PM3 is the
// selected window. Stored as placeholders for now (Phase 2 parses them).
const PM3_UPLOAD_KINDS: { kind: string; label: string }[] = [
  { kind: "pm3_civics", label: "Civics (Gr 7)" },
  { kind: "pm3_science", label: "Science (Gr 8)" },
  { kind: "pm3_algebra", label: "Algebra I (EOC)" },
  { kind: "pm3_geometry", label: "Geometry (EOC)" },
];

const HISTORY_COMPONENT_KEYS: { key: keyof HistoryRow; label: string }[] = [
  { key: "elaAch", label: "ELA Ach" },
  { key: "mathAch", label: "Math Ach" },
  { key: "sciAch", label: "Sci Ach" },
  { key: "ssAch", label: "Civics Ach" },
  { key: "elaLg", label: "ELA LG" },
  { key: "mathLg", label: "Math LG" },
  { key: "elaLgL25", label: "ELA LG L25%" },
  { key: "mathLgL25", label: "Math LG L25%" },
  { key: "accel", label: "Accel" },
];

const card: React.CSSProperties = {
  border: "1px solid var(--border, #2a3447)",
  borderRadius: 10,
  background: "var(--card-bg, rgba(255,255,255,0.03))",
  padding: "1rem 1.1rem",
};

const letterColor: Record<string, string> = {
  A: "#16a34a",
  B: "#65a30d",
  C: "#ca8a04",
  D: "#ea580c",
  F: "#dc2626",
};

function LetterBadge({ letter, big }: { letter: string; big?: boolean }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: big ? 56 : 30,
        height: big ? 56 : 30,
        borderRadius: big ? 12 : 8,
        background: letterColor[letter] ?? "#64748b",
        color: "#fff",
        fontWeight: 800,
        fontSize: big ? "2rem" : "1rem",
      }}
    >
      {letter}
    </span>
  );
}

function StatusChip({ status }: { status: RunComponent["status"] }) {
  const map: Record<RunComponent["status"], { label: string; bg: string }> = {
    computed: { label: "Computed", bg: "#16a34a" },
    manual: { label: "Manual", bg: "#2563eb" },
    projected: { label: "Projected", bg: "#ca8a04" },
    pending: { label: "Pending", bg: "#64748b" },
  };
  const m = map[status];
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        padding: "0.1rem 0.45rem",
        borderRadius: 999,
        background: m.bg,
        color: "#fff",
        whiteSpace: "nowrap",
      }}
    >
      {m.label}
    </span>
  );
}

export function SchoolGradeCalculatorPage() {
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [window_, setWindow] = useState<PmWindow>("pm1");
  const [calculating, setCalculating] = useState(false);

  // Manual input form state (per window).
  const [manualForm, setManualForm] = useState<{
    science: string;
    socialStudies: string;
    acceleration: string;
  }>({ science: "", socialStudies: "", acceleration: "" });
  const [savingManual, setSavingManual] = useState(false);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch("/api/school-grade/overview");
      if (!res.ok) throw new Error(`Failed to load (${res.status})`);
      const json = (await res.json()) as OverviewResponse;
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  // Sync the manual form when the window or data changes.
  useEffect(() => {
    const mi = data?.manualInputs?.[window_];
    setManualForm({
      science: mi?.science != null ? String(mi.science) : "",
      socialStudies: mi?.socialStudies != null ? String(mi.socialStudies) : "",
      acceleration: mi?.acceleration != null ? String(mi.acceleration) : "",
    });
  }, [window_, data]);

  const currentRun = data?.latestRuns?.[window_] ?? null;

  const handleCalculate = async () => {
    setCalculating(true);
    setError(null);
    try {
      const res = await authFetch("/api/school-grade/calculate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ window: window_ }),
      });
      if (!res.ok) throw new Error(`Calculate failed (${res.status})`);
      await loadOverview();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Calculate failed");
    } finally {
      setCalculating(false);
    }
  };

  const handleSaveManual = async () => {
    setSavingManual(true);
    setError(null);
    try {
      const res = await authFetch("/api/school-grade/manual-inputs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          window: window_,
          science: manualForm.science === "" ? null : Number(manualForm.science),
          socialStudies:
            manualForm.socialStudies === ""
              ? null
              : Number(manualForm.socialStudies),
          acceleration:
            manualForm.acceleration === ""
              ? null
              : Number(manualForm.acceleration),
        }),
      });
      if (!res.ok) throw new Error(`Save failed (${res.status})`);
      await loadOverview();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSavingManual(false);
    }
  };

  const handleSurveyUpload = async (
    survey: string,
    file: File,
  ) => {
    setError(null);
    try {
      const text = await file.text();
      const res = await authFetch("/api/school-grade/surveys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          survey,
          filename: file.name,
          byteSize: file.size,
          rawCsv: text,
        }),
      });
      if (!res.ok) throw new Error(`Upload failed (${res.status})`);
      await loadOverview();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    }
  };

  // Insight panels derived from the current run's components.
  const panels = useMemo(() => {
    if (!currentRun) return null;
    const comps = currentRun.detail.components.filter((c) => c.value != null);
    const sorted = [...comps].sort(
      (a, b) => (b.value ?? 0) - (a.value ?? 0),
    );
    const celebrate = sorted.slice(0, 3);
    const weakness = [...sorted].reverse().slice(0, 3);
    // Focus: components below 50 points (priority lift targets).
    const focus = comps.filter((c) => (c.value ?? 0) < 50);
    // Growth: learning-gain components (where movement is the lever).
    const growth = comps.filter((c) => c.key.includes("lg"));
    return { celebrate, weakness, focus, growth };
  }, [currentRun]);

  const exportCsv = () => {
    if (!data) return;
    const rows: string[][] = [];
    rows.push(["School Grade Estimate", data.schoolYear, WINDOW_LABEL[window_]]);
    rows.push([]);
    rows.push(["Component", "Value", "Source", "Status", "% Tested"]);
    if (currentRun) {
      for (const c of currentRun.detail.components) {
        rows.push([
          c.label,
          c.value != null ? String(c.value) : "—",
          c.source,
          c.status,
          c.testedPct != null ? `${c.testedPct}%` : "",
        ]);
      }
      rows.push([]);
      rows.push([
        "Total",
        `${currentRun.totalPoints} / ${currentRun.totalPossible}`,
        "",
        `${currentRun.percent}%`,
        currentRun.letter,
      ]);
    }
    rows.push([]);
    rows.push(["Year-over-year history"]);
    rows.push([
      "Year",
      ...HISTORY_COMPONENT_KEYS.map((h) => h.label),
      "Total",
      "%",
      "Letter",
    ]);
    for (const h of data.history) {
      rows.push([
        h.yearLabel,
        ...HISTORY_COMPONENT_KEYS.map((hc) => {
          const v = h[hc.key];
          return v == null ? "" : String(v);
        }),
        String(h.totals.totalPoints),
        `${h.totals.percent}%`,
        h.totals.letter,
      ]);
    }
    const csv = rows
      .map((r) =>
        r
          .map((cell) => {
            const s = String(cell ?? "");
            return s.includes(",") || s.includes('"')
              ? `"${s.replace(/"/g, '""')}"`
              : s;
          })
          .join(","),
      )
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `school-grade-${data.schoolYear}-${window_}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return <div style={{ padding: "1.5rem" }}>Loading school grade…</div>;
  }
  if (!data) {
    return (
      <div style={{ padding: "1.5rem" }}>
        <p style={{ color: "#dc2626" }}>{error ?? "Failed to load."}</p>
        <button onClick={() => void loadOverview()}>Retry</button>
      </div>
    );
  }

  const threshold = data.participationThreshold;
  const participation = currentRun?.detail.participation;
  const lowEla =
    participation?.ela != null && participation.ela.testedPct < threshold;
  const lowMath =
    participation?.math != null && participation.math.testedPct < threshold;

  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: "1.1rem", padding: "0.25rem" }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "1rem",
          flexWrap: "wrap",
        }}
      >
        <div>
          <h2 style={{ margin: 0 }}>School Grade Estimated Calculator</h2>
          <div style={{ fontSize: 13, color: "var(--text-subtle)" }}>
            Middle School · {data.schoolYear} · estimate only — not the official
            FLDOE grade
          </div>
        </div>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <select
            value={window_}
            onChange={(e) => setWindow(e.target.value as PmWindow)}
            style={{ padding: "0.4rem 0.6rem", borderRadius: 8 }}
          >
            <option value="pm1">{WINDOW_LABEL.pm1}</option>
            <option value="pm2">{WINDOW_LABEL.pm2}</option>
            <option value="pm3">{WINDOW_LABEL.pm3}</option>
          </select>
          <button
            type="button"
            onClick={() => void handleCalculate()}
            disabled={calculating}
            style={{
              padding: "0.45rem 0.9rem",
              borderRadius: 8,
              background: "var(--accent, #3b82f6)",
              color: "#fff",
              fontWeight: 600,
              border: "none",
              cursor: "pointer",
            }}
          >
            {calculating ? "Calculating…" : "Calculate"}
          </button>
          <button
            type="button"
            onClick={exportCsv}
            style={{ padding: "0.45rem 0.9rem", borderRadius: 8 }}
          >
            Export CSV
          </button>
        </div>
      </div>

      {error && (
        <div style={{ ...card, borderColor: "#dc2626", color: "#dc2626" }}>
          {error}
        </div>
      )}

      {/* Headline grade */}
      <div
        style={{
          ...card,
          display: "flex",
          alignItems: "center",
          gap: "1.25rem",
          flexWrap: "wrap",
        }}
      >
        {currentRun ? (
          <>
            <LetterBadge letter={currentRun.letter} big />
            <div>
              <div style={{ fontSize: "1.6rem", fontWeight: 800 }}>
                {currentRun.percent}%
              </div>
              <div style={{ color: "var(--text-subtle)", fontSize: 13 }}>
                {currentRun.totalPoints} of {currentRun.totalPossible} possible
                points · {WINDOW_LABEL[window_]}
              </div>
            </div>
            <div
              style={{
                marginLeft: "auto",
                display: "flex",
                gap: "0.75rem",
                flexWrap: "wrap",
              }}
            >
              <ParticipationStat
                label="ELA tested"
                pct={participation?.ela?.testedPct}
                low={lowEla}
              />
              <ParticipationStat
                label="Math tested"
                pct={participation?.math?.testedPct}
                low={lowMath}
              />
            </div>
          </>
        ) : (
          <div style={{ color: "var(--text-subtle)" }}>
            No estimate yet for {WINDOW_LABEL[window_]}. Click{" "}
            <strong>Calculate</strong> to generate one from current FAST data.
          </div>
        )}
      </div>

      {(lowEla || lowMath) && (
        <div
          style={{
            ...card,
            borderColor: "#ca8a04",
            background: "rgba(202,138,4,0.08)",
          }}
        >
          ⚠️ Participation below {threshold}% in{" "}
          {[lowEla ? "ELA" : null, lowMath ? "Math" : null]
            .filter(Boolean)
            .join(" and ")}
          . FLDOE penalizes schools under 95% tested — this estimate may
          understate the true risk.
        </div>
      )}

      {/* Component breakdown */}
      {currentRun && (
        <div style={card}>
          <h3 style={{ marginTop: 0 }}>Component breakdown</h3>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left", fontSize: 13 }}>
                  <th style={{ padding: "0.4rem 0.5rem" }}>Component</th>
                  <th style={{ padding: "0.4rem 0.5rem" }}>Points</th>
                  <th style={{ padding: "0.4rem 0.5rem" }}>Status</th>
                  <th style={{ padding: "0.4rem 0.5rem" }}>Detail</th>
                </tr>
              </thead>
              <tbody>
                {currentRun.detail.components.map((c) => (
                  <tr
                    key={c.key}
                    style={{ borderTop: "1px solid var(--border, #2a3447)" }}
                  >
                    <td style={{ padding: "0.4rem 0.5rem" }}>{c.label}</td>
                    <td
                      style={{
                        padding: "0.4rem 0.5rem",
                        fontWeight: 700,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {c.value != null ? c.value : "—"}
                    </td>
                    <td style={{ padding: "0.4rem 0.5rem" }}>
                      <StatusChip status={c.status} />
                    </td>
                    <td
                      style={{
                        padding: "0.4rem 0.5rem",
                        fontSize: 12,
                        color: "var(--text-subtle)",
                      }}
                    >
                      {c.numerator != null && c.denominator != null
                        ? `${c.numerator}/${c.denominator}`
                        : ""}
                      {c.note ? ` · ${c.note}` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Insight panels */}
      {panels && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: "0.9rem",
          }}
        >
          <InsightPanel
            title="🎉 Celebrate"
            hint="Strongest components"
            items={panels.celebrate.map((c) => `${c.label} — ${c.value}`)}
          />
          <InsightPanel
            title="⚠️ Weakness"
            hint="Lowest components"
            items={panels.weakness.map((c) => `${c.label} — ${c.value}`)}
          />
          <InsightPanel
            title="🎯 Focus"
            hint="Below 50 points"
            items={
              panels.focus.length
                ? panels.focus.map((c) => `${c.label} — ${c.value}`)
                : ["All components at or above 50."]
            }
          />
          <InsightPanel
            title="📈 Growth"
            hint="Learning-gain levers"
            items={panels.growth.map((c) => `${c.label} — ${c.value}`)}
          />
        </div>
      )}

      {/* Manual inputs */}
      <div style={card}>
        <h3 style={{ marginTop: 0 }}>
          Manual components — {WINDOW_LABEL[window_]}
        </h3>
        <p style={{ fontSize: 13, color: "var(--text-subtle)", marginTop: 0 }}>
          Science (Gr 8), Civics / Social Studies (Gr 7), and Acceleration are
          not in FAST. Enter the estimated 0–100 component score; leave blank to
          mark pending. (At PM3, upload the actual result files below.)
        </p>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
            gap: "0.75rem",
            alignItems: "end",
          }}
        >
          <ManualField
            label="Science (Gr 8)"
            value={manualForm.science}
            onChange={(v) => setManualForm((f) => ({ ...f, science: v }))}
          />
          <ManualField
            label="Civics / SS (Gr 7)"
            value={manualForm.socialStudies}
            onChange={(v) => setManualForm((f) => ({ ...f, socialStudies: v }))}
          />
          <ManualField
            label="Acceleration"
            value={manualForm.acceleration}
            onChange={(v) => setManualForm((f) => ({ ...f, acceleration: v }))}
          />
          <button
            type="button"
            onClick={() => void handleSaveManual()}
            disabled={savingManual}
            style={{
              padding: "0.5rem 0.9rem",
              borderRadius: 8,
              background: "var(--accent, #3b82f6)",
              color: "#fff",
              fontWeight: 600,
              border: "none",
              cursor: "pointer",
            }}
          >
            {savingManual ? "Saving…" : "Save manual inputs"}
          </button>
        </div>
      </div>

      {/* PM3 result uploads — only when PM3 is the selected window */}
      {window_ === "pm3" && (
        <div style={{ ...card, borderColor: "var(--accent, #3b82f6)" }}>
          <h3 style={{ marginTop: 0 }}>PM3 result uploads</h3>
          <p
            style={{ fontSize: 13, color: "var(--text-subtle)", marginTop: 0 }}
          >
            PM3 is the end-of-year window. Upload the Civics, Science, Algebra I,
            and Geometry result files so they are on record with this estimate.
            Files are stored now and parsed into the official PM3 calculation in
            Phase 2.
          </p>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
              gap: "1rem",
            }}
          >
            {PM3_UPLOAD_KINDS.map(({ kind, label }) => {
              const existing = data.surveys.find((x) => x.survey === kind);
              return (
                <div key={kind}>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>{label}</div>
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void handleSurveyUpload(kind, f);
                    }}
                  />
                  {existing ? (
                    <div
                      style={{
                        fontSize: 12,
                        color: "#16a34a",
                        marginTop: 4,
                      }}
                    >
                      ✓ {existing.filename} · {existing.status}
                    </div>
                  ) : (
                    <div
                      style={{
                        fontSize: 12,
                        color: "var(--text-subtle)",
                        marginTop: 4,
                      }}
                    >
                      No file uploaded yet
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Year-over-year history */}
      <HistorySection data={data} onChange={() => void loadOverview()} />

      {/* Survey upload placeholders */}
      <div style={card}>
        <h3 style={{ marginTop: 0 }}>Enrollment survey files (Phase 2)</h3>
        <p style={{ fontSize: 13, color: "var(--text-subtle)", marginTop: 0 }}>
          Upload Survey 2 / Survey 3 enrollment files now to keep them on
          record. They are stored but not yet applied — Phase 2 will parse them
          into a matched-cohort filter so PM3 mirrors the official calculation.
        </p>
        <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap" }}>
          {(["survey2", "survey3"] as const).map((s) => {
            const existing = data.surveys.find((x) => x.survey === s);
            return (
              <div key={s}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>
                  {s === "survey2" ? "Survey 2" : "Survey 3"}
                </div>
                <input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void handleSurveyUpload(s, f);
                  }}
                />
                {existing && (
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--text-subtle)",
                      marginTop: 4,
                    }}
                  >
                    {existing.filename} · {existing.status}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ParticipationStat({
  label,
  pct,
  low,
}: {
  label: string;
  pct: number | undefined;
  low: boolean;
}) {
  return (
    <div style={{ textAlign: "right" }}>
      <div style={{ fontSize: 12, color: "var(--text-subtle)" }}>{label}</div>
      <div
        style={{
          fontWeight: 700,
          color: low ? "#ca8a04" : "inherit",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {pct != null ? `${pct}%` : "—"}
      </div>
    </div>
  );
}

function InsightPanel({
  title,
  hint,
  items,
}: {
  title: string;
  hint: string;
  items: string[];
}) {
  return (
    <div style={card}>
      <div style={{ fontWeight: 700 }}>{title}</div>
      <div
        style={{ fontSize: 12, color: "var(--text-subtle)", marginBottom: 6 }}
      >
        {hint}
      </div>
      <ul style={{ margin: 0, paddingLeft: "1.1rem", fontSize: 13 }}>
        {items.length ? (
          items.map((it, i) => <li key={i}>{it}</li>)
        ) : (
          <li style={{ color: "var(--text-subtle)" }}>No data yet.</li>
        )}
      </ul>
    </div>
  );
}

function ManualField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 12, color: "var(--text-subtle)" }}>{label}</span>
      <input
        type="number"
        min={0}
        max={100}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="0–100"
        style={{ padding: "0.45rem 0.6rem", borderRadius: 8 }}
      />
    </label>
  );
}

const EMPTY_HISTORY_FORM = {
  yearLabel: "",
  elaAch: "",
  mathAch: "",
  sciAch: "",
  ssAch: "",
  elaLg: "",
  mathLg: "",
  elaLgL25: "",
  mathLgL25: "",
  accel: "",
};

function HistorySection({
  data,
  onChange,
}: {
  data: OverviewResponse;
  onChange: () => void;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState<Record<string, string>>(EMPTY_HISTORY_FORM);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!form.yearLabel.trim()) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = { yearLabel: form.yearLabel };
      for (const { key } of HISTORY_COMPONENT_KEYS) {
        const v = form[key as string];
        body[key as string] = v === "" || v == null ? null : Number(v);
      }
      const res = await authFetch("/api/school-grade/history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setForm(EMPTY_HISTORY_FORM);
        setShowAdd(false);
        onChange();
      }
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: number) => {
    const res = await authFetch(`/api/school-grade/history/${id}`, {
      method: "DELETE",
    });
    if (res.ok) onChange();
  };

  return (
    <div style={card}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "1rem",
        }}
      >
        <h3 style={{ margin: 0 }}>Year-over-year history</h3>
        <button
          type="button"
          onClick={() => setShowAdd((s) => !s)}
          style={{ padding: "0.4rem 0.8rem", borderRadius: 8 }}
        >
          {showAdd ? "Cancel" : "+ Add year"}
        </button>
      </div>

      {showAdd && (
        <div
          style={{
            marginTop: "0.75rem",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
            gap: "0.6rem",
            alignItems: "end",
          }}
        >
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 12, color: "var(--text-subtle)" }}>
              Year label
            </span>
            <input
              value={form.yearLabel}
              onChange={(e) =>
                setForm((f) => ({ ...f, yearLabel: e.target.value }))
              }
              placeholder="e.g. FAST 24-25"
              style={{ padding: "0.4rem 0.6rem", borderRadius: 8 }}
            />
          </label>
          {HISTORY_COMPONENT_KEYS.map(({ key, label }) => (
            <label
              key={key as string}
              style={{ display: "flex", flexDirection: "column", gap: 4 }}
            >
              <span style={{ fontSize: 12, color: "var(--text-subtle)" }}>
                {label}
              </span>
              <input
                type="number"
                min={0}
                max={100}
                value={form[key as string] ?? ""}
                onChange={(e) =>
                  setForm((f) => ({ ...f, [key as string]: e.target.value }))
                }
                style={{ padding: "0.4rem 0.6rem", borderRadius: 8 }}
              />
            </label>
          ))}
          <button
            type="button"
            onClick={() => void submit()}
            disabled={saving || !form.yearLabel.trim()}
            style={{
              padding: "0.5rem 0.9rem",
              borderRadius: 8,
              background: "var(--accent, #3b82f6)",
              color: "#fff",
              fontWeight: 600,
              border: "none",
              cursor: "pointer",
            }}
          >
            {saving ? "Saving…" : "Add"}
          </button>
        </div>
      )}

      <div style={{ overflowX: "auto", marginTop: "0.75rem" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", fontSize: 12 }}>
              <th style={{ padding: "0.35rem 0.5rem" }}>Year</th>
              {HISTORY_COMPONENT_KEYS.map((h) => (
                <th key={h.key as string} style={{ padding: "0.35rem 0.5rem" }}>
                  {h.label}
                </th>
              ))}
              <th style={{ padding: "0.35rem 0.5rem" }}>Total</th>
              <th style={{ padding: "0.35rem 0.5rem" }}>%</th>
              <th style={{ padding: "0.35rem 0.5rem" }}>Grade</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.history.length === 0 && (
              <tr>
                <td
                  colSpan={HISTORY_COMPONENT_KEYS.length + 5}
                  style={{
                    padding: "0.6rem 0.5rem",
                    color: "var(--text-subtle)",
                  }}
                >
                  No prior years entered yet.
                </td>
              </tr>
            )}
            {data.history.map((h) => (
              <tr
                key={h.id}
                style={{ borderTop: "1px solid var(--border, #2a3447)" }}
              >
                <td style={{ padding: "0.35rem 0.5rem", fontWeight: 600 }}>
                  {h.yearLabel}
                </td>
                {HISTORY_COMPONENT_KEYS.map((hc) => (
                  <td
                    key={hc.key as string}
                    style={{
                      padding: "0.35rem 0.5rem",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {h[hc.key] == null ? "—" : String(h[hc.key])}
                  </td>
                ))}
                <td
                  style={{
                    padding: "0.35rem 0.5rem",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {h.totals.totalPoints}
                </td>
                <td
                  style={{
                    padding: "0.35rem 0.5rem",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {h.totals.percent}%
                </td>
                <td style={{ padding: "0.35rem 0.5rem" }}>
                  <LetterBadge letter={h.totals.letter} />
                </td>
                <td style={{ padding: "0.35rem 0.5rem" }}>
                  <button
                    type="button"
                    onClick={() => void remove(h.id)}
                    style={{
                      padding: "0.2rem 0.5rem",
                      borderRadius: 6,
                      fontSize: 12,
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default SchoolGradeCalculatorPage;
