import { useEffect, useState } from "react";
import { authFetch } from "../lib/authToken";

type Alert = {
  key: string;
  severity: "warn" | "alert";
  headline: string;
  detail: string;
  sample?: string[];
};

type ApiResponse = {
  thresholds: {
    quietTeacherDays: number;
    invisibleStudentDaysByTier: { tier1: number; tier2: number; tier3: number };
    reasonImbalancePct: number;
    coldPeriodMultiple: number;
  };
  quietTeachers: { count: number; total: number; sampleNames: string[] };
  invisibleStudents: { count: number; total: number; sampleNames: string[] };
  reasonImbalance: {
    topReason: string;
    percent: number;
    weekTotal: number;
  } | null;
  topHeavyRecognition: {
    studentCount: number;
    percentOfPoints: number;
    sample: string[];
  } | null;
  coldPeriods: Array<{
    period: number;
    name: string;
    weekTotal: number;
    schoolAverage: number;
  }>;
};

function buildAlerts(d: ApiResponse): Alert[] {
  const out: Alert[] = [];

  if (d.quietTeachers.count > 0) {
    const more = Math.max(0, d.quietTeachers.count - d.quietTeachers.sampleNames.length);
    out.push({
      key: "quiet-teachers",
      severity: d.quietTeachers.count >= 5 ? "alert" : "warn",
      headline: `${d.quietTeachers.count} of ${d.quietTeachers.total} staff haven't awarded points in ${d.thresholds.quietTeacherDays}+ school days`,
      detail: "Consider a friendly reminder or coaching nudge.",
      sample:
        d.quietTeachers.sampleNames.length > 0
          ? [
              d.quietTeachers.sampleNames.join(", ") +
                (more > 0 ? ` +${more} more` : ""),
            ]
          : undefined,
    });
  }

  if (d.invisibleStudents.count > 0) {
    const more = Math.max(
      0,
      d.invisibleStudents.count - d.invisibleStudents.sampleNames.length,
    );
    out.push({
      key: "invisible-students",
      severity: "alert",
      headline: `${d.invisibleStudents.count} of ${d.invisibleStudents.total} students have 0 points in their tier window (${d.thresholds.invisibleStudentDaysByTier.tier1}/${d.thresholds.invisibleStudentDaysByTier.tier2}/${d.thresholds.invisibleStudentDaysByTier.tier3} school days for Tier 1/2/3)`,
      detail:
        "These students may be flying under the radar for recognition. Students with an active MTSS plan surface faster (Tier 2/3 use a tighter window).",
      sample:
        d.invisibleStudents.sampleNames.length > 0
          ? [
              d.invisibleStudents.sampleNames.join(", ") +
                (more > 0 ? ` +${more} more` : ""),
            ]
          : undefined,
    });
  }

  if (d.reasonImbalance) {
    out.push({
      key: "reason-imbalance",
      severity: "warn",
      headline: `${d.reasonImbalance.percent}% of this week's points were for "${d.reasonImbalance.topReason}"`,
      detail: `Above the ${d.thresholds.reasonImbalancePct}% threshold — recognition may be skewing to a single behavior.`,
    });
  }

  if (d.topHeavyRecognition) {
    out.push({
      key: "top-heavy",
      severity: "warn",
      headline: `${d.topHeavyRecognition.studentCount} students received ${d.topHeavyRecognition.percentOfPoints}% of all points this month`,
      detail: "A small group is absorbing most recognition.",
      sample:
        d.topHeavyRecognition.sample.length > 0
          ? [d.topHeavyRecognition.sample.join(", ")]
          : undefined,
    });
  }

  if (d.coldPeriods.length > 0) {
    out.push({
      key: "cold-periods",
      severity: "warn",
      headline: `${d.coldPeriods.length} period${d.coldPeriods.length === 1 ? "" : "s"} running ${d.thresholds.coldPeriodMultiple}× below the weekly average`,
      detail: d.coldPeriods
        .map((p) => `Period ${p.period} (${p.weekTotal} pts vs ${p.schoolAverage} avg)`)
        .join(" · "),
    });
  }

  return out;
}

const palette = {
  alert: { border: "#dc2626", dot: "#dc2626", bg: "#fef2f2" },
  warn: { border: "#d97706", dot: "#d97706", bg: "#fffbeb" },
} as const;

export default function PbisNeedsAttention() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError("");
      try {
        const res = await authFetch("/api/pbis/needs-attention");
        const j = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (!cancelled) {
            setError(
              (j && j.error) ||
                `Couldn't load alerts (HTTP ${res.status}).`,
            );
            setData(null);
          }
          return;
        }
        if (!cancelled) setData(j as ApiResponse);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setData(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const alerts = data ? buildAlerts(data) : [];

  return (
    <div className="card no-print">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: alerts.length > 0 || loading || error ? "0.5rem" : 0,
        }}
      >
        <h3 style={{ margin: 0, fontSize: "1rem" }}>Needs Attention</h3>
        {data && (
          <span style={{ fontSize: "0.75rem", color: "#64748b" }}>
            Tunable in Settings → PBIS Thresholds
          </span>
        )}
      </div>

      {loading && (
        <div style={{ color: "#64748b", fontSize: "0.9rem" }}>
          Checking for alerts…
        </div>
      )}
      {!loading && error && (
        <div style={{ color: "#b91c1c", fontSize: "0.9rem" }}>{error}</div>
      )}
      {!loading && !error && data && alerts.length === 0 && (
        <div style={{ color: "#15803d", fontSize: "0.9rem" }}>
          All clear this week. Nothing flagged.
        </div>
      )}
      {!loading && !error && alerts.length > 0 && (
        <div style={{ display: "grid", gap: "0.5rem" }}>
          {alerts.map((a) => {
            const p = palette[a.severity];
            return (
              <div
                key={a.key}
                style={{
                  background: p.bg,
                  borderLeft: `4px solid ${p.border}`,
                  borderRadius: 6,
                  padding: "0.6rem 0.85rem",
                  display: "flex",
                  gap: "0.6rem",
                  alignItems: "flex-start",
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: p.dot,
                    flexShrink: 0,
                    marginTop: 7,
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontWeight: 600,
                      color: "#0f172a",
                      fontSize: "0.92rem",
                    }}
                  >
                    {a.headline}
                  </div>
                  <div style={{ fontSize: "0.82rem", color: "#475569" }}>
                    {a.detail}
                  </div>
                  {a.sample &&
                    a.sample.map((s, i) => (
                      <div
                        key={i}
                        style={{
                          fontSize: "0.8rem",
                          color: "#334155",
                          marginTop: 2,
                          fontStyle: "italic",
                        }}
                      >
                        {s}
                      </div>
                    ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
