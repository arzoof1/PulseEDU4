// Intervention Reports — Core Team only. Two-pane: roster (left) with
// tier badges, sub-type, and per-plan completion pill; detail drawer
// (right) showing per-teacher completion grid and recent activity.
//
// Data sources:
//   GET /api/interventions/completion-report?weekStartDate=YYYY-MM-DD
//   GET /api/tier3-records?studentId=...&weekStartDate=...&teacherStaffId=
//   GET /api/tier2-entries?studentId=...
import { useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/authToken";

interface TeacherStat {
  teacherStaffId: number;
  teacherName: string;
  completed: number;
  expected: number;
  scoreAvg: number | null;
}
interface ReportRow {
  planId: number;
  studentId: string;
  studentName: string;
  grade: string | null;
  tier: number;
  subType: string | null;
  title: string | null;
  assignedTeacherCount: number;
  teachers: TeacherStat[];
}
interface ReportPayload {
  weekStartDate: string;
  schoolDayDates: string[];
  rows: ReportRow[];
}

interface Tier3Rec {
  id: number;
  teacherStaffId: number;
  monScore: number | null;
  tueScore: number | null;
  wedScore: number | null;
  thuScore: number | null;
  friScore: number | null;
  weeklyComment: string | null;
  prideMon: number | null;
  prideTue: number | null;
  prideWed: number | null;
  prideThu: number | null;
  prideFri: number | null;
  strategyUsage?: Array<{ strategyId: number; day: string; used: boolean }>;
}

interface Tier2Entry {
  id: number;
  entryDate: string;
  subType: string;
  teacherStaffId: number;
  notes: string | null;
}

function mondayOf(d: Date): string {
  const x = new Date(d);
  const dow = x.getDay();
  const shift = dow === 0 ? -6 : 1 - dow;
  x.setDate(x.getDate() + shift);
  return new Date(x.getTime() - x.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 10);
}

interface Props {
  onBack: () => void;
}

export default function InterventionReportsPage({ onBack }: Props) {
  const [week, setWeek] = useState<string>(mondayOf(new Date()));
  const [data, setData] = useState<ReportPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [tierFilter, setTierFilter] = useState<"all" | "2" | "3">("all");
  const [completionFilter, setCompletionFilter] = useState<
    "all" | "behind" | "complete"
  >("all");
  const [search, setSearch] = useState("");

  const [selected, setSelected] = useState<ReportRow | null>(null);
  const [detailT3, setDetailT3] = useState<Tier3Rec[]>([]);
  const [detailT2, setDetailT2] = useState<Tier2Entry[]>([]);

  const load = async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await authFetch(
        `/api/interventions/completion-report?weekStartDate=${week}`,
      );
      if (!r.ok) throw new Error(await r.text());
      setData((await r.json()) as ReportPayload);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    setSelected(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [week]);

  // When a student is selected, load detail rows.
  useEffect(() => {
    if (!selected) {
      setDetailT3([]);
      setDetailT2([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        if (selected.tier === 3) {
          const r = await authFetch(
            `/api/tier3-records?studentId=${encodeURIComponent(selected.studentId)}&weekStartDate=${week}&teacherStaffId=`,
          );
          if (r.ok && !cancelled) setDetailT3(await r.json());
        } else {
          const r = await authFetch(
            `/api/tier2-entries?studentId=${encodeURIComponent(selected.studentId)}`,
          );
          if (r.ok && !cancelled) {
            const all = (await r.json()) as Tier2Entry[];
            const start = data?.schoolDayDates[0];
            const end = data?.schoolDayDates[4];
            setDetailT2(
              all.filter(
                (e) =>
                  start && end && e.entryDate >= start && e.entryDate <= end,
              ),
            );
          }
        }
      } catch {
        /* non-fatal */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected, week, data]);

  // Weekly overall summary across ALL active plans in the selected week.
  // Two headline numbers:
  //   • Tier 2 completion % — sum of completed entries / sum of expected.
  //   • Tier 3 average score — mean of every non-null per-teacher
  //     scoreAvg, weighted by completed entries so a teacher who logged
  //     5 days counts more than one who logged 1.
  // We also surface counts so the tiles aren't just floating percentages.
  const summary = useMemo(() => {
    if (!data) {
      return {
        t2Completed: 0,
        t2Expected: 0,
        t2Pct: null as number | null,
        t2Plans: 0,
        t3ScoreSum: 0,
        t3ScoreWeight: 0,
        t3Avg: null as number | null,
        t3Plans: 0,
        totalPlans: 0,
      };
    }
    let t2Completed = 0;
    let t2Expected = 0;
    let t2Plans = 0;
    let t3ScoreSum = 0;
    let t3ScoreWeight = 0;
    let t3Plans = 0;
    for (const r of data.rows) {
      if (r.tier === 2) {
        t2Plans += 1;
        for (const t of r.teachers) {
          t2Completed += t.completed;
          t2Expected += t.expected;
        }
      } else if (r.tier === 3) {
        t3Plans += 1;
        for (const t of r.teachers) {
          if (t.scoreAvg !== null && t.completed > 0) {
            t3ScoreSum += t.scoreAvg * t.completed;
            t3ScoreWeight += t.completed;
          }
        }
      }
    }
    return {
      t2Completed,
      t2Expected,
      t2Pct: t2Expected > 0 ? (t2Completed / t2Expected) * 100 : null,
      t2Plans,
      t3ScoreSum,
      t3ScoreWeight,
      t3Avg: t3ScoreWeight > 0 ? t3ScoreSum / t3ScoreWeight : null,
      t3Plans,
      totalPlans: data.rows.length,
    };
  }, [data]);

  const visibleRows = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.rows.filter((r) => {
      if (tierFilter !== "all" && String(r.tier) !== tierFilter) return false;
      const totalCompleted = r.teachers.reduce(
        (a, t) => a + t.completed,
        0,
      );
      const totalExpected = r.teachers.reduce((a, t) => a + t.expected, 0);
      if (completionFilter === "complete" && totalCompleted < totalExpected)
        return false;
      if (
        completionFilter === "behind" &&
        (totalExpected === 0 || totalCompleted >= totalExpected)
      )
        return false;
      if (q && !r.studentName.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [data, tierFilter, completionFilter, search]);

  function pill(c: number, e: number): React.ReactNode {
    const pct = e === 0 ? 0 : Math.round((c / e) * 100);
    const bg = pct >= 100 ? "#dcfce7" : pct >= 60 ? "#fef9c3" : "#fee2e2";
    const fg = pct >= 100 ? "#166534" : pct >= 60 ? "#854d0e" : "#991b1b";
    return (
      <span
        style={{
          background: bg,
          color: fg,
          borderRadius: 999,
          padding: "1px 8px",
          fontSize: "0.75rem",
          fontWeight: 600,
        }}
      >
        {c}/{e}
      </span>
    );
  }

  function tierBadge(t: number): React.ReactNode {
    const bg = t === 3 ? "#fce7f3" : "#dbeafe";
    const fg = t === 3 ? "#9d174d" : "#1e40af";
    return (
      <span
        style={{
          background: bg,
          color: fg,
          borderRadius: 4,
          padding: "1px 6px",
          fontSize: "0.7rem",
          fontWeight: 700,
          marginRight: 4,
        }}
      >
        T{t}
      </span>
    );
  }

  return (
    <section style={{ padding: "1rem" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "0.75rem",
        }}
      >
        <h2 style={{ margin: 0 }}>Intervention Reports</h2>
        <button type="button" onClick={onBack}>
          ← Back
        </button>
      </div>

      <div
        style={{
          display: "flex",
          gap: "0.5rem",
          marginBottom: "0.75rem",
          flexWrap: "wrap",
        }}
      >
        <label>
          Week of{" "}
          <input
            type="date"
            value={week}
            onChange={(e) => {
              if (!e.target.value) return;
              setWeek(mondayOf(new Date(e.target.value + "T00:00:00")));
            }}
            style={{
              padding: "0.3rem",
              border: "1px solid #cbd5e1",
              borderRadius: 4,
            }}
          />
        </label>
        <select
          value={tierFilter}
          onChange={(e) =>
            setTierFilter(e.target.value as "all" | "2" | "3")
          }
        >
          <option value="all">All tiers</option>
          <option value="2">Tier 2 only</option>
          <option value="3">Tier 3 only</option>
        </select>
        <select
          value={completionFilter}
          onChange={(e) =>
            setCompletionFilter(
              e.target.value as "all" | "behind" | "complete",
            )
          }
        >
          <option value="all">Any completion</option>
          <option value="complete">Complete only</option>
          <option value="behind">Behind schedule</option>
        </select>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search student…"
          style={{
            padding: "0.3rem 0.5rem",
            border: "1px solid #cbd5e1",
            borderRadius: 4,
            minWidth: 200,
          }}
        />
      </div>

      {err && (
        <div
          style={{
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#b91c1c",
            padding: "0.4rem 0.6rem",
            borderRadius: 6,
            marginBottom: "0.75rem",
          }}
        >
          {err}
        </div>
      )}

      {data && summary.totalPlans > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: "0.6rem",
            marginBottom: "0.75rem",
          }}
        >
          <SummaryTile
            label="Tier 2 weekly completion"
            value={
              summary.t2Pct !== null ? `${Math.round(summary.t2Pct)}%` : "—"
            }
            sub={
              summary.t2Expected > 0
                ? `${summary.t2Completed} of ${summary.t2Expected} entries · ${summary.t2Plans} plan${summary.t2Plans === 1 ? "" : "s"}`
                : `${summary.t2Plans} active plan${summary.t2Plans === 1 ? "" : "s"}`
            }
            tone={
              summary.t2Pct === null
                ? "neutral"
                : summary.t2Pct >= 90
                  ? "good"
                  : summary.t2Pct >= 70
                    ? "warn"
                    : "bad"
            }
          />
          <SummaryTile
            label="Tier 3 weekly avg score"
            value={
              summary.t3Avg !== null ? `${summary.t3Avg.toFixed(2)} / 5` : "—"
            }
            sub={
              summary.t3ScoreWeight > 0
                ? `${summary.t3ScoreWeight} scored day${summary.t3ScoreWeight === 1 ? "" : "s"} · ${summary.t3Plans} plan${summary.t3Plans === 1 ? "" : "s"}`
                : `${summary.t3Plans} active plan${summary.t3Plans === 1 ? "" : "s"}`
            }
            tone={
              summary.t3Avg === null
                ? "neutral"
                : summary.t3Avg >= 4.5
                  ? "good"
                  : summary.t3Avg >= 3.5
                    ? "warn"
                    : "bad"
            }
          />
          <SummaryTile
            label="Active plans this week"
            value={String(summary.totalPlans)}
            sub={`${summary.t2Plans} Tier 2 · ${summary.t3Plans} Tier 3`}
            tone="neutral"
          />
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
        <div>
          {loading && <div style={{ color: "#64748b" }}>Loading…</div>}
          {!loading && visibleRows.length === 0 && (
            <div style={{ color: "#64748b" }}>
              No active Tier 2 / Tier 3 plans match the filters.
            </div>
          )}
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {visibleRows.map((r) => {
              const completed = r.teachers.reduce((a, t) => a + t.completed, 0);
              const expected = r.teachers.reduce((a, t) => a + t.expected, 0);
              const isSel = selected?.studentId === r.studentId;
              return (
                <li
                  key={`${r.planId}-${r.studentId}`}
                  onClick={() => setSelected(r)}
                  style={{
                    padding: "0.5rem 0.7rem",
                    border: "1px solid",
                    borderColor: isSel ? "#2563eb" : "#e2e8f0",
                    background: isSel ? "#eff6ff" : "white",
                    borderRadius: 6,
                    marginBottom: 6,
                    cursor: "pointer",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center" }}>
                    {tierBadge(r.tier)}
                    <strong>{r.studentName}</strong>
                    {r.grade && (
                      <span
                        style={{
                          marginLeft: 6,
                          color: "#64748b",
                          fontSize: "0.8rem",
                        }}
                      >
                        Gr {r.grade}
                      </span>
                    )}
                    <span style={{ marginLeft: "auto" }}>
                      {pill(completed, expected)}
                    </span>
                  </div>
                  <div
                    style={{
                      fontSize: "0.75rem",
                      color: "#64748b",
                      marginTop: 2,
                    }}
                  >
                    {r.subType ? `${r.subType.toUpperCase()} · ` : ""}
                    {r.assignedTeacherCount} teacher
                    {r.assignedTeacherCount === 1 ? "" : "s"}
                    {r.title ? ` · ${r.title}` : ""}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        <div
          style={{
            border: "1px solid #e2e8f0",
            borderRadius: 8,
            padding: "0.75rem",
            background: "#fafafa",
            minHeight: 300,
          }}
        >
          {!selected && (
            <div style={{ color: "#64748b", fontSize: "0.9rem" }}>
              Select a student on the left to see per-teacher completion and
              recent comments.
            </div>
          )}
          {selected && (
            <>
              <div style={{ marginBottom: "0.5rem" }}>
                {tierBadge(selected.tier)}
                <strong>{selected.studentName}</strong>
                {selected.grade && (
                  <span
                    style={{
                      marginLeft: 6,
                      color: "#64748b",
                      fontSize: "0.8rem",
                    }}
                  >
                    Gr {selected.grade}
                  </span>
                )}
              </div>

              <h4 style={{ margin: "0.5rem 0" }}>
                Per-teacher completion (week of {week})
              </h4>
              <table className="pulse-table" style={{ borderCollapse: "collapse", width: "100%" }}>
                <thead>
                  <tr>
                    <th
                      style={{
                        textAlign: "left",
                        padding: "0.3rem",
                        fontSize: "0.8rem",
                      }}
                    >
                      Teacher
                    </th>
                    <th
                      style={{
                        textAlign: "left",
                        padding: "0.3rem",
                        fontSize: "0.8rem",
                      }}
                    >
                      Completed
                    </th>
                    <th
                      style={{
                        textAlign: "left",
                        padding: "0.3rem",
                        fontSize: "0.8rem",
                      }}
                    >
                      Avg score
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {selected.teachers.map((t) => (
                    <tr key={t.teacherStaffId}>
                      <td style={{ padding: "0.3rem", fontSize: "0.85rem" }}>
                        {t.teacherName}
                      </td>
                      <td style={{ padding: "0.3rem" }}>
                        {pill(t.completed, t.expected)}
                      </td>
                      <td style={{ padding: "0.3rem", fontSize: "0.85rem" }}>
                        {t.scoreAvg !== null ? t.scoreAvg.toFixed(2) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {selected.tier === 3 && detailT3.length > 0 && (
                <>
                  <h4 style={{ margin: "0.75rem 0 0.4rem" }}>
                    Weekly comments
                  </h4>
                  <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                    {detailT3.map((rec) => (
                      <li
                        key={rec.id}
                        style={{
                          fontSize: "0.85rem",
                          padding: "0.3rem 0",
                          borderBottom: "1px solid #f1f5f9",
                        }}
                      >
                        <div style={{ color: "#64748b", fontSize: "0.75rem" }}>
                          Teacher #{rec.teacherStaffId}
                        </div>
                        {rec.weeklyComment || (
                          <em style={{ color: "#94a3b8" }}>
                            (no weekly comment)
                          </em>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {selected.tier === 2 && detailT2.length > 0 && (
                <>
                  <h4 style={{ margin: "0.75rem 0 0.4rem" }}>Recent entries</h4>
                  <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                    {detailT2
                      .slice()
                      .sort((a, b) => b.entryDate.localeCompare(a.entryDate))
                      .map((e) => (
                        <li
                          key={e.id}
                          style={{
                            fontSize: "0.85rem",
                            padding: "0.3rem 0",
                            borderBottom: "1px solid #f1f5f9",
                          }}
                        >
                          <span style={{ color: "#64748b", marginRight: 6 }}>
                            {e.entryDate}
                          </span>
                          <span style={{ marginRight: 6 }}>
                            ({e.subType.toUpperCase()})
                          </span>
                          {e.notes ? (
                            e.notes
                          ) : (
                            <em style={{ color: "#94a3b8" }}>(no notes)</em>
                          )}
                        </li>
                      ))}
                  </ul>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

// Small KPI tile used by the weekly summary row at the top of the
// report. Color tone is purely informational — it nudges the eye but
// the numeric value remains the source of truth.
function SummaryTile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone: "good" | "warn" | "bad" | "neutral";
}) {
  const palette =
    tone === "good"
      ? { bg: "#dcfce7", border: "#86efac", fg: "#14532d" }
      : tone === "warn"
        ? { bg: "#fef9c3", border: "#fde047", fg: "#713f12" }
        : tone === "bad"
          ? { bg: "#fee2e2", border: "#fca5a5", fg: "#7f1d1d" }
          : { bg: "#f1f5f9", border: "#cbd5e1", fg: "#0f172a" };
  return (
    <div
      style={{
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        borderRadius: 8,
        padding: "0.6rem 0.75rem",
      }}
    >
      <div
        style={{
          fontSize: "0.72rem",
          textTransform: "uppercase",
          letterSpacing: 0.4,
          color: palette.fg,
          opacity: 0.8,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: "1.4rem",
          fontWeight: 700,
          color: palette.fg,
          marginTop: 2,
        }}
      >
        {value}
      </div>
      <div style={{ fontSize: "0.75rem", color: palette.fg, opacity: 0.85 }}>
        {sub}
      </div>
    </div>
  );
}
