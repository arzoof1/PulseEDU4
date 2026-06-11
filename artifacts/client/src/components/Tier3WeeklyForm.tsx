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
  // Academic plans set fastSubject (ela|math) and meetingDays (CSV
  // "mon".."fri"). For those, the form renders only the scheduled
  // meeting days and hides the behavior-specific PRIDE + strategy grids.
  fastSubject?: string | null;
  meetingDays?: string | null;
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
  absentDays?: Record<string, boolean> | null;
  submittedAt?: string | null;
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
  // True once the plan probe has resolved (success or not). We hold the
  // initial render until then so an academic plan never flashes the
  // behavior grid before dispatching to the minutes form.
  const [planResolved, setPlanResolved] = useState(false);
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
  // Per-day "student was absent" toggles. Defaults to all-false. An
  // absent day disables its score buttons and is excluded from the
  // weekly % of points earned + the bell's missing-day count.
  const [absentDays, setAbsentDays] = useState<Record<Day, boolean>>({
    mon: false,
    tue: false,
    wed: false,
    thu: false,
    fri: false,
  });
  const [submittedAt, setSubmittedAt] = useState<string | null>(null);
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
                  fastSubject?: string | null;
                  meetingDays?: string | null;
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
      } finally {
        if (!cancelled) setPlanResolved(true);
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
    // Per-day absent flags + submission state.
    const ad = (r.absentDays ?? {}) as Record<string, unknown>;
    setAbsentDays({
      mon: Boolean(ad.mon),
      tue: Boolean(ad.tue),
      wed: Boolean(ad.wed),
      thu: Boolean(ad.thu),
      fri: Boolean(ad.fri),
    });
    setSubmittedAt(r.submittedAt ?? null);
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
      // Hide empty slots from teachers — there's nothing for them to
      // do in those rows. Core Team still sees them so they can use
      // the "+ New version" affordance to seed a goal into an empty
      // slot (this form is the only place goals can be created).
      if (!bySlot[i] && !isCoreTeam) continue;
      rows.push({ slot: i, goal: bySlot[i] });
    }
    return rows;
  }, [goals, plan, today, isCoreTeam]);

  // Academic Tier 3 plans (fastSubject set) only meet on their configured
  // meeting days, and skip the behavior-specific PRIDE + strategy grids.
  const isAcademic = !!plan?.fastSubject;
  const meetingDaySet = plan?.meetingDays
    ? new Set(
        plan.meetingDays
          .split(",")
          .map((d) => d.trim().toLowerCase())
          .filter(Boolean),
      )
    : null;
  const visibleDays: Day[] =
    isAcademic && meetingDaySet
      ? DAYS.filter((d) => meetingDaySet.has(d))
      : [...DAYS];
  const showPride =
    !isAcademic && plan?.trackSchoolWideExpectations !== false;
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

  // Persist the form. `mode` decides the submission flag:
  //  - "draft": save in place, leave submittedAt alone — teachers can
  //    come back any time during the week.
  //  - "submit": stamp submittedAt so the report can flag the row as
  //    final. Edits after submission still allowed (re-submit bumps
  //    the timestamp).
  async function persist(mode: "draft" | "submit") {
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
        absentDays,
        submitted: mode === "submit",
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
      // Keep the form open after a draft save so teachers can keep
      // adding to it; close it on a final submission.
      if (mode === "submit") {
        onSaved();
      } else {
        // Hydrate directly from the POST response so we get the
        // server-derived overall day scores + the canonical
        // submittedAt without a second round-trip (and without the
        // race condition that a follow-up GET could lose to a
        // concurrent save).
        try {
          const saved = (await res.json()) as RecordRow;
          hydrateFromRecord(saved);
        } catch {
          // Non-JSON responses are unexpected but non-fatal — the
          // local state is already consistent with what we sent.
        }
        setMsg("Draft saved.");
      }
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSubmitting(false);
    }
  }
  const submit = () => persist("submit");
  const saveDraft = () => persist("draft");

  // True iff every scheduled day has at least one goal scored OR is
  // marked absent. Drives whether the "Submit" button is enabled. For
  // academic Tier 3 plans only the configured meeting days count, so the
  // week can't be completed until each scheduled meeting day is logged.
  const allDaysAccounted = useMemo(() => {
    for (const d of visibleDays) {
      if (absentDays[d]) continue;
      let scoredAtLeastOneGoal = false;
      for (const slot of Object.values(goalScores)) {
        if (typeof slot[d] === "number") {
          scoredAtLeastOneGoal = true;
          break;
        }
      }
      if (!scoredAtLeastOneGoal) return false;
    }
    return true;
  }, [absentDays, goalScores, visibleDays]);

  const buttonStyle = (active: boolean): React.CSSProperties => ({
    width: 28,
    height: 28,
    borderRadius: 6,
    // Match the app's purple accent (same hue as the notification
    // bell glow). When selected, fill solid purple with white text
    // for the strongest contrast.
    border: active ? "2px solid #7e22ce" : "1px solid #cbd5e1",
    background: active ? "#a855f7" : "white",
    color: active ? "white" : "#1e293b",
    cursor: "pointer",
    fontWeight: active ? 700 : 500,
  });

  // Hold the first paint until the plan probe resolves so an academic
  // plan dispatches straight to the minutes form (no behavior-grid flash).
  if (!planResolved) {
    return (
      <div style={{ padding: "1rem", color: "#64748b", fontSize: "0.9rem" }}>
        Loading plan…
      </div>
    );
  }

  // Academic Tier 3 plans use a minutes-based small-group model instead of
  // the behavior per-day goal-scoring grid. Dispatch to the dedicated form.
  if (isAcademic) {
    return (
      <Tier3AcademicMinutesForm
        studentId={studentId}
        studentName={studentName}
        isCoreTeam={isCoreTeam}
        initialWeekStartDate={weekStartDate}
        fastSubject={plan?.fastSubject ?? null}
        onSaved={onSaved}
        onCancel={onCancel}
      />
    );
  }

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
        <table className="pulse-table"
          style={{
            borderCollapse: "collapse",
            width: "100%",
            tableLayout: "fixed",
          }}
        >
          <colgroup>
            <col style={{ width: 220 }} />
            {visibleDays.map((d) => (
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
              {visibleDays.map((d, i) => (
                <th
                  key={d}
                  style={{
                    padding: "0.4rem",
                    borderBottom: "2px solid #cbd5e1",
                    borderLeft: "1px solid #cbd5e1",
                    borderRight:
                      i === visibleDays.length - 1 ? "1px solid #cbd5e1" : undefined,
                    background: "#f8fafc",
                  }}
                >
                  {DAY_LABELS[d]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* Per-day absence row. Toggling a day to "Absent" disables
                its score buttons and excludes the day from the % of
                points earned + the bell's missing-day count. */}
            <tr>
              <td
                style={{
                  padding: "0.4rem",
                  fontWeight: 600,
                  borderBottom: "1px solid #e2e8f0",
                  background: "#fafafa",
                }}
              >
                Absent?
                <div
                  style={{
                    fontSize: "0.7rem",
                    color: "#64748b",
                    fontWeight: 400,
                  }}
                >
                  Won&rsquo;t count toward weekly %
                </div>
              </td>
              {visibleDays.map((d, i) => (
                <td
                  key={d}
                  style={{
                    padding: "0.4rem",
                    borderBottom: "1px solid #e2e8f0",
                    borderLeft: "1px solid #e2e8f0",
                    borderRight:
                      i === visibleDays.length - 1
                        ? "1px solid #e2e8f0"
                        : undefined,
                    background: absentDays[d] ? "#fef3c7" : "#fafafa",
                    textAlign: "center",
                  }}
                >
                  <label
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      fontSize: "0.8rem",
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={absentDays[d]}
                      onChange={(e) =>
                        setAbsentDays({
                          ...absentDays,
                          [d]: e.target.checked,
                        })
                      }
                    />
                    Absent
                  </label>
                </td>
              ))}
            </tr>

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
                  {visibleDays.map((d, i) => {
                    const isAbsent = absentDays[d];
                    // No goal text yet means there's nothing to score
                    // against — leave the buttons inert + greyed so it's
                    // obvious the row is awaiting a goal from Core Team.
                    const noGoal = !goal;
                    return (
                      <td
                        key={d}
                        style={{
                          padding: "0.4rem",
                          borderBottom: "1px solid #e2e8f0",
                          borderLeft: "1px solid #e2e8f0",
                          borderRight:
                            i === visibleDays.length - 1
                              ? "1px solid #e2e8f0"
                              : undefined,
                          verticalAlign: "middle",
                          background: isAbsent
                            ? "#fef3c7"
                            : noGoal
                              ? "#f1f5f9"
                              : undefined,
                        }}
                      >
                        {isAbsent ? (
                          <div
                            style={{
                              fontSize: "0.75rem",
                              color: "#92400e",
                              textAlign: "center",
                              fontStyle: "italic",
                            }}
                          >
                            Absent
                          </div>
                        ) : noGoal ? (
                          <div
                            style={{
                              fontSize: "0.75rem",
                              color: "#94a3b8",
                              textAlign: "center",
                              fontStyle: "italic",
                            }}
                            title="Add a goal first to enable scoring."
                          >
                            —
                          </div>
                        ) : (
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
                                  SCORE_LEGEND.find((l) => l.value === v)
                                    ?.label ?? ""
                                }
                              >
                                {v}
                              </button>
                            ))}
                          </div>
                        )}
                      </td>
                    );
                  })}
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
                {visibleDays.map((d, i) => (
                  <td
                    key={d}
                    style={{
                      padding: "0.4rem",
                      borderBottom: "1px solid #e2e8f0",
                      borderLeft: "1px solid #e2e8f0",
                      borderRight:
                        i === visibleDays.length - 1
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
              {visibleDays.map((d, i) => (
                <td
                  key={d}
                  style={{
                    padding: "0.4rem",
                    borderBottom: "1px solid #e2e8f0",
                    borderLeft: "1px solid #e2e8f0",
                    borderRight:
                      i === visibleDays.length - 1
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

      {/* Strategy checklist — behavior plans only */}
      {!isAcademic && visibleCategories.length > 0 && (
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
              <table className="pulse-table" style={{ borderCollapse: "collapse", width: "100%" }}>
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
                    {visibleDays.map((d) => (
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
                        {visibleDays.map((d) => (
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

      {/* Submission status: shows whether the record is a draft or
          has been submitted, plus a small hint about why "Submit"
          might be disabled. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.5rem",
          flexWrap: "wrap",
        }}
      >
        <div style={{ fontSize: "0.85rem", color: "#475569" }}>
          {submittedAt ? (
            <span>
              <strong style={{ color: "#047857" }}>Submitted</strong> on{" "}
              {new Date(submittedAt).toLocaleString()} — edits still allowed.
            </span>
          ) : (
            <span>
              <strong style={{ color: "#b45309" }}>Draft</strong> — save as
              you go through the week, submit when finished.
            </span>
          )}
        </div>
        {!allDaysAccounted && !submittedAt && (
          <div style={{ fontSize: "0.75rem", color: "#64748b" }}>
            Submit becomes available once every weekday has a score or is
            marked Absent.
          </div>
        )}
      </div>

      <div
        style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}
      >
        <button type="button" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <button
          type="button"
          onClick={saveDraft}
          disabled={submitting}
          style={{
            background: "white",
            color: "#1e293b",
            padding: "0.45rem 0.9rem",
            borderRadius: 6,
            border: "1px solid #cbd5e1",
            cursor: submitting ? "not-allowed" : "pointer",
            fontWeight: 500,
          }}
        >
          {submitting ? "Saving…" : "Save draft"}
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={submitting || !allDaysAccounted}
          title={
            !allDaysAccounted
              ? "Score every day or mark it Absent before submitting."
              : ""
          }
          style={{
            background: !allDaysAccounted ? "#94a3b8" : "#2563eb",
            color: "white",
            padding: "0.45rem 0.9rem",
            borderRadius: 6,
            border: "none",
            cursor:
              submitting || !allDaysAccounted ? "not-allowed" : "pointer",
            fontWeight: 600,
          }}
        >
          {submitting
            ? "Saving…"
            : submittedAt
              ? "Re-submit"
              : "Submit week"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Academic Tier 3 — minutes-based small-group log
// ---------------------------------------------------------------------------
// Replaces the behavior per-day goal-scoring grid for academic plans
// (fastSubject set). The model is "minutes of small-group time per week":
//   - per visible day, a 5-minute-step minutes dropdown,
//   - a running total toward the weekly target,
//   - a week selector (met / owed / excused badges) to backfill prior weeks,
//   - a needs-attention strip linking the still-owed weeks,
//   - a release valve ("no group provided this week" -> excused).
// All data flows through the same /api/tier3-records upsert + the dedicated
// /api/tier3-academic-weeks status endpoint.

const ACADEMIC_DAY_MAX = 240;
const ACADEMIC_STEP = 5;

interface AcademicWeekStatusRow {
  weekStartDate: string;
  minutes: number;
  target: number;
  released: boolean;
  releaseReason: string | null;
  releasedAt: string | null;
  state: "met" | "owed" | "excused";
}

interface AcademicWeeksResponse {
  studentId: string;
  teacherStaffId: number;
  minutesTarget: number;
  academicAnyDay: boolean;
  fastSubject: string | null;
  visibleDays: Day[];
  weeks: AcademicWeekStatusRow[];
}

function weekLabelClient(monday: string): string {
  const d = new Date(`${monday}T00:00:00Z`);
  const month = d.toLocaleDateString("en-US", {
    month: "short",
    timeZone: "UTC",
  });
  return `week of ${month} ${d.getUTCDate()}`;
}

const STATE_STYLE: Record<
  "met" | "owed" | "excused",
  { bg: string; fg: string; border: string; label: string }
> = {
  met: { bg: "#dcfce7", fg: "#166534", border: "#86efac", label: "Met" },
  owed: { bg: "#fef3c7", fg: "#92400e", border: "#fcd34d", label: "Owed" },
  excused: { bg: "#e2e8f0", fg: "#475569", border: "#cbd5e1", label: "Excused" },
};

function Tier3AcademicMinutesForm({
  studentId,
  studentName,
  isCoreTeam: _isCoreTeam,
  initialWeekStartDate,
  fastSubject,
  onSaved,
  onCancel,
}: {
  studentId: string;
  studentName: string;
  isCoreTeam: boolean;
  initialWeekStartDate: string;
  fastSubject: string | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [activeWeek, setActiveWeek] = useState(initialWeekStartDate);
  const [meta, setMeta] = useState<AcademicWeeksResponse | null>(null);
  const [minutes, setMinutes] = useState<Record<Day, number>>({
    mon: 0,
    tue: 0,
    wed: 0,
    thu: 0,
    fri: 0,
  });
  const [weeklyComment, setWeeklyComment] = useState("");
  const [released, setReleased] = useState(false);
  const [releaseReason, setReleaseReason] = useState<string | null>(null);
  const [releasedAt, setReleasedAt] = useState<string | null>(null);
  const [releaseDraft, setReleaseDraft] = useState("");
  const [showReleaseInput, setShowReleaseInput] = useState(false);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const subjectLabel =
    fastSubject === "ela" ? "ELA" : fastSubject === "math" ? "Math" : "Academic";
  const target = meta?.minutesTarget ?? 30;
  const visibleDays: Day[] = meta?.visibleDays ?? [...DAYS];
  const todayMonday = useMemo(() => {
    const t = todayLocalISO();
    const d = new Date(`${t}T00:00:00Z`);
    const dow = d.getUTCDay();
    const shift = dow === 0 ? -6 : 1 - dow;
    d.setUTCDate(d.getUTCDate() + shift);
    return d.toISOString().slice(0, 10);
  }, []);
  const todayKey: Day | null = useMemo(() => {
    const t = todayLocalISO();
    const dow = new Date(`${t}T00:00:00Z`).getUTCDay();
    const map: Record<number, Day | undefined> = {
      1: "mon",
      2: "tue",
      3: "wed",
      4: "thu",
      5: "fri",
    };
    return map[dow] ?? null;
  }, []);

  // Load the week selector status (target / any-day / visible days / per-week
  // met-owed-excused) once, and refresh after each save.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch(
          `/api/tier3-academic-weeks?studentId=${encodeURIComponent(
            studentId,
          )}&teacherStaffId=`,
        );
        if (res.ok && !cancelled) {
          const data = (await res.json()) as AcademicWeeksResponse;
          setMeta(data);
        }
      } catch {
        /* non-fatal */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [studentId, reloadKey]);

  // Load the active week's record (per-day minutes + release state).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const res = await authFetch(
          `/api/tier3-records?studentId=${encodeURIComponent(
            studentId,
          )}&weekStartDate=${activeWeek}&teacherStaffId=`,
        );
        if (res.ok && !cancelled) {
          const rows = (await res.json()) as Array<{
            academicMinutes?: Record<string, number> | null;
            weeklyComment?: string | null;
            releasedNoIntervention?: boolean | null;
            releaseReason?: string | null;
            releasedAt?: string | null;
          }>;
          const r = rows[0] ?? null;
          const am = (r?.academicMinutes ?? {}) as Record<string, number>;
          setMinutes({
            mon: Number(am.mon) || 0,
            tue: Number(am.tue) || 0,
            wed: Number(am.wed) || 0,
            thu: Number(am.thu) || 0,
            fri: Number(am.fri) || 0,
          });
          setWeeklyComment(r?.weeklyComment ?? "");
          setReleased(Boolean(r?.releasedNoIntervention));
          setReleaseReason(r?.releaseReason ?? null);
          setReleasedAt(r?.releasedAt ?? null);
          setShowReleaseInput(false);
          setReleaseDraft("");
        }
      } catch {
        /* non-fatal */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [studentId, activeWeek, reloadKey]);

  const loggedTotal = useMemo(
    () => visibleDays.reduce((sum, d) => sum + (minutes[d] || 0), 0),
    [minutes, visibleDays],
  );
  const pct = target > 0 ? Math.min(100, (loggedTotal / target) * 100) : 0;
  const weekState: "met" | "owed" | "excused" = released
    ? "excused"
    : loggedTotal >= target
      ? "met"
      : "owed";

  const owedWeeks = (meta?.weeks ?? []).filter(
    (w) => w.state === "owed" && w.weekStartDate !== activeWeek,
  );

  const minutesOptions = useMemo(() => {
    const opts: number[] = [];
    for (let m = 0; m <= ACADEMIC_DAY_MAX; m += ACADEMIC_STEP) opts.push(m);
    return opts;
  }, []);

  async function saveWeek() {
    setSaving(true);
    setMsg(null);
    try {
      const minutesPayload: Record<string, number> = {};
      for (const d of visibleDays) minutesPayload[d] = minutes[d] || 0;
      const res = await authFetch("/api/tier3-records", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId,
          weekStartDate: activeWeek,
          weeklyComment,
          academicMinutes: minutesPayload,
          submitted: true,
        }),
      });
      if (!res.ok) throw new Error((await res.text()) || "Save failed");
      setMsg("Saved.");
      setReloadKey((k) => k + 1);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function applyRelease(release: boolean, reason: string) {
    setSaving(true);
    setMsg(null);
    try {
      const res = await authFetch("/api/tier3-records", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId,
          weekStartDate: activeWeek,
          releasedNoIntervention: release,
          releaseReason: release ? reason : null,
        }),
      });
      if (!res.ok) throw new Error((await res.text()) || "Save failed");
      setMsg(release ? "Week marked excused." : "Release cleared.");
      setReloadKey((k) => k + 1);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: "1rem", maxWidth: 720 }}>
      <div style={{ fontSize: "1.1rem", fontWeight: 600 }}>
        Tier 3 {subjectLabel} — Small-group minutes for {studentName}
      </div>

      {/* Week selector */}
      <div style={{ display: "grid", gap: 6 }}>
        <label style={{ fontSize: "0.8rem", fontWeight: 600, color: "#475569" }}>
          Week
        </label>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {(meta?.weeks ?? []).map((w) => {
            const active = w.weekStartDate === activeWeek;
            const st = STATE_STYLE[w.state];
            return (
              <button
                key={w.weekStartDate}
                type="button"
                onClick={() => setActiveWeek(w.weekStartDate)}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  gap: 2,
                  padding: "5px 10px",
                  borderRadius: 8,
                  border: `2px solid ${active ? "#7e22ce" : st.border}`,
                  background: active ? "#faf5ff" : st.bg,
                  color: st.fg,
                  cursor: "pointer",
                  fontSize: "0.75rem",
                  fontWeight: 600,
                }}
              >
                <span>{weekLabelClient(w.weekStartDate)}</span>
                <span style={{ fontSize: "0.68rem", fontWeight: 700 }}>
                  {st.label}
                  {w.state !== "excused"
                    ? ` · ${w.minutes}/${w.target}m`
                    : ""}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Needs-attention strip */}
      {owedWeeks.length > 0 && (
        <div
          style={{
            padding: "0.5rem 0.75rem",
            background: "#fffbeb",
            border: "1px solid #fcd34d",
            borderRadius: 8,
            fontSize: "0.82rem",
            color: "#92400e",
          }}
        >
          <strong>Still owed:</strong>{" "}
          {owedWeeks.map((w, i) => (
            <span key={w.weekStartDate}>
              <button
                type="button"
                onClick={() => setActiveWeek(w.weekStartDate)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "#b45309",
                  textDecoration: "underline",
                  cursor: "pointer",
                  fontSize: "0.82rem",
                  fontWeight: 600,
                  padding: 0,
                }}
              >
                {weekLabelClient(w.weekStartDate)}
              </button>
              {i < owedWeeks.length - 1 ? ", " : ""}
            </span>
          ))}
        </div>
      )}

      {loading ? (
        <div style={{ color: "#64748b", fontSize: "0.9rem" }}>Loading week…</div>
      ) : released ? (
        <div
          style={{
            padding: "0.75rem 1rem",
            background: "#f1f5f9",
            border: "1px solid #cbd5e1",
            borderRadius: 8,
          }}
        >
          <div style={{ fontWeight: 600, color: "#475569" }}>
            No group provided this week — excused.
          </div>
          {releaseReason && (
            <div style={{ fontSize: "0.85rem", color: "#64748b", marginTop: 4 }}>
              Reason: {releaseReason}
            </div>
          )}
          {releasedAt && (
            <div style={{ fontSize: "0.75rem", color: "#94a3b8", marginTop: 2 }}>
              Released {new Date(releasedAt).toLocaleString()}
            </div>
          )}
          <button
            type="button"
            onClick={() => applyRelease(false, "")}
            disabled={saving}
            style={{
              marginTop: 8,
              fontSize: "0.8rem",
              padding: "0.3rem 0.7rem",
              borderRadius: 6,
              border: "1px solid #cbd5e1",
              background: "white",
              cursor: saving ? "not-allowed" : "pointer",
            }}
          >
            Undo — log minutes instead
          </button>
        </div>
      ) : (
        <>
          {/* Running total */}
          <div style={{ display: "grid", gap: 4 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
              }}
            >
              <span style={{ fontWeight: 600 }}>
                {loggedTotal} / {target} minutes
              </span>
              <span
                style={{
                  fontSize: "0.78rem",
                  fontWeight: 700,
                  color: STATE_STYLE[weekState].fg,
                }}
              >
                {STATE_STYLE[weekState].label}
              </span>
            </div>
            <div
              style={{
                height: 8,
                borderRadius: 999,
                background: "#e2e8f0",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${pct}%`,
                  height: "100%",
                  background: weekState === "met" ? "#22c55e" : "#a855f7",
                  transition: "width 0.2s",
                }}
              />
            </div>
          </div>

          {/* Per-day minutes */}
          <div style={{ display: "grid", gap: 8 }}>
            {visibleDays.map((d) => {
              const isToday = d === todayKey && activeWeek === todayMonday;
              return (
                <div
                  key={d}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "0.4rem 0.6rem",
                    borderRadius: 8,
                    border: `1px solid ${isToday ? "#a855f7" : "#e2e8f0"}`,
                    background: isToday ? "#faf5ff" : "white",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={(minutes[d] || 0) > 0}
                    onChange={(e) =>
                      setMinutes((prev) => ({
                        ...prev,
                        [d]: e.target.checked ? prev[d] || target : 0,
                      }))
                    }
                  />
                  <span
                    style={{
                      width: 44,
                      fontWeight: 600,
                      color: "#334155",
                    }}
                  >
                    {DAY_LABELS[d]}
                    {isToday ? " ·" : ""}
                  </span>
                  <select
                    value={minutes[d] || 0}
                    onChange={(e) =>
                      setMinutes((prev) => ({
                        ...prev,
                        [d]: Number(e.target.value),
                      }))
                    }
                    style={{
                      padding: "0.3rem 0.5rem",
                      borderRadius: 6,
                      border: "1px solid #cbd5e1",
                    }}
                  >
                    {minutesOptions.map((m) => (
                      <option key={m} value={m}>
                        {m} min
                      </option>
                    ))}
                  </select>
                  {isToday && (
                    <span style={{ fontSize: "0.72rem", color: "#7e22ce" }}>
                      today
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {/* Weekly comment */}
          <div style={{ display: "grid", gap: 4 }}>
            <label
              style={{ fontSize: "0.8rem", fontWeight: 600, color: "#475569" }}
            >
              Note (optional)
            </label>
            <textarea
              value={weeklyComment}
              onChange={(e) => setWeeklyComment(e.target.value)}
              rows={2}
              style={{
                padding: "0.4rem 0.6rem",
                borderRadius: 6,
                border: "1px solid #cbd5e1",
                resize: "vertical",
                fontFamily: "inherit",
              }}
            />
          </div>

          {/* Release valve */}
          {showReleaseInput ? (
            <div
              style={{
                display: "grid",
                gap: 6,
                padding: "0.6rem 0.75rem",
                background: "#f8fafc",
                border: "1px solid #e2e8f0",
                borderRadius: 8,
              }}
            >
              <label style={{ fontSize: "0.8rem", fontWeight: 600 }}>
                Mark this week “no group provided”
              </label>
              <input
                value={releaseDraft}
                onChange={(e) => setReleaseDraft(e.target.value)}
                placeholder="Reason (e.g. testing week, group cancelled)…"
                style={{
                  padding: "0.35rem 0.5rem",
                  borderRadius: 6,
                  border: "1px solid #cbd5e1",
                }}
              />
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  type="button"
                  onClick={() => applyRelease(true, releaseDraft.trim())}
                  disabled={saving}
                  style={{
                    fontSize: "0.8rem",
                    padding: "0.3rem 0.7rem",
                    borderRadius: 6,
                    border: "none",
                    background: "#64748b",
                    color: "white",
                    cursor: saving ? "not-allowed" : "pointer",
                  }}
                >
                  Confirm excused
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowReleaseInput(false);
                    setReleaseDraft("");
                  }}
                  disabled={saving}
                  style={{
                    fontSize: "0.8rem",
                    padding: "0.3rem 0.7rem",
                    borderRadius: 6,
                    border: "1px solid #cbd5e1",
                    background: "white",
                    cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowReleaseInput(true)}
              style={{
                justifySelf: "start",
                fontSize: "0.78rem",
                color: "#64748b",
                background: "transparent",
                border: "none",
                textDecoration: "underline",
                cursor: "pointer",
                padding: 0,
              }}
            >
              No group provided this week?
            </button>
          )}
        </>
      )}

      {msg && (
        <div
          style={{
            padding: "0.4rem 0.6rem",
            background: msg === "Saved." ? "#f0fdf4" : "#fef2f2",
            border: `1px solid ${msg === "Saved." ? "#bbf7d0" : "#fecaca"}`,
            color: msg === "Saved." ? "#166534" : "#b91c1c",
            borderRadius: 6,
            fontSize: "0.9rem",
          }}
        >
          {msg}
        </div>
      )}

      {/* Actions */}
      <div
        style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}
      >
        <button type="button" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        {!released && (
          <button
            type="button"
            onClick={saveWeek}
            disabled={saving || loading}
            style={{
              background: "white",
              color: "#1e293b",
              padding: "0.45rem 0.9rem",
              borderRadius: 6,
              border: "1px solid #cbd5e1",
              cursor: saving || loading ? "not-allowed" : "pointer",
              fontWeight: 500,
            }}
          >
            {saving ? "Saving…" : "Save week"}
          </button>
        )}
        <button
          type="button"
          onClick={onSaved}
          disabled={saving}
          style={{
            background: "#2563eb",
            color: "white",
            padding: "0.45rem 0.9rem",
            borderRadius: 6,
            border: "none",
            cursor: saving ? "not-allowed" : "pointer",
            fontWeight: 600,
          }}
        >
          Done
        </button>
      </div>
    </div>
  );
}
