// MTSS Plans admin — manages student-level intervention plans for the
// "core team" (admin / Behavior Specialist / MTSS Coordinator / PBIS
// Coordinator / SuperUser). v1: plan creation, editing, close/reopen,
// delete. v2 will add per-staff tracking against the point range.
//
// The list/edit screens both honor the active-school silo because the
// API is school-scoped. canManage is computed in App.tsx and mirrors
// the server's requireCoreTeam gate in routes/mtssPlans.ts.

import { useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/authToken";

type StatusFilter = "active" | "closed" | "all";

interface Plan {
  id: number;
  schoolId: number;
  studentId: string;
  studentName: string | null;
  studentGrade: number | null;
  studentLocalSisId?: string | null;
  title: string;
  goals: string;
  tier: number;
  pointRangeMin: number | null;
  pointRangeMax: number | null;
  notes: string;
  openedAt: string;
  openedByName: string | null;
  closedAt: string | null;
  closedByName: string | null;
  // New teacher-toggle fields (server returns CSV strings, client uses
  // them to seed the modal). `effectiveTeachers` is the resolved
  // (schedule + additional − excluded) list for at-a-glance display.
  autoAssignScheduleTeachers: boolean;
  excludedTeacherIds: string;
  additionalInterventionistIds: string;
  effectiveTeachers: Array<{
    staffId: number;
    displayName: string;
    source: "schedule" | "additional";
  }>;
}

interface ScheduleTeacherOption {
  staffId: number;
  displayName: string;
  period: number;
  courseName: string;
}

interface StaffOption {
  id: number;
  displayName: string;
}

interface TeacherOptionsResp {
  studentId: string;
  scheduleTeachers: ScheduleTeacherOption[];
  scheduleStaffIds: number[];
  staffOptions: StaffOption[];
}

function parseCsv(csv: string | null | undefined): number[] {
  if (!csv) return [];
  return csv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0);
}

interface Student {
  studentId: string;
  localSisId?: string | null;
  firstName: string;
  lastName: string;
  grade: number;
}

interface Props {
  canManage: boolean;
  onBack?: () => void;
  // Optional callback — when provided, each plan row gets a "Report"
  // button that hands off to the parent's reports view.
  onOpenReport?: (planId: number, planTitle: string) => void;
}

const TIER_COLORS: Record<number, string> = {
  1: "#0d9488", // teal
  2: "#d97706", // amber
  3: "#b91c1c", // red
};

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return "—";
  }
}

const MAX_GOALS = 5;
const MAX_GOAL_CHARS = 800;

// Goals are stored in the existing `goals` text column as a newline-
// delimited list (one goal per line). This keeps the schema unchanged
// while letting the UI present 1–5 numbered goal slots.
function splitGoals(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .map((g) => g.trim())
    .filter((g) => g.length > 0)
    .slice(0, MAX_GOALS);
}

function joinGoals(list: string[]): string {
  return list
    .map((g) => g.trim())
    .filter((g) => g.length > 0)
    .slice(0, MAX_GOALS)
    .map((g) => g.slice(0, MAX_GOAL_CHARS))
    .join("\n");
}

interface FastSuggestionWindow {
  schoolYear: string;
  window: string;
  masteryPct: number; // -1 = not administered
  below: boolean;
}

interface FastSuggestion {
  studentId: string;
  studentName: string | null;
  studentGrade: number | null;
  studentLocalSisId?: string | null;
  subject: string;
  benchmarkCode: string;
  benchmarkCategory: string | null;
  suggestedStrategyCategory: string;
  suggestedTitle: string;
  suggestedGoal: string;
  windows: FastSuggestionWindow[];
  belowCount: number;
  // Most-recent prior-year PM3 (from the FL Florida historical
  // importer). Null when no historical data on file.
  priorYearPm3: { schoolYear: string; pm3: number } | null;
}

interface FastSuggestionsResp {
  thresholdPct: number;
  minWindows: number;
  schoolYear?: string;
  suggestions: FastSuggestion[];
}

// Prefill payload passed from a FAST suggestion into PlanModal.
export interface MtssPlanPrefill {
  studentId: string;
  fastBenchmarkCode: string;
  tier: number;
  title: string;
  goal: string;
}

