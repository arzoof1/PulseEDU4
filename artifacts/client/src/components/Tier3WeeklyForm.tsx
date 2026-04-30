// Tier 3 weekly tracking form. Renders Mon-Fri columns with 1..5 score
// buttons, a per-day comment field, a weekly comment, an optional PRIDE
// row (rendered when the plan opts in via track_school_wide_expectations),
// goals shown read-only by default (Core Team can write a new versioned
// goal inline via the small "+ New version" affordance), and an
// "Interventions Used This Week" checklist grouped by category with five
// Mon-Fri checkboxes per row.
//
// All scores / pride / strategy ticks are sparse: an unscored cell is
// just `null`. The teacher can submit any subset of the week and revisit
// later — the route upserts a single row per (student, teacher, week).
import { useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/authToken";

const DAYS = ["mon", "tue", "wed", "thu", "fri"] as const;
type Day = (typeof DAYS)[number];
const DAY_LABELS: Record<Day, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
};

const SCORE_LEGEND: Array<{ value: number; label: string }> = [
  { value: 5, label: "5 — 80%+ of day" },
  { value: 4, label: "4 — 60–80%" },
  { value: 3, label: "3 — 40–60%" },
  { value: 2, label: "2 — 20–40%" },
  { value: 1, label: "1 — under 20%" },
];

const PRIDE_LEGEND: Array<{ value: number; label: string }> = [
  { value: 0, label: "0 — Not at all" },
  { value: 1, label: "1 — About 50%" },
  { value: 2, label: "2 — 80%+" },
];

interface PlanRow {
  id: number;
  studentId: string;
  tier: number;
  trackSchoolWideExpectations: boolean;
  tier3GoalSlots: number;
  closedAt: string | null;
}

interface GoalRow {
  id: number;
  slot: number;
  text: string;
  effectiveFrom: string;
  createdByName: string | null;
}

interface StrategyCategoryRow {
  id: number;
  name: string;
  sortOrder: number;
  active: boolean;
}
interface StrategyRow {
  id: number;
  categoryId: number;
  name: string;
  sortOrder: number;
  active: boolean;
}

interface UsageRow {
  weeklyRecordId: number;
  strategyId: number;
  day: string;
  used: boolean;
}

interface RecordRow {
  id: number;
  studentId: string;
  teacherStaffId: number;
  weekStartDate: string;
  monScore: number | null;
  tueScore: number | null;
  wedScore: number | null;
  thuScore: number | null;
  friScore: number | null;
  monComment: string | null;
  tueComment: string | null;
  wedComment: string | null;
  thuComment: string | null;
  friComment: string | null;
  weeklyComment: string;
  prideMon: number | null;
  prideTue: number | null;
  prideWed: number | null;
  prideThu: number | null;
  prideFri: number | null;
  goalScores?: Record<string, Record<string, number | null>> | null;
  strategyUsage?: UsageRow[];
}

interface SchoolSettings {
  schoolWideExpectationAcronym?: string;
}

interface Props {
  studentId: string;
  studentName: string;
  isCoreTeam: boolean;
  weekStartDate: string; // YYYY-MM-DD Monday
  onSaved: () => void;
  onCancel: () => void;
}

function todayLocalISO(): string {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 10);
}