export default function MtssPlansAdmin({
  canManage,
  onBack,
  onOpenReport,
}: Props) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<StatusFilter>("active");
  const [studentFilter, setStudentFilter] = useState("");
  const [editing, setEditing] = useState<Plan | "new" | null>(null);
  const [prefill, setPrefill] = useState<MtssPlanPrefill | null>(null);
  const [students, setStudents] = useState<Student[]>([]);
  // FAST Phase 5 — Tier 2 auto-suggestions tile.
  const [suggestions, setSuggestions] = useState<FastSuggestion[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [suggestionsError, setSuggestionsError] = useState("");
  const [suggestionsMeta, setSuggestionsMeta] = useState<{
    thresholdPct: number;
    minWindows: number;
  }>({ thresholdPct: 80, minWindows: 2 });
  const [suggestionsOpen, setSuggestionsOpen] = useState(true);

  const reloadSuggestions = () => {
    if (!canManage) return;
    setSuggestionsLoading(true);
    setSuggestionsError("");
    authFetch("/api/mtss-plans/fast-suggestions")
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${r.status}`);
        }
        return r.json() as Promise<FastSuggestionsResp>;
      })
      .then((data) => {
        setSuggestions(data.suggestions ?? []);
        setSuggestionsMeta({
          thresholdPct: data.thresholdPct,
          minWindows: data.minWindows,
        });
      })
      .catch((e: Error) =>
        setSuggestionsError(e.message ?? "Failed to load suggestions"),
      )
      .finally(() => setSuggestionsLoading(false));
  };

  useEffect(() => {
    reloadSuggestions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManage]);

  const dismissSuggestion = async (s: FastSuggestion) => {
    if (!canManage) return;
    if (
      !window.confirm(
        `Dismiss FAST suggestion for ${s.studentName ?? s.studentId} on ${s.benchmarkCode}? It will stay hidden for the rest of this school year.`,
      )
    ) {
      return;
    }
    const r = await authFetch("/api/mtss-plans/fast-suggestions/dismiss", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        studentId: s.studentId,
        benchmarkCode: s.benchmarkCode,
      }),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      window.alert(body.error ?? "Failed to dismiss");
      return;
    }
    // Optimistic remove; full reload would also work.
    setSuggestions((prev) =>
      prev.filter(
        (x) =>
          !(
            x.studentId === s.studentId &&
            x.benchmarkCode === s.benchmarkCode
          ),
      ),
    );
  };

  const createPlanFromSuggestion = (s: FastSuggestion) => {
    if (!canManage) return;
    setPrefill({
      studentId: s.studentId,
      fastBenchmarkCode: s.benchmarkCode,
      tier: 2,
      title: s.suggestedTitle,
      goal: s.suggestedGoal,
    });
    setEditing("new");
  };

  const reload = () => {
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ status });
    authFetch(`/api/mtss-plans?${params.toString()}`)
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${r.status}`);
        }
        return r.json();
      })
      .then((rows: Plan[]) => setPlans(rows))
      .catch((e) => setError(e.message ?? "Failed to load plans"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // Pre-load students once for the create-plan picker. The /api/students
  // endpoint is school-scoped, so this returns just the active school's
  // roster.
  useEffect(() => {
    authFetch("/api/students")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: Student[]) => Array.isArray(rows) && setStudents(rows))
      .catch(() => {});
  }, []);

  const visiblePlans = useMemo(() => {
    if (!studentFilter.trim()) return plans;
    const needle = studentFilter.trim().toLowerCase();
    return plans.filter((p) => {
      const name = (p.studentName ?? "").toLowerCase();
      return (
        p.studentId.toLowerCase().includes(needle) ||
        name.includes(needle) ||
        p.title.toLowerCase().includes(needle)
      );
    });
  }, [plans, studentFilter]);

  const closePlan = async (plan: Plan) => {
    if (!canManage) return;
    if (!window.confirm(`Close plan "${plan.title}"? You can reopen later.`)) return;
    const r = await authFetch(`/api/mtss-plans/${plan.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ closed: true }),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      window.alert(body.error ?? "Failed to close plan");
      return;
    }
    reload();
  };

  const reopenPlan = async (plan: Plan) => {
    if (!canManage) return;
    const r = await authFetch(`/api/mtss-plans/${plan.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ closed: false }),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      window.alert(body.error ?? "Failed to reopen plan");
      return;
    }
    reload();
  };

  const deletePlan = async (plan: Plan) => {
    if (!canManage) return;
    if (
      !window.confirm(
        `Permanently delete plan "${plan.title}" for ${plan.studentName ?? plan.studentId}? This cannot be undone.`,
      )
    )
      return;
    const r = await authFetch(`/api/mtss-plans/${plan.id}`, {
      method: "DELETE",
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      window.alert(body.error ?? "Failed to delete plan");
      return;
    }
    reload();
  };

  return (
    <>
      <div
        style={{
          borderTopLeftRadius: "var(--radius-lg, 8px)",
          borderTopRightRadius: "var(--radius-lg, 8px)",
          overflow: "hidden",
          marginBottom: "-1px",
        }}
      >
        <div
          className="section-header-bar-teal"
          style={{ width: "100%", margin: 0 }}
        />
        <div
          className="section-header-band-hub"
          style={{ width: "100%", margin: 0 }}
        >
          <h2
            style={{
              margin: 0,
              color: "white",
              fontSize: "1.5rem",
              fontWeight: 700,
            }}
          >
            MTSS Plans
          </h2>
        </div>
      </div>

      <section className="card no-print">
        <div
          style={{
            display: "flex",
            gap: "0.75rem",
            flexWrap: "wrap",
            alignItems: "center",
            marginBottom: "1rem",
          }}
        >
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              style={{
                background: "#ede9fe",
                color: "#6d28d9",
                border: "1px solid #ddd6fe",
                borderRadius: 999,
                padding: "0.4rem 0.9rem",
                fontSize: "0.85rem",
                cursor: "pointer",
              }}
            >
              ← Back
            </button>
          )}
          <label style={{ fontSize: "0.85rem", color: "#475569" }}>
            Status:
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as StatusFilter)}
              style={{ marginLeft: "0.5rem" }}
            >
              <option value="active">Active</option>
              <option value="closed">Closed</option>
              <option value="all">All</option>
            </select>
          </label>
          <input
            type="text"
            placeholder="Filter by name, student id, or title…"
            value={studentFilter}
            onChange={(e) => setStudentFilter(e.target.value)}
            style={{
              flex: "1 1 240px",
              padding: "0.4rem 0.6rem",
              borderRadius: 6,
              border: "1px solid #cbd5e1",
            }}
          />
          {canManage && (
            <button
              type="button"
              onClick={() => setEditing("new")}
              style={{
                background: "#0d9488",
                color: "white",
                border: "none",
                borderRadius: 6,
                padding: "0.5rem 1rem",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              + New Plan
            </button>
          )}
        </div>

        {error && (
          <div
            style={{
              background: "#fef2f2",
              color: "#991b1b",
              padding: "0.75rem 1rem",
              borderRadius: 6,
              marginBottom: "1rem",
            }}
          >
            {error}
          </div>
        )}

        {canManage && (
          <div
            style={{
              border: "1px solid #fde68a",
              background: "#fffbeb",
              borderRadius: 8,
              padding: "0.75rem 1rem",
              marginBottom: "1rem",
            }}
          >
            <button
              type="button"
              onClick={() => setSuggestionsOpen((v) => !v)}
              style={{
                background: "transparent",
                border: "none",
                padding: 0,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontWeight: 700,
                color: "#92400e",
                fontSize: "0.95rem",
              }}
            >
              <span style={{ display: "inline-block", width: 12 }}>
                {suggestionsOpen ? "▾" : "▸"}
              </span>
              Suggested from FAST
              <span
                style={{
                  background: "#f59e0b",
                  color: "white",
                  borderRadius: 999,
                  padding: "1px 8px",
                  fontSize: "0.72rem",
                }}
              >
                {suggestions.length}
              </span>
              <span
                style={{
                  color: "#a16207",
                  fontWeight: 400,
                  fontSize: "0.78rem",
                }}
              >
                students below {suggestionsMeta.thresholdPct}% on the same
                benchmark in ≥{suggestionsMeta.minWindows} of the last 3
                windows
              </span>
            </button>
            {suggestionsOpen && (
              <div style={{ marginTop: 8 }}>
                {suggestionsLoading && (
                  <div style={{ color: "#a16207", fontSize: "0.85rem" }}>
                    Looking at recent FAST windows…
                  </div>
                )}
                {suggestionsError && (
                  <div style={{ color: "#991b1b", fontSize: "0.85rem" }}>
                    {suggestionsError}
                  </div>
                )}
                {!suggestionsLoading &&
                  !suggestionsError &&
                  suggestions.length === 0 && (
                    <div style={{ color: "#a16207", fontSize: "0.85rem" }}>
                      No FAST-driven Tier 2 candidates right now. Re-checks
                      after each FAST import.
                    </div>
                  )}
                {suggestions.length > 0 && (
                  <div style={{ overflowX: "auto" }}>
                    <table
                      className="pulse-table"
                      style={{
                        width: "100%",
                        borderCollapse: "collapse",
                        fontSize: "0.85rem",
                        marginTop: 6,
                      }}
                    >
                      <thead>
                        <tr style={{ textAlign: "left", color: "#78350f" }}>
                          <th style={{ padding: "0.4rem" }}>Student</th>
                          <th style={{ padding: "0.4rem" }}>Subj.</th>
                          <th style={{ padding: "0.4rem" }}>Benchmark</th>
                          <th style={{ padding: "0.4rem" }}>Recent windows</th>
                          <th
                            style={{ padding: "0.4rem", textAlign: "right" }}
                          ></th>
                        </tr>
                      </thead>
                      <tbody>
                        {suggestions.map((s) => (
                          <tr
                            key={`${s.studentId}|${s.benchmarkCode}`}
                            style={{ borderTop: "1px solid #fde68a" }}
                          >
                            <td
                              style={{
                                padding: "0.4rem",
                                whiteSpace: "nowrap",
                              }}
                            >
                              <div style={{ fontWeight: 600 }}>
                                {s.studentName ?? "(unknown)"}
                              </div>
                              <div
                                style={{
                                  color: "#92400e",
                                  fontSize: "0.72rem",
                                }}
                              >
                                ID {s.studentLocalSisId ?? "—"}
                                {s.studentGrade != null
                                  ? ` • Gr ${s.studentGrade}`
                                  : ""}
                              </div>
                              {s.priorYearPm3 && (
                                <div
                                  title={`Prior-year FAST PM3 (${s.priorYearPm3.schoolYear})`}
                                  style={{
                                    marginTop: 2,
                                    fontSize: "0.7rem",
                                    color: "#6b7280",
                                  }}
                                >
                                  <span style={{ color: "#9ca3af" }}>
                                    {s.priorYearPm3.schoolYear} PM3
                                  </span>{" "}
                                  <span
                                    style={{
                                      color: "#374151",
                                      fontWeight: 600,
                                    }}
                                  >
                                    {s.priorYearPm3.pm3}
                                  </span>
                                </div>
                              )}
                            </td>
                            <td
                              style={{
                                padding: "0.4rem",
                                textTransform: "uppercase",
                                fontSize: "0.75rem",
                                color: "#78350f",
                              }}
                            >
                              {s.subject}
                            </td>
                            <td style={{ padding: "0.4rem" }}>
                              <div
                                style={{
                                  fontFamily:
                                    "ui-monospace, SFMono-Regular, monospace",
                                  fontSize: "0.78rem",
                                  color: "#0f172a",
                                }}
                              >
                                {s.benchmarkCode}
                              </div>
                              {s.benchmarkCategory && (
                                <div
                                  style={{
                                    color: "#78350f",
                                    fontSize: "0.72rem",
                                  }}
                                >
                                  {s.benchmarkCategory}
                                </div>
                              )}
                            </td>
                            <td style={{ padding: "0.4rem" }}>
                              <div
                                style={{
                                  display: "inline-flex",
                                  gap: 4,
                                  alignItems: "center",
                                }}
                              >
                                {s.windows.map((w) => {
                                  const label = w.window.toUpperCase();
                                  const naked = w.masteryPct < 0;
                                  return (
                                    <span
                                      key={`${w.schoolYear}-${w.window}`}
                                      title={`${w.schoolYear} ${label}`}
                                      style={{
                                        display: "inline-flex",
                                        flexDirection: "column",
                                        alignItems: "center",
                                        background: naked
                                          ? "#f1f5f9"
                                          : w.below
                                            ? "#fee2e2"
                                            : "#dcfce7",
                                        color: naked
                                          ? "#94a3b8"
                                          : w.below
                                            ? "#991b1b"
                                            : "#166534",
                                        border: `1px solid ${
                                          naked
                                            ? "#e2e8f0"
                                            : w.below
                                              ? "#fecaca"
                                              : "#bbf7d0"
                                        }`,
                                        borderRadius: 6,
                                        padding: "2px 6px",
                                        minWidth: 44,
                                        fontSize: "0.72rem",
                                        fontWeight: 600,
                                      }}
                                    >
                                      <span style={{ fontSize: "0.66rem" }}>
                                        {label}
                                      </span>
                                      <span>
                                        {naked ? "—" : `${w.masteryPct}%`}
                                      </span>
                                    </span>
                                  );
                                })}
                              </div>
                            </td>
                            <td
                              style={{
                                padding: "0.4rem",
                                whiteSpace: "nowrap",
                                textAlign: "right",
                              }}
                            >
                              <div
                                style={{
                                  display: "inline-flex",
                                  gap: 6,
                                }}
                              >
                                <button
                                  type="button"
                                  onClick={() =>
                                    createPlanFromSuggestion(s)
                                  }
                                  style={{
                                    background: "#0d9488",
                                    color: "white",
                                    border: "none",
                                    borderRadius: 4,
                                    padding: "3px 10px",
                                    fontSize: "0.78rem",
                                    fontWeight: 600,
                                    cursor: "pointer",
                                  }}
                                  title="Create a Tier 2 plan prefilled from this benchmark"
                                >
                                  Create plan
                                </button>
                                <button
                                  type="button"
                                  onClick={() => dismissSuggestion(s)}
                                  style={{
                                    background: "white",
                                    color: "#92400e",
                                    border: "1px solid #fcd34d",
                                    borderRadius: 4,
                                    padding: "3px 10px",
                                    fontSize: "0.78rem",
                                    cursor: "pointer",
                                  }}
                                  title="Hide for the rest of this school year"
                                >
                                  Dismiss
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {loading ? (
          <div style={{ color: "#64748b" }}>Loading plans…</div>
        ) : visiblePlans.length === 0 ? (
          <div
            style={{
              padding: "1.5rem",
              border: "1px dashed #cbd5e1",
              borderRadius: 8,
              color: "#64748b",
              textAlign: "center",
            }}
          >
            {plans.length === 0
              ? "No MTSS plans yet. Click \u201c+ New Plan\u201d to create one."
              : "No plans match the current filter."}
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="pulse-table"
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "0.9rem",
              }}
            >
              <thead>
                <tr style={{ background: "#f1f5f9", textAlign: "left" }}>
                  <th style={{ padding: "0.5rem" }}>Student</th>
                  <th style={{ padding: "0.5rem" }}>Tier</th>
                  <th style={{ padding: "0.5rem" }}>Title</th>
                  <th style={{ padding: "0.5rem" }}>Goals</th>
                  <th style={{ padding: "0.5rem" }}>Point Range</th>
                  <th style={{ padding: "0.5rem" }}>Opened</th>
                  <th style={{ padding: "0.5rem" }}>Status</th>
                  <th style={{ padding: "0.5rem", width: 1 }}></th>
                </tr>
              </thead>
              <tbody>
                {visiblePlans.map((p) => (
                  <tr
                    key={p.id}
                    style={{ borderBottom: "1px solid #e2e8f0" }}
                  >
                    <td style={{ padding: "0.5rem", whiteSpace: "nowrap" }}>
                      <div style={{ fontWeight: 600 }}>
                        {p.studentName ?? "(unknown)"}
                      </div>
                      <div style={{ color: "#64748b", fontSize: "0.78rem" }}>
                        ID {p.studentLocalSisId ?? "—"}
                        {p.studentGrade != null
                          ? ` • Gr ${p.studentGrade}`
                          : ""}
                      </div>
                    </td>
                    <td style={{ padding: "0.5rem" }}>
                      <span
                        style={{
                          background: TIER_COLORS[p.tier] ?? "#475569",
                          color: "white",
                          padding: "2px 8px",
                          borderRadius: 999,
                          fontSize: "0.78rem",
                          fontWeight: 600,
                        }}
                      >
                        T{p.tier}
                      </span>
                    </td>
                    <td style={{ padding: "0.5rem" }}>{p.title}</td>
                    <td
                      style={{
                        padding: "0.5rem",
                        maxWidth: 320,
                        color: "#475569",
                      }}
                    >
                      {(() => {
                        const list = splitGoals(p.goals);
                        if (list.length === 0) return <em>—</em>;
                        return (
                          <ol
                            style={{
                              margin: 0,
                              paddingLeft: "1.1rem",
                              display: "-webkit-box",
                              WebkitLineClamp: 3,
                              WebkitBoxOrient: "vertical",
                              overflow: "hidden",
                            }}
                          >
                            {list.map((g, i) => (
                              <li key={i} style={{ marginBottom: 2 }}>
                                {g}
                              </li>
                            ))}
                          </ol>
                        );
                      })()}
                    </td>
                    <td style={{ padding: "0.5rem", whiteSpace: "nowrap" }}>
                      {p.pointRangeMin != null || p.pointRangeMax != null
                        ? `${p.pointRangeMin ?? "—"} – ${p.pointRangeMax ?? "—"}`
                        : "—"}
                    </td>
                    <td style={{ padding: "0.5rem", whiteSpace: "nowrap" }}>
                      <div>{fmtDate(p.openedAt)}</div>
                      {p.openedByName && (
                        <div
                          style={{ color: "#64748b", fontSize: "0.78rem" }}
                        >
                          by {p.openedByName}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: "0.5rem", whiteSpace: "nowrap" }}>
                      {p.closedAt ? (
                        <span
                          style={{
                            background: "#e2e8f0",
                            color: "#475569",
                            padding: "2px 8px",
                            borderRadius: 999,
                            fontSize: "0.78rem",
                          }}
                        >
                          Closed {fmtDate(p.closedAt)}
                        </span>
                      ) : (
                        <span
                          style={{
                            background: "#dcfce7",
                            color: "#166534",
                            padding: "2px 8px",
                            borderRadius: 999,
                            fontSize: "0.78rem",
                            fontWeight: 600,
                          }}
                        >
                          Active
                        </span>
                      )}
                    </td>
                    <td
                      style={{
                        padding: "0.5rem",
                        whiteSpace: "nowrap",
                        textAlign: "right",
                      }}
                    >
                      {canManage && (
                        <div
                          style={{
                            display: "inline-flex",
                            gap: 6,
                            flexWrap: "wrap",
                            justifyContent: "flex-end",
                          }}
                        >
                          {onOpenReport && (
                            <button
                              type="button"
                              onClick={() => onOpenReport(p.id, p.title)}
                              style={{
                                background: "#ecfdf5",
                                color: "#065f46",
                                border: "1px solid #a7f3d0",
                                borderRadius: 4,
                                padding: "2px 8px",
                                fontSize: "0.78rem",
                                cursor: "pointer",
                                fontWeight: 600,
                              }}
                              title="Open this plan's report"
                            >
                              Report
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => setEditing(p)}
                            style={{
                              background: "#f1f5f9",
                              border: "1px solid #cbd5e1",
                              borderRadius: 4,
                              padding: "2px 8px",
                              fontSize: "0.78rem",
                              cursor: "pointer",
                            }}
                          >
                            Edit
                          </button>
                          {p.closedAt ? (
                            <button
                              type="button"
                              onClick={() => reopenPlan(p)}
                              style={{
                                background: "#dbeafe",
                                color: "#1e40af",
                                border: "1px solid #bfdbfe",
                                borderRadius: 4,
                                padding: "2px 8px",
                                fontSize: "0.78rem",
                                cursor: "pointer",
                              }}
                            >
                              Reopen
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => closePlan(p)}
                              style={{
                                background: "#fef3c7",
                                color: "#92400e",
                                border: "1px solid #fde68a",
                                borderRadius: 4,
                                padding: "2px 8px",
                                fontSize: "0.78rem",
                                cursor: "pointer",
                              }}
                            >
                              Close
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => deletePlan(p)}
                            style={{
                              background: "#fee2e2",
                              color: "#991b1b",
                              border: "1px solid #fecaca",
                              borderRadius: 4,
                              padding: "2px 8px",
                              fontSize: "0.78rem",
                              cursor: "pointer",
                            }}
                          >
                            Delete
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editing !== null && (
        <PlanModal
          plan={editing === "new" ? null : editing}
          prefill={editing === "new" ? prefill : null}
          students={students}
          existingActivePlanStudentIds={new Set(
            plans.filter((p) => !p.closedAt).map((p) => p.studentId),
          )}
          onClose={() => {
            setEditing(null);
            setPrefill(null);
          }}
          onSaved={() => {
            setEditing(null);
            setPrefill(null);
            reload();
            // A new plan from a FAST suggestion drops that row from
            // the tile (server filter excludes pairs with an active
            // plan on the same benchmark code).
            reloadSuggestions();
          }}
        />
      )}
    </>
  );
}

interface PlanModalProps {
  plan: Plan | null;
  // FAST Phase 5 — when present on a new-plan modal, seeds student,
  // title, first goal, tier, and the fastBenchmarkCode column so the
  // resulting plan is wired straight back to the suggestion source.
  prefill?: MtssPlanPrefill | null;
  students: Student[];
  existingActivePlanStudentIds: Set<string>;
  onClose: () => void;
  onSaved: () => void;
}

function PlanModal({
  plan,
  prefill,
  students,
  existingActivePlanStudentIds,
  onClose,
  onSaved,
}: PlanModalProps) {
  const isEdit = plan !== null;
  // Prefill only applies to new-plan creation; edits ignore it.
  const seed = !isEdit && prefill ? prefill : null;
  const [studentId, setStudentId] = useState(
    plan?.studentId ?? seed?.studentId ?? "",
  );
  const [title, setTitle] = useState(plan?.title ?? seed?.title ?? "");
  const [goalsList, setGoalsList] = useState<string[]>(() => {
    const initial = splitGoals(plan?.goals ?? "");
    if (initial.length > 0) return initial;
    if (seed?.goal) return [seed.goal];
    return [""];
  });
  const [tier, setTier] = useState<number>(
    plan?.tier ?? seed?.tier ?? 2,
  );
  // Carried straight through to the POST body. Edits keep their existing
  // fastBenchmarkCode untouched (this modal doesn't surface a writer
  // for it yet — that's Phase 5 follow-up #28).
  const fastBenchmarkCode = seed?.fastBenchmarkCode ?? null;
  const [pointMin, setPointMin] = useState<string>(
    plan?.pointRangeMin == null ? "" : String(plan.pointRangeMin),
  );
  const [pointMax, setPointMax] = useState<string>(
    plan?.pointRangeMax == null ? "" : String(plan.pointRangeMax),
  );
  const [notes, setNotes] = useState(plan?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // ---- Teacher-toggle state ----
  // Default ON for new plans; respect the persisted flag on existing.
  const [autoAssign, setAutoAssign] = useState<boolean>(
    plan?.autoAssignScheduleTeachers ?? true,
  );
  // Excluded schedule teachers (only consulted when autoAssign is true).
  const [excludedIds, setExcludedIds] = useState<number[]>(() =>
    parseCsv(plan?.excludedTeacherIds),
  );
  // The picker doubles as:
  //   - "Additional interventionists" when autoAssign=true
  //     (counselor / BS / school psych / SW / trusted adult)
  //   - "Assigned interventionists" when autoAssign=false
  //     (entire authoritative manual list)
  // Seed accordingly so editing a manual plan shows the actual team
  // and not an empty picker.
  const [additionalIds, setAdditionalIds] = useState<number[]>(() => {
    if (plan && plan.autoAssignScheduleTeachers === false) {
      // Manual mode: source of truth is the legacy CSV.
      return parseCsv(
        (plan as Plan & { assignedTeacherIds?: string }).assignedTeacherIds,
      );
    }
    return parseCsv(plan?.additionalInterventionistIds);
  });
  const [teacherOpts, setTeacherOpts] = useState<TeacherOptionsResp | null>(
    null,
  );
  const [teacherOptsLoading, setTeacherOptsLoading] = useState(false);
  const [teacherOptsError, setTeacherOptsError] = useState("");
  const [interventionistFilter, setInterventionistFilter] = useState("");

  // Pull schedule + staff list any time the picked student changes (or
  // on mount in edit mode).
  useEffect(() => {
    const sid = studentId.trim();
    if (!sid) {
      setTeacherOpts(null);
      return;
    }
    setTeacherOptsLoading(true);
    setTeacherOptsError("");
    let cancelled = false;
    authFetch(
      `/api/mtss-plans/teacher-options?studentId=${encodeURIComponent(sid)}`,
    )
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${r.status}`);
        }
        return r.json();
      })
      .then((data: TeacherOptionsResp) => {
        if (cancelled) return;
        setTeacherOpts(data);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setTeacherOptsError(err.message ?? "Failed to load teachers");
        setTeacherOpts(null);
      })
      .finally(() => {
        if (!cancelled) setTeacherOptsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [studentId]);

  const studentLabel = (s: Student) =>
    `${s.firstName} ${s.lastName} — ID ${s.localSisId ?? "—"} (Gr ${s.grade})`;

  // For the new-plan picker, surface a hint if the student already has
  // an active plan. We don't block — multiple plans per student are
  // allowed (e.g. behavior + attendance).
  const dupHint =
    !isEdit &&
    studentId.trim() &&
    existingActivePlanStudentIds.has(studentId.trim())
      ? "This student already has an active plan. Creating a second plan is allowed."
      : "";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!studentId.trim()) {
      setError("Pick a student");
      return;
    }
    if (!title.trim()) {
      setError("Title is required");
      return;
    }
    const minN = pointMin.trim() === "" ? null : Number(pointMin);
    const maxN = pointMax.trim() === "" ? null : Number(pointMax);
    if (minN !== null && (!Number.isFinite(minN) || !Number.isInteger(minN))) {
      setError("Point range min must be a whole number");
      return;
    }
    if (maxN !== null && (!Number.isFinite(maxN) || !Number.isInteger(maxN))) {
      setError("Point range max must be a whole number");
      return;
    }
    if (minN !== null && maxN !== null && minN > maxN) {
      setError("Point range min cannot exceed max");
      return;
    }
    setBusy(true);
    try {
      const url = isEdit ? `/api/mtss-plans/${plan!.id}` : "/api/mtss-plans";
      const method = isEdit ? "PATCH" : "POST";
      const body: Record<string, unknown> = {
        title: title.trim(),
        goals: joinGoals(goalsList),
        tier,
        pointRangeMin: minN,
        pointRangeMax: maxN,
        notes: notes.trim(),
        autoAssignScheduleTeachers: autoAssign,
        excludedTeacherIds: excludedIds,
        additionalInterventionistIds: additionalIds,
        // When auto is OFF, the picker IS the authoritative manual
        // list — wire those same ids over to the legacy CSV the
        // server keys off of in manual mode.
        ...(autoAssign ? {} : { assignedTeacherIds: additionalIds }),
      };
      if (!isEdit) body.studentId = studentId.trim();
      if (!isEdit && fastBenchmarkCode) {
        body.fastBenchmarkCode = fastBenchmarkCode;
      }
      const r = await authFetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const respBody = await r.json().catch(() => ({}));
        throw new Error(respBody.error ?? `HTTP ${r.status}`);
      }
      onSaved();
    } catch (err) {
      setError((err as Error).message ?? "Failed to save");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1rem",
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "white",
          borderRadius: 8,
          padding: "1.25rem 1.5rem",
          maxWidth: 560,
          width: "100%",
          maxHeight: "90vh",
          overflow: "auto",
        }}
      >
        <h3 style={{ marginTop: 0 }}>
          {isEdit ? "Edit MTSS Plan" : "New MTSS Plan"}
        </h3>

        {!isEdit ? (
          <div style={{ marginBottom: "0.75rem" }}>
            <label
              style={{ display: "block", fontWeight: 600, marginBottom: 4 }}
            >
              Student
            </label>
            <input
              list="mtss-plan-students"
              value={studentId}
              onChange={(e) => setStudentId(e.target.value)}
              placeholder="Type a name or ID…"
              style={{
                width: "100%",
                padding: "0.5rem",
                border: "1px solid #cbd5e1",
                borderRadius: 6,
              }}
              required
            />
            <datalist id="mtss-plan-students">
              {students.map((s) => (
                <option key={s.studentId} value={s.studentId}>
                  {studentLabel(s)}
                </option>
              ))}
            </datalist>
            {dupHint && (
              <div
                style={{
                  fontSize: "0.78rem",
                  color: "#92400e",
                  marginTop: 4,
                }}
              >
                {dupHint}
              </div>
            )}
          </div>
        ) : (
          <div style={{ marginBottom: "0.75rem", color: "#475569" }}>
            <strong>Student:</strong>{" "}
            {plan!.studentName ?? "(unknown)"} — ID {plan!.studentLocalSisId ?? "—"}
          </div>
        )}

        <div style={{ marginBottom: "0.75rem" }}>
          <label
            style={{ display: "block", fontWeight: 600, marginBottom: 4 }}
          >
            Title
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Tier 2 Behavior Support"
            maxLength={200}
            style={{
              width: "100%",
              padding: "0.5rem",
              border: "1px solid #cbd5e1",
              borderRadius: 6,
            }}
            required
          />
        </div>

        <div style={{ marginBottom: "0.75rem" }}>
          <label
            style={{ display: "block", fontWeight: 600, marginBottom: 4 }}
          >
            Tier
          </label>
          <select
            value={tier}
            onChange={(e) => setTier(Number(e.target.value))}
            style={{
              padding: "0.4rem 0.6rem",
              border: "1px solid #cbd5e1",
              borderRadius: 6,
            }}
          >
            <option value={1}>Tier 1 — monitoring</option>
            <option value={2}>Tier 2 — small-group</option>
            <option value={3}>Tier 3 — intensive</option>
          </select>
        </div>

        {/* ---- Teacher assignment block ---- */}
        <div
          style={{
            marginBottom: "0.75rem",
            padding: "0.75rem",
            border: "1px solid #e2e8f0",
            borderRadius: 8,
            background: "#f8fafc",
          }}
        >
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontWeight: 600,
              marginBottom: 6,
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={autoAssign}
              onChange={(e) => setAutoAssign(e.target.checked)}
              style={{ width: 16, height: 16 }}
            />
            <span>Include all teachers on this student&rsquo;s schedule</span>
          </label>
          <div
            style={{
              fontSize: "0.78rem",
              color: "#64748b",
              marginBottom: 8,
              paddingLeft: 24,
            }}
          >
            On by default. Mid-year roster changes flow through automatically.
            Past teachers&rsquo; logged interventions are always retained.
          </div>

          {!studentId.trim() ? (
            <div
              style={{
                fontSize: "0.85rem",
                color: "#64748b",
                paddingLeft: 24,
              }}
            >
              Pick a student above to load their schedule.
            </div>
          ) : teacherOptsLoading ? (
            <div
              style={{
                fontSize: "0.85rem",
                color: "#64748b",
                paddingLeft: 24,
              }}
            >
              Loading schedule…
            </div>
          ) : teacherOptsError ? (
            <div
              style={{
                fontSize: "0.85rem",
                color: "#b91c1c",
                paddingLeft: 24,
              }}
            >
              {teacherOptsError}
            </div>
          ) : teacherOpts && autoAssign ? (
            teacherOpts.scheduleTeachers.length === 0 ? (
              <div
                style={{
                  fontSize: "0.85rem",
                  color: "#92400e",
                  paddingLeft: 24,
                  background: "#fef3c7",
                  border: "1px solid #fde68a",
                  borderRadius: 6,
                  padding: "6px 10px",
                }}
              >
                This student has no schedule on file. Add interventionists
                below or turn the toggle off and add teachers manually.
              </div>
            ) : (
              <div style={{ paddingLeft: 24 }}>
                <div
                  style={{
                    fontSize: "0.78rem",
                    color: "#475569",
                    marginBottom: 4,
                  }}
                >
                  {teacherOpts.scheduleTeachers.length -
                    teacherOpts.scheduleTeachers.filter((t) =>
                      excludedIds.includes(t.staffId),
                    ).length}{" "}
                  of {teacherOpts.scheduleTeachers.length} included
                </div>
                <ul
                  style={{
                    listStyle: "none",
                    padding: 0,
                    margin: 0,
                    display: "grid",
                    gap: 4,
                  }}
                >
                  {teacherOpts.scheduleTeachers.map((t) => {
                    const excluded = excludedIds.includes(t.staffId);
                    return (
                      <li
                        key={`${t.staffId}-${t.period}`}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          padding: "4px 6px",
                          background: excluded ? "#fef2f2" : "white",
                          border: `1px solid ${
                            excluded ? "#fecaca" : "#e2e8f0"
                          }`,
                          borderRadius: 6,
                          fontSize: "0.85rem",
                        }}
                      >
                        <span
                          style={{
                            display: "inline-block",
                            width: 28,
                            color: "#64748b",
                            fontWeight: 600,
                          }}
                        >
                          P{t.period}
                        </span>
                        <span style={{ flex: 1 }}>
                          <strong
                            style={{
                              color: excluded ? "#94a3b8" : "#0f172a",
                              textDecoration: excluded
                                ? "line-through"
                                : "none",
                            }}
                          >
                            {t.displayName}
                          </strong>
                          <span
                            style={{
                              color: "#64748b",
                              marginLeft: 6,
                            }}
                          >
                            — {t.courseName}
                          </span>
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            setExcludedIds((prev) =>
                              excluded
                                ? prev.filter((x) => x !== t.staffId)
                                : [...prev, t.staffId],
                            );
                          }}
                          title={
                            excluded ? "Re-include" : "Exclude from this plan"
                          }
                          style={{
                            background: excluded ? "#dbeafe" : "#fee2e2",
                            color: excluded ? "#1d4ed8" : "#b91c1c",
                            border: "1px solid",
                            borderColor: excluded ? "#bfdbfe" : "#fecaca",
                            borderRadius: 4,
                            padding: "2px 8px",
                            fontSize: "0.72rem",
                            fontWeight: 600,
                            cursor: "pointer",
                          }}
                        >
                          {excluded ? "Include" : "Exclude"}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )
          ) : null}

          {/* ---- Additional interventionists ---- */}
          <div
            style={{
              marginTop: autoAssign ? 12 : 0,
              paddingLeft: 24,
            }}
          >
            <div
              style={{
                fontWeight: 600,
                fontSize: "0.85rem",
                marginBottom: 4,
                color: "#0f172a",
              }}
            >
              {autoAssign
                ? "Additional interventionists"
                : "Assigned interventionists"}
            </div>
            <div
              style={{
                fontSize: "0.78rem",
                color: "#64748b",
                marginBottom: 6,
              }}
            >
              {autoAssign
                ? "Counselor, behavior specialist, school psychologist, social worker, trusted adult — anyone supporting this plan who isn\u2019t one of the student\u2019s classroom teachers."
                : "Pick everyone who is responsible for this plan. With the schedule toggle off, this list IS the plan team."}
            </div>

            {additionalIds.length > 0 && teacherOpts && (
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 4,
                  marginBottom: 6,
                }}
              >
                {additionalIds.map((id) => {
                  const opt = teacherOpts.staffOptions.find(
                    (s) => s.id === id,
                  );
                  return (
                    <span
                      key={id}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        background: "#ecfeff",
                        border: "1px solid #a5f3fc",
                        color: "#0e7490",
                        borderRadius: 999,
                        padding: "2px 4px 2px 10px",
                        fontSize: "0.78rem",
                        fontWeight: 600,
                      }}
                    >
                      {opt?.displayName ?? `#${id}`}
                      <button
                        type="button"
                        onClick={() =>
                          setAdditionalIds((prev) =>
                            prev.filter((x) => x !== id),
                          )
                        }
                        title="Remove"
                        style={{
                          background: "transparent",
                          border: "none",
                          color: "#0e7490",
                          fontWeight: 700,
                          cursor: "pointer",
                          fontSize: "0.95rem",
                          lineHeight: 1,
                          padding: "0 4px",
                        }}
                      >
                        ×
                      </button>
                    </span>
                  );
                })}
              </div>
            )}

            <input
              type="text"
              placeholder={
                teacherOpts
                  ? "Type to search staff…"
                  : "Pick a student above first"
              }
              value={interventionistFilter}
              onChange={(e) => setInterventionistFilter(e.target.value)}
              disabled={!teacherOpts}
              style={{
                width: "100%",
                padding: "0.4rem 0.5rem",
                border: "1px solid #cbd5e1",
                borderRadius: 6,
                fontSize: "0.85rem",
                marginBottom: 4,
              }}
            />
            {teacherOpts && interventionistFilter.trim() && (
              <div
                style={{
                  maxHeight: 160,
                  overflow: "auto",
                  border: "1px solid #e2e8f0",
                  borderRadius: 6,
                  background: "white",
                }}
              >
                {teacherOpts.staffOptions
                  .filter(
                    (s) =>
                      !additionalIds.includes(s.id) &&
                      s.displayName
                        .toLowerCase()
                        .includes(interventionistFilter.trim().toLowerCase()),
                  )
                  .slice(0, 25)
                  .map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => {
                        setAdditionalIds((prev) =>
                          prev.includes(s.id) ? prev : [...prev, s.id],
                        );
                        setInterventionistFilter("");
                      }}
                      style={{
                        display: "block",
                        width: "100%",
                        textAlign: "left",
                        background: "transparent",
                        border: "none",
                        padding: "6px 10px",
                        cursor: "pointer",
                        fontSize: "0.85rem",
                        color: "#0f172a",
                        borderBottom: "1px solid #f1f5f9",
                      }}
                      onMouseDown={(e) => e.preventDefault()}
                    >
                      {s.displayName}
                      {teacherOpts.scheduleStaffIds.includes(s.id) && (
                        <span
                          style={{
                            color: "#64748b",
                            fontSize: "0.72rem",
                            marginLeft: 6,
                          }}
                        >
                          (already on schedule)
                        </span>
                      )}
                    </button>
                  ))}
              </div>
            )}
          </div>
        </div>

        <div style={{ marginBottom: "0.75rem" }}>
          <label
            style={{ display: "block", fontWeight: 600, marginBottom: 4 }}
          >
            Goals{" "}
            <span style={{ fontWeight: 400, color: "#64748b" }}>
              (up to {MAX_GOALS})
            </span>
          </label>
          {goalsList.map((g, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                gap: 6,
                alignItems: "flex-start",
                marginBottom: 6,
              }}
            >
              <div
                style={{
                  width: 24,
                  flexShrink: 0,
                  fontWeight: 600,
                  color: "#475569",
                  paddingTop: 8,
                }}
              >
                {i + 1}.
              </div>
              <input
                type="text"
                value={g}
                onChange={(e) => {
                  const next = [...goalsList];
                  next[i] = e.target.value;
                  setGoalsList(next);
                }}
                placeholder={
                  i === 0
                    ? "e.g. Reduce tardies to fewer than 2 per week"
                    : "Another goal…"
                }
                maxLength={MAX_GOAL_CHARS}
                style={{
                  flex: 1,
                  padding: "0.5rem",
                  border: "1px solid #cbd5e1",
                  borderRadius: 6,
                  fontFamily: "inherit",
                }}
              />
              <button
                type="button"
                onClick={() => {
                  if (goalsList.length === 1) {
                    setGoalsList([""]);
                  } else {
                    setGoalsList(goalsList.filter((_, idx) => idx !== i));
                  }
                }}
                title="Remove this goal"
                aria-label="Remove this goal"
                style={{
                  flexShrink: 0,
                  width: 32,
                  height: 32,
                  background: "#fee2e2",
                  color: "#b91c1c",
                  border: "1px solid #fecaca",
                  borderRadius: 6,
                  cursor: "pointer",
                  fontSize: "1rem",
                  lineHeight: 1,
                }}
              >
                ×
              </button>
            </div>
          ))}
          {goalsList.length < MAX_GOALS && (
            <button
              type="button"
              onClick={() => setGoalsList([...goalsList, ""])}
              style={{
                background: "#ede9fe",
                color: "#6d28d9",
                border: "1px solid #ddd6fe",
                borderRadius: 6,
                padding: "0.35rem 0.75rem",
                cursor: "pointer",
                fontSize: "0.85rem",
                fontWeight: 600,
              }}
            >
              + Add another goal
            </button>
          )}
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "0.75rem",
            marginBottom: "0.75rem",
          }}
        >
          <div>
            <label
              style={{ display: "block", fontWeight: 600, marginBottom: 4 }}
            >
              Point Range Min
            </label>
            <input
              type="number"
              inputMode="numeric"
              value={pointMin}
              onChange={(e) => setPointMin(e.target.value)}
              placeholder="optional"
              style={{
                width: "100%",
                padding: "0.5rem",
                border: "1px solid #cbd5e1",
                borderRadius: 6,
              }}
            />
          </div>
          <div>
            <label
              style={{ display: "block", fontWeight: 600, marginBottom: 4 }}
            >
              Point Range Max
            </label>
            <input
              type="number"
              inputMode="numeric"
              value={pointMax}
              onChange={(e) => setPointMax(e.target.value)}
              placeholder="optional"
              style={{
                width: "100%",
                padding: "0.5rem",
                border: "1px solid #cbd5e1",
                borderRadius: 6,
              }}
            />
          </div>
        </div>

        <div style={{ marginBottom: "0.75rem" }}>
          <label
            style={{ display: "block", fontWeight: 600, marginBottom: 4 }}
          >
            Notes
          </label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            maxLength={4000}
            placeholder="Anything else the team should know."
            style={{
              width: "100%",
              padding: "0.5rem",
              border: "1px solid #cbd5e1",
              borderRadius: 6,
              fontFamily: "inherit",
            }}
          />
        </div>

        {error && (
          <div
            style={{
              background: "#fef2f2",
              color: "#991b1b",
              padding: "0.5rem 0.75rem",
              borderRadius: 6,
              marginBottom: "0.75rem",
            }}
          >
            {error}
          </div>
        )}

        <div
          style={{
            display: "flex",
            gap: "0.5rem",
            justifyContent: "flex-end",
          }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            style={{
              background: "#ede9fe",
              color: "#6d28d9",
              border: "1px solid #ddd6fe",
              borderRadius: 6,
              padding: "0.5rem 1rem",
              cursor: busy ? "not-allowed" : "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            style={{
              background: "#0d9488",
              color: "white",
              border: "none",
              borderRadius: 6,
              padding: "0.5rem 1.25rem",
              fontWeight: 600,
              cursor: busy ? "not-allowed" : "pointer",
            }}
          >
            {busy ? "Saving…" : isEdit ? "Save changes" : "Create plan"}
          </button>
        </div>
      </form>
    </div>
  );
}