export default function Tier3WeeklyForm({
  studentId,
  studentName,
  isCoreTeam,
  weekStartDate,
  onSaved,
  onCancel,
}: Props) {
  const [plan, setPlan] = useState<PlanRow | null>(null);
  const [goals, setGoals] = useState<GoalRow[]>([]);
  const [categories, setCategories] = useState<StrategyCategoryRow[]>([]);
  const [strategies, setStrategies] = useState<StrategyRow[]>([]);
  const [record, setRecord] = useState<RecordRow | null>(null);
  const [acronym, setAcronym] = useState<string>("PRIDE");

  // Editable state. Per-goal-per-day score map.
  // Shape: { 1: {mon:5, tue:null, ...}, 2: {...} }. The server expects
  // string slot keys, but in component state we keep them as numbers
  // for cheap indexing — they get JSON.stringified at submit time.
  type DayScores = Record<Day, number | null>;
  const emptyDayScores = (): DayScores => ({
    mon: null,
    tue: null,
    wed: null,
    thu: null,
    fri: null,
  });
  const [goalScores, setGoalScores] = useState<Record<number, DayScores>>({});
  const [pride, setPride] = useState<Record<Day, number | null>>({
    mon: null,
    tue: null,
    wed: null,
    thu: null,
    fri: null,
  });
  const [comments, setComments] = useState<Record<Day, string>>({
    mon: "",
    tue: "",
    wed: "",
    thu: "",
    fri: "",
  });
  const [weeklyComment, setWeeklyComment] = useState("");
  const [usage, setUsage] = useState<Set<string>>(new Set()); // `${strategyId}:${day}`

  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [editingGoalSlot, setEditingGoalSlot] = useState<number | null>(null);
  const [newGoalText, setNewGoalText] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Use the teacher-friendly probe endpoint so plain teachers
        // (who can't read the full /api/mtss-plans list) still get
        // the tier + sub-type + PRIDE flag pre-fill they need.
        const planRes = await authFetch(
          `/api/mtss-plans/probe/${encodeURIComponent(studentId)}`,
        );
        if (planRes.ok) {
          const data = (await planRes.json()) as {
            plan:
              | {
                  id: number;
                  studentId: string;
                  tier: number;
                  interventionSubType: string | null;
                  trackSchoolWideExpectations: boolean;
                  tier3GoalSlots: number;
                  closedAt: string | null;
                }
              | null;
          };
          const p = data.plan;
          if (!cancelled && p && p.tier === 3) {
            setPlan(p);
          }
        }
      } catch {
        /* non-fatal */
      }
      await reloadGoals(cancelled);
      try {
        const [catRes, stratRes, settingsRes, recRes] = await Promise.all([
          authFetch("/api/tier3-strategy-categories"),
          authFetch("/api/tier3-strategies"),
          authFetch("/api/school-settings"),
          authFetch(
            `/api/tier3-records?studentId=${encodeURIComponent(studentId)}&weekStartDate=${weekStartDate}&teacherStaffId=`,
          ),
        ]);
        if (catRes.ok && !cancelled) setCategories(await catRes.json());
        if (stratRes.ok && !cancelled) setStrategies(await stratRes.json());
        if (settingsRes.ok && !cancelled) {
          const s = (await settingsRes.json()) as SchoolSettings;
          if (s?.schoolWideExpectationAcronym) {
            setAcronym(s.schoolWideExpectationAcronym);
          }
        }
        if (recRes.ok && !cancelled) {
          const recs = (await recRes.json()) as RecordRow[];
          // The teacher's own record (server already filtered to staff).
          const mine = recs[0] ?? null;
          if (mine) hydrateFromRecord(mine);
        }
      } catch {
        /* non-fatal */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studentId, weekStartDate]);

  async function reloadGoals(cancelled: boolean) {
    try {
      const goalsRes = await authFetch(
        `/api/tier3-goals?studentId=${encodeURIComponent(studentId)}`,
      );
      if (goalsRes.ok && !cancelled) setGoals(await goalsRes.json());
    } catch {
      /* non-fatal */
    }
  }

  function hydrateFromRecord(r: RecordRow): void {
    setRecord(r);
    // Per-goal-per-day scores. If the saved record has any goalScores
    // map, use it as-is. Otherwise migrate any legacy single-row score
    // (mon..fri) into slot 1 so an existing weekly entry doesn't
    // appear blank when teachers reopen the form.
    const incoming = r.goalScores ?? {};
    const slotKeys = Object.keys(incoming);
    if (slotKeys.length > 0) {
      const next: Record<number, DayScores> = {};
      for (const k of slotKeys) {
        const slotN = Number(k);
        if (!Number.isInteger(slotN) || slotN < 1 || slotN > 5) continue;
        const perDay = incoming[k] ?? {};
        next[slotN] = {
          mon:
            typeof perDay.mon === "number" ? (perDay.mon as number) : null,
          tue:
            typeof perDay.tue === "number" ? (perDay.tue as number) : null,
          wed:
            typeof perDay.wed === "number" ? (perDay.wed as number) : null,
          thu:
            typeof perDay.thu === "number" ? (perDay.thu as number) : null,
          fri:
            typeof perDay.fri === "number" ? (perDay.fri as number) : null,
        };
      }
      setGoalScores(next);
    } else if (
      r.monScore !== null ||
      r.tueScore !== null ||
      r.wedScore !== null ||
      r.thuScore !== null ||
      r.friScore !== null
    ) {
      setGoalScores({
        1: {
          mon: r.monScore,
          tue: r.tueScore,
          wed: r.wedScore,
          thu: r.thuScore,
          fri: r.friScore,
        },
      });
    } else {
      setGoalScores({});
    }
    setPride({
      mon: r.prideMon,
      tue: r.prideTue,
      wed: r.prideWed,
      thu: r.prideThu,
      fri: r.prideFri,
    });
    setComments({
      mon: r.monComment ?? "",
      tue: r.tueComment ?? "",
      wed: r.wedComment ?? "",
      thu: r.thuComment ?? "",
      fri: r.friComment ?? "",
    });
    setWeeklyComment(r.weeklyComment ?? "");
    const u = new Set<string>();
    for (const row of r.strategyUsage ?? []) {
      if (row.used) u.add(`${row.strategyId}:${row.day}`);
    }
    setUsage(u);
  }

  // Active goal per slot (largest effective_from <= today).
  const today = todayLocalISO();
  const activeGoals = useMemo(() => {
    const max = plan?.tier3GoalSlots ?? 5;
    const bySlot: Record<number, GoalRow | undefined> = {};
    for (const g of goals) {
      if (g.slot < 1 || g.slot > max) continue;
      if (g.effectiveFrom > today) continue;
      const cur = bySlot[g.slot];
      if (!cur || g.effectiveFrom > cur.effectiveFrom) bySlot[g.slot] = g;
    }
    const rows: Array<{ slot: number; goal: GoalRow | undefined }> = [];
    for (let i = 1; i <= max; i++) {
      rows.push({ slot: i, goal: bySlot[i] });
    }
    return rows;
  }, [goals, plan, today]);

  const showPride = plan?.trackSchoolWideExpectations !== false;
  const visibleStrategies = strategies.filter((s) => s.active);
  const visibleCategories = categories.filter(
    (c) => c.active && visibleStrategies.some((s) => s.categoryId === c.id),
  );

  function toggleUsage(strategyId: number, day: Day): void {
    const key = `${strategyId}:${day}`;
    const next = new Set(usage);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setUsage(next);
  }

  async function saveGoal(slot: number) {
    setMsg(null);
    if (!newGoalText.trim()) return;
    try {
      const res = await authFetch("/api/tier3-goals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId,
          slot,
          text: newGoalText.trim(),
          effectiveFrom: todayLocalISO(),
        }),
      });
      if (!res.ok) throw new Error((await res.text()) || "Save failed");
      setEditingGoalSlot(null);
      setNewGoalText("");
      await reloadGoals(false);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Goal save failed");
    }
  }

  async function submit() {
    setSubmitting(true);
    setMsg(null);
    try {
      const strategyUsage: Array<{ strategyId: number; day: Day }> = [];
      for (const key of usage) {
        const [sid, d] = key.split(":");
        strategyUsage.push({ strategyId: Number(sid), day: d as Day });
      }
      // Send the per-goal-per-day score map. Server derives the
      // overall mon..fri scores as the rounded mean across goals so
      // we don't have to send them again here.
      const goalScoresPayload: Record<string, Record<string, number | null>> = {};
      for (const [slot, perDay] of Object.entries(goalScores)) {
        goalScoresPayload[String(slot)] = {
          mon: perDay.mon,
          tue: perDay.tue,
          wed: perDay.wed,
          thu: perDay.thu,
          fri: perDay.fri,
        };
      }
      const body: Record<string, unknown> = {
        studentId,
        weekStartDate,
        weeklyComment,
        strategyUsage,
        goalScores: goalScoresPayload,
      };
      for (const d of DAYS) {
        body[`${d}Comment`] = comments[d];
        if (showPride) {
          body[`pride${d.charAt(0).toUpperCase()}${d.slice(1)}`] = pride[d];
        }
      }
      const res = await authFetch("/api/tier3-records", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.text()) || "Save failed");
      onSaved();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSubmitting(false);
    }
  }

  const buttonStyle = (active: boolean): React.CSSProperties => ({
    width: 28,
    height: 28,
    borderRadius: 6,
    border: active ? "2px solid #2563eb" : "1px solid #cbd5e1",
    background: active ? "#dbeafe" : "white",
    cursor: "pointer",
    fontWeight: active ? 700 : 500,
  });

  return (
    <div style={{ display: "grid", gap: "1rem", maxWidth: 880 }}>
      <div style={{ fontSize: "1.1rem", fontWeight: 600 }}>
        Tier 3 — Weekly tracking for {studentName}
        <span style={{ marginLeft: 8, color: "#64748b", fontSize: "0.9rem" }}>
          (week of {weekStartDate}
          {record ? " — saved earlier; editing in place" : ""})
        </span>
      </div>

      <div
        style={{
          fontSize: "0.8rem",
          color: "#475569",
          background: "#f8fafc",
          padding: "0.4rem 0.6rem",
          borderRadius: 6,
        }}
      >
        Score scale:&nbsp;
        {SCORE_LEGEND.map((l) => l.label).join(" · ")}
      </div>

      {/* Goals + score grid. Each goal renders its OWN 1..5 score row
          per day, so the teacher records a separate score for every
          goal instead of a single shared "overall" score. The
          `dayCellStyle` helper adds a soft vertical border between
          every Mon..Fri column so the days don't visually run
          together — the first day cell gets a left border too. */}
      <div style={{ overflowX: "auto" }}>
        <table
          style={{
            borderCollapse: "collapse",
            width: "100%",
            tableLayout: "fixed",
          }}
        >
          <colgroup>
            <col style={{ width: 220 }} />
            {DAYS.map((d) => (
              <col key={d} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th
                style={{
                  textAlign: "left",
                  padding: "0.4rem",
                  borderBottom: "2px solid #cbd5e1",
                  background: "#f8fafc",
                }}
              >
                Goal
              </th>
              {DAYS.map((d, i) => (
                <th
                  key={d}
                  style={{
                    padding: "0.4rem",
                    borderBottom: "2px solid #cbd5e1",
                    borderLeft: "1px solid #cbd5e1",
                    borderRight:
                      i === DAYS.length - 1 ? "1px solid #cbd5e1" : undefined,
                    background: "#f8fafc",
                  }}
                >
                  {DAY_LABELS[d]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {activeGoals.map(({ slot, goal }) => {
              const slotScores = goalScores[slot] ?? emptyDayScores();
              return (
                <tr key={slot}>
                  <td
                    style={{
                      padding: "0.4rem",
                      borderBottom: "1px solid #e2e8f0",
                      verticalAlign: "top",
                    }}
                  >
                    <div style={{ fontSize: "0.85rem", color: "#475569" }}>
                      Goal {slot}
                    </div>
                    {goal ? (
                      <div style={{ fontSize: "0.95rem" }}>{goal.text}</div>
                    ) : (
                      <div style={{ color: "#94a3b8", fontStyle: "italic" }}>
                        (no goal yet)
                      </div>
                    )}
                    {isCoreTeam && (
                      <div style={{ marginTop: 4 }}>
                        {editingGoalSlot === slot ? (
                          <div style={{ display: "flex", gap: 4 }}>
                            <input
                              value={newGoalText}
                              onChange={(e) => setNewGoalText(e.target.value)}
                              placeholder="New goal text…"
                              style={{
                                flex: 1,
                                padding: "0.3rem 0.4rem",
                                borderRadius: 4,
                                border: "1px solid #cbd5e1",
                                fontSize: "0.85rem",
                              }}
                            />
                            <button
                              type="button"
                              onClick={() => saveGoal(slot)}
                              style={{ fontSize: "0.8rem" }}
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setEditingGoalSlot(null);
                                setNewGoalText("");
                              }}
                              style={{ fontSize: "0.8rem" }}
                            >
                              ✕
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              setEditingGoalSlot(slot);
                              setNewGoalText(goal?.text ?? "");
                            }}
                            style={{
                              fontSize: "0.75rem",
                              color: "#2563eb",
                              background: "transparent",
                              border: "none",
                              padding: 0,
                              cursor: "pointer",
                            }}
                          >
                            + New version
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                  {DAYS.map((d, i) => (
                    <td
                      key={d}
                      style={{
                        padding: "0.4rem",
                        borderBottom: "1px solid #e2e8f0",
                        borderLeft: "1px solid #e2e8f0",
                        borderRight:
                          i === DAYS.length - 1
                            ? "1px solid #e2e8f0"
                            : undefined,
                        verticalAlign: "middle",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          gap: 3,
                          justifyContent: "center",
                          flexWrap: "wrap",
                        }}
                      >
                        {[1, 2, 3, 4, 5].map((v) => (
                          <button
                            key={v}
                            type="button"
                            onClick={() => {
                              const cur = slotScores[d];
                              const next: Record<number, DayScores> = {
                                ...goalScores,
                                [slot]: {
                                  ...slotScores,
                                  [d]: cur === v ? null : v,
                                },
                              };
                              setGoalScores(next);
                            }}
                            style={buttonStyle(slotScores[d] === v)}
                            title={
                              SCORE_LEGEND.find((l) => l.value === v)?.label ??
                              ""
                            }
                          >
                            {v}
                          </button>
                        ))}
                      </div>
                    </td>
                  ))}
                </tr>
              );
            })}

            {showPride && (
              <tr>
                <td
                  style={{
                    padding: "0.4rem",
                    fontWeight: 600,
                    borderBottom: "1px solid #e2e8f0",
                  }}
                >
                  {acronym} (school-wide)
                  <div
                    style={{
                      fontSize: "0.7rem",
                      color: "#64748b",
                      fontWeight: 400,
                    }}
                  >
                    {PRIDE_LEGEND.map((l) => l.label).join(" · ")}
                  </div>
                </td>
                {DAYS.map((d, i) => (
                  <td
                    key={d}
                    style={{
                      padding: "0.4rem",
                      borderBottom: "1px solid #e2e8f0",
                      borderLeft: "1px solid #e2e8f0",
                      borderRight:
                        i === DAYS.length - 1
                          ? "1px solid #e2e8f0"
                          : undefined,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        gap: 4,
                        justifyContent: "center",
                      }}
                    >
                      {[0, 1, 2].map((v) => (
                        <button
                          key={v}
                          type="button"
                          onClick={() =>
                            setPride({
                              ...pride,
                              [d]: pride[d] === v ? null : v,
                            })
                          }
                          style={buttonStyle(pride[d] === v)}
                          title={
                            PRIDE_LEGEND.find((l) => l.value === v)?.label ??
                            ""
                          }
                        >
                          {v}
                        </button>
                      ))}
                    </div>
                  </td>
                ))}
              </tr>
            )}

            {/* Per-day comments */}
            <tr>
              <td
                style={{
                  padding: "0.4rem",
                  fontWeight: 600,
                  borderBottom: "1px solid #e2e8f0",
                }}
              >
                Day comment
              </td>
              {DAYS.map((d, i) => (
                <td
                  key={d}
                  style={{
                    padding: "0.4rem",
                    borderBottom: "1px solid #e2e8f0",
                    borderLeft: "1px solid #e2e8f0",
                    borderRight:
                      i === DAYS.length - 1
                        ? "1px solid #e2e8f0"
                        : undefined,
                  }}
                >
                  <textarea
                    rows={2}
                    value={comments[d]}
                    onChange={(e) =>
                      setComments({ ...comments, [d]: e.target.value })
                    }
                    style={{
                      width: "100%",
                      fontSize: "0.85rem",
                      padding: "0.3rem",
                      border: "1px solid #cbd5e1",
                      borderRadius: 4,
                      boxSizing: "border-box",
                    }}
                  />
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      <label style={{ display: "grid", gap: 4 }}>
        <span style={{ fontSize: "0.85rem", color: "#475569" }}>
          Weekly comment
        </span>
        <textarea
          value={weeklyComment}
          onChange={(e) => setWeeklyComment(e.target.value)}
          rows={2}
          maxLength={1000}
          style={{
            padding: "0.4rem 0.6rem",
            borderRadius: 6,
            border: "1px solid #cbd5e1",
          }}
        />
      </label>

      {/* Strategy checklist */}
      {visibleCategories.length > 0 && (
        <div>
          <div style={{ fontWeight: 600, marginBottom: "0.4rem" }}>
            Interventions Used This Week
          </div>
          {visibleCategories.map((cat) => (
            <div key={cat.id} style={{ marginBottom: "0.5rem" }}>
              <div
                style={{
                  fontSize: "0.85rem",
                  color: "#475569",
                  fontWeight: 600,
                  marginBottom: 2,
                }}
              >
                {cat.name}
              </div>
              <table style={{ borderCollapse: "collapse", width: "100%" }}>
                <thead>
                  <tr>
                    <th
                      style={{
                        textAlign: "left",
                        padding: "0.2rem 0.4rem",
                        fontSize: "0.75rem",
                        color: "#64748b",
                      }}
                    />
                    {DAYS.map((d) => (
                      <th
                        key={d}
                        style={{
                          padding: "0.2rem",
                          fontSize: "0.75rem",
                          color: "#64748b",
                          width: 40,
                        }}
                      >
                        {DAY_LABELS[d]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibleStrategies
                    .filter((s) => s.categoryId === cat.id)
                    .map((s) => (
                      <tr key={s.id}>
                        <td style={{ padding: "0.2rem 0.4rem", fontSize: "0.85rem" }}>
                          {s.name}
                        </td>
                        {DAYS.map((d) => (
                          <td
                            key={d}
                            style={{ padding: "0.2rem", textAlign: "center" }}
                          >
                            <input
                              type="checkbox"
                              checked={usage.has(`${s.id}:${d}`)}
                              onChange={() => toggleUsage(s.id, d)}
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}

      {msg && (
        <div
          style={{
            padding: "0.4rem 0.6rem",
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#b91c1c",
            borderRadius: 6,
            fontSize: "0.9rem",
          }}
        >
          {msg}
        </div>
      )}

      <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
        <button type="button" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={submitting}
          style={{
            background: "#2563eb",
            color: "white",
            padding: "0.45rem 0.9rem",
            borderRadius: 6,
            border: "none",
            cursor: "pointer",
          }}
        >
          {submitting ? "Saving…" : "Save weekly record"}
        </button>
      </div>
    </div>
  );
}
