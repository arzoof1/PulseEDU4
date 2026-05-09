import { useEffect, useMemo, useRef, useState } from "react";
import { authFetch } from "../lib/authToken";

// Spotlight — fair, fast, "pull a name from the hat" picker for whole-class
// engagement. Pulls from the teacher's CURRENT-period roster (so attendance
// + period-matching is implicit), excludes a no-repeat tail tracked
// server-side, and pairs the pick with a school-managed prompt card.
//
// Two animation styles, switchable by the teacher and saved per-device:
//   • wheel   — classic spinning prize wheel with one wedge per student
//   • bottles — water-bottle flip; bottles tumble through the air, all but
//               one miss the table; the winner lands upright with the
//               label facing forward.
// In both modes we ask the server for the winner FIRST, then animate the
// reveal so the picker can land on the right answer.

interface BellPeriod {
  periodNumber: number;
  startTime: string;
  endTime: string;
}

interface RosterStudent {
  studentId: string;
  firstName: string | null;
  lastName: string | null;
}

interface Prompt {
  id: number;
  text: string;
  active: boolean;
  sortOrder: number;
}

interface PickResult {
  pick: {
    studentId: string;
    firstName: string | null;
    lastName: string | null;
  };
  prompt: { id: number; text: string } | null;
  poolSize: number;
}

type AnimStyle = "wheel" | "bottles";
const STYLE_STORAGE_KEY = "pulseedu.spotlight.style";
// Total animation runtime. Keep in lockstep with the CSS keyframe
// durations on `.bottle-winner` / `.bottle-miss` (and the wheel spin) —
// the React timer that flips state from "animating" → "result" must
// fire AFTER the bottle has visibly landed on the table, otherwise the
// poster swap cuts off the touchdown beat.
const ANIM_DURATION_MS = 4000;

type SpinState =
  | { kind: "idle" }
  | { kind: "loading" }
  | {
      kind: "animating";
      pick: PickResult;
      // Index into the *display set* (not the roster) — for the wheel
      // this is the roster index; for bottles it's the slot in the
      // bottle row, which is a 6-bottle subset that always includes
      // the winner.
      targetIndex: number;
      bottleSlots?: RosterStudent[];
    }
  | { kind: "result"; pick: PickResult };

interface SpotlightPanelProps {
  isAdmin: boolean;
}

interface TeacherOpt {
  id: number;
  displayName: string | null;
}

// Palette for wheel wedges. Picked for high contrast against white text
// and reasonable ordering — alternating light/dark prevents two same-hue
// wedges sitting next to each other.
const WHEEL_COLORS = [
  "#0ea5e9",
  "#f97316",
  "#10b981",
  "#a855f7",
  "#ef4444",
  "#eab308",
  "#06b6d4",
  "#ec4899",
  "#14b8a6",
  "#f59e0b",
  "#6366f1",
  "#84cc16",
];

export default function SpotlightPanel({ isAdmin }: SpotlightPanelProps) {
  const [periods, setPeriods] = useState<BellPeriod[]>([]);
  // True when `periods` was synthesized (no bell schedule configured for the
  // current school, or impersonation landed us in a school without one). The
  // dropdown still works — `/api/teacher-roster?period=N` doesn't depend on
  // a bell schedule — but we want to label the periods differently and skip
  // the time-of-day auto-detect.
  const [periodsAreSynthetic, setPeriodsAreSynthetic] = useState(false);
  const [activePeriod, setActivePeriod] = useState<number | null>(null);
  const [roster, setRoster] = useState<RosterStudent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [skipIds, setSkipIds] = useState<string[]>([]);
  const [spin, setSpin] = useState<SpinState>({ kind: "idle" });
  const [promptsModalOpen, setPromptsModalOpen] = useState(false);
  const [animStyle, setAnimStyle] = useState<AnimStyle>(() => {
    if (typeof window === "undefined") return "wheel";
    const saved = window.localStorage.getItem(STYLE_STORAGE_KEY);
    return saved === "bottles" ? "bottles" : "wheel";
  });
  // Wheel rotation accumulates so the wheel keeps spinning the same
  // direction across multiple picks rather than snapping back to 0.
  const [wheelRotation, setWheelRotation] = useState(0);
  const animTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- Admin "Test as teacher" override --------------------------------
  // Lets an admin (or any core-team member) pick any teacher in the school
  // and run Spotlight against THAT teacher's roster. The server already
  // accepts ?teacherId= on /api/teacher-roster for core-team callers, so
  // this is a pure client-side override — no impersonation, no school
  // switching, no bell-schedule changes. Cleared by setting back to "".
  // Only rendered when isAdmin is true. We intentionally don't gate the
  // feature on the period override either — admins can pick "any teacher,
  // any period" and the roster call uses both. (Non-admins never see this
  // row, so the existing "this teacher's current period" UX is unchanged.)
  const [teacherList, setTeacherList] = useState<TeacherOpt[]>([]);
  const [teacherOverride, setTeacherOverride] = useState<number | "">("");
  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch("/api/teacher-roster/teachers", {
          credentials: "include",
        });
        if (!res.ok) return;
        const data = (await res.json()) as { teachers?: TeacherOpt[] };
        if (!cancelled) setTeacherList(data.teachers ?? []);
      } catch {
        // best-effort; admin override stays empty if fetch fails
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STYLE_STORAGE_KEY, animStyle);
    }
  }, [animStyle]);

  // Detect current period from the school's default bell schedule. The
  // server already has the matching helper but we mirror the light bit
  // here so the UI can show "Period 3" without a round-trip first.
  useEffect(() => {
    let cancelled = false;
    // Synthesize Periods 1–7 as a universal fallback. Used whenever the
    // school has no default bell schedule, the endpoint errors, or the
    // response comes back with zero periods. Crucial so Spotlight stays
    // usable when impersonating teachers in schools without a configured
    // schedule (and for after-hours testing in any school). The roster
    // query by period_number works without a bell schedule.
    function synthesize() {
      const synthetic: BellPeriod[] = Array.from({ length: 7 }, (_, i) => ({
        periodNumber: i + 1,
        name: `Period ${i + 1}`,
        startTime: "",
        endTime: "",
      }));
      setPeriods(synthetic);
      setPeriodsAreSynthetic(true);
      setActivePeriod(1);
    }
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await authFetch("/api/bell-schedules/active", {
          credentials: "include",
        });
        if (!res.ok) {
          if (!cancelled) synthesize();
          return;
        }
        const data = (await res.json()) as { periods?: BellPeriod[] };
        if (cancelled) return;
        const ps = (data.periods ?? [])
          .slice()
          .sort((a, b) => a.periodNumber - b.periodNumber);
        if (ps.length === 0) {
          synthesize();
        } else {
          setPeriods(ps);
          setPeriodsAreSynthetic(false);
          const now = new Date();
          const hh = String(now.getHours()).padStart(2, "0");
          const mm = String(now.getMinutes()).padStart(2, "0");
          const nowHm = `${hh}:${mm}`;
          const live = ps.find(
            (p) => nowHm >= p.startTime && nowHm < p.endTime,
          );
          setActivePeriod(live?.periodNumber ?? ps[0]?.periodNumber ?? null);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load");
          synthesize();
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Reload the roster whenever the chosen period changes. Reset skip list
  // too — "absent" is per-class-session.
  useEffect(() => {
    if (activePeriod == null) {
      setRoster([]);
      return;
    }
    let cancelled = false;
    setSkipIds([]);
    setSpin({ kind: "idle" });
    (async () => {
      try {
        const teacherQs =
          teacherOverride !== ""
            ? `&teacherId=${encodeURIComponent(String(teacherOverride))}`
            : "";
        const res = await authFetch(
          `/api/teacher-roster?period=${encodeURIComponent(String(activePeriod))}${teacherQs}`,
          { credentials: "include" },
        );
        if (!res.ok) {
          // Surface the actual failure so we can debug — silent empty
          // pools are confusing during impersonation/after-hours testing.
          const body = await res.text().catch(() => "");
          if (!cancelled) {
            setRoster([]);
            setError(
              `Roster fetch failed (${res.status}): ${body.slice(0, 200) || "no body"}`,
            );
          }
          return;
        }
        const data = (await res.json()) as {
          students?: RosterStudent[];
          rows?: RosterStudent[];
        };
        const list = data.students ?? data.rows ?? [];
        if (!cancelled) setRoster(list);
      } catch (e) {
        if (!cancelled) {
          setRoster([]);
          setError(
            `Roster fetch error: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activePeriod, teacherOverride]);

  // Eligible roster excludes the per-session absent list — that's also
  // what the wheel and bottle row should display so the teacher doesn't
  // see a wedge for a kid who isn't there.
  const eligibleRoster = useMemo(
    () =>
      roster.filter(
        (r) => !skipIds.includes(r.studentId.toUpperCase()),
      ),
    [roster, skipIds],
  );

  function clearAnimTimer() {
    if (animTimerRef.current) {
      clearTimeout(animTimerRef.current);
      animTimerRef.current = null;
    }
  }
  useEffect(() => () => clearAnimTimer(), []);

  // Pick a stable subset of bottles that includes the winner. Six bottles
  // is the visual sweet spot — fits a phone screen, gives the eye enough
  // candidates to feel "random" without becoming a wall of bottles.
  function buildBottleSlots(
    pool: RosterStudent[],
    winnerId: string,
  ): RosterStudent[] {
    const SLOT_COUNT = 6;
    const winner = pool.find(
      (s) => s.studentId.toUpperCase() === winnerId.toUpperCase(),
    );
    if (!winner) return pool.slice(0, SLOT_COUNT);
    if (pool.length <= SLOT_COUNT) {
      // Shuffle so the winner isn't always in the same slot.
      const shuffled = [...pool].sort(() => Math.random() - 0.5);
      // Make sure winner is still present after shuffle (it always is —
      // shuffle is in-place membership preserving — but be explicit).
      return shuffled;
    }
    const others = pool.filter(
      (s) => s.studentId.toUpperCase() !== winnerId.toUpperCase(),
    );
    const sample = others
      .sort(() => Math.random() - 0.5)
      .slice(0, SLOT_COUNT - 1);
    const all = [...sample, winner].sort(() => Math.random() - 0.5);
    return all;
  }

  // `overrideSkipIds` exists so callers (specifically markAbsentAndRepick)
  // can hand us the freshly-updated skip list rather than relying on the
  // closure's stale `skipIds`. Without this, the just-marked-absent
  // student could still appear in the next request because React's
  // `setSkipIds` is async and `pick` would otherwise close over the
  // pre-update value.
  async function pick(overrideSkipIds?: string[]) {
    const effectiveSkip = overrideSkipIds ?? skipIds;
    const skipSet = new Set(effectiveSkip.map((s) => s.toUpperCase()));
    const effectiveCandidates = roster
      .map((r) => r.studentId)
      .filter((id) => !skipSet.has(id.toUpperCase()));
    if (effectiveCandidates.length === 0) {
      setError(
        "No students in the current-period roster. Pick a different period or check your class schedule.",
      );
      return;
    }
    setError(null);
    clearAnimTimer();
    setSpin({ kind: "loading" });

    try {
      const res = await authFetch("/api/spotlight/pick", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          candidateStudentIds: effectiveCandidates,
          skipStudentIds: effectiveSkip,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSpin({ kind: "idle" });
        setError(body.error ?? `Pick failed (${res.status})`);
        return;
      }
      const result = body as PickResult;
      const winnerId = result.pick.studentId.toUpperCase();
      // Animation indices need to match what the user is *about to see*,
      // which is the roster minus the effective skip list — same set the
      // server picked from. Computing this from `eligibleRoster` would
      // be stale during the markAbsentAndRepick flow.
      const animationRoster = roster.filter(
        (r) => !skipSet.has(r.studentId.toUpperCase()),
      );
      let bottleSlots: RosterStudent[] | undefined;
      let targetIndex: number;
      if (animStyle === "wheel") {
        targetIndex = animationRoster.findIndex(
          (r) => r.studentId.toUpperCase() === winnerId,
        );
        if (targetIndex < 0) targetIndex = 0;
        // Compute new accumulated rotation so the winning wedge stops
        // under the pointer at the top. Wedges are drawn starting at
        // 12 o'clock and going clockwise; the wheel itself spins
        // clockwise too, so we rotate by N full turns + (360 - centerOfWedge).
        const n = animationRoster.length;
        const wedge = n > 0 ? 360 / n : 360;
        const centerOfWedge = (targetIndex + 0.5) * wedge;
        // Random jitter inside the wedge so it doesn't always land
        // dead-center (more believable as a "physical" wheel).
        const jitter = (Math.random() - 0.5) * wedge * 0.7;
        const turns = 5; // "five fat turns" reads as a real spin
        const target = turns * 360 + (360 - centerOfWedge) + jitter;
        // Accumulate so we keep spinning the same direction.
        setWheelRotation((prev) => prev + target);
      } else {
        bottleSlots = buildBottleSlots(animationRoster, winnerId);
        targetIndex = bottleSlots.findIndex(
          (s) => s.studentId.toUpperCase() === winnerId,
        );
        if (targetIndex < 0) targetIndex = 0;
      }
      setSpin({
        kind: "animating",
        pick: result,
        targetIndex,
        bottleSlots,
      });
      animTimerRef.current = setTimeout(() => {
        setSpin({ kind: "result", pick: result });
      }, ANIM_DURATION_MS);
    } catch (e) {
      setSpin({ kind: "idle" });
      setError(e instanceof Error ? e.message : "Pick failed");
    }
  }

  async function rerollPrompt() {
    if (spin.kind !== "result") return;
    try {
      const res = await authFetch("/api/spotlight/prompt", {
        credentials: "include",
      });
      if (!res.ok) return;
      const body = (await res.json()) as {
        prompt: { id: number; text: string } | null;
      };
      setSpin({
        kind: "result",
        pick: { ...spin.pick, prompt: body.prompt },
      });
    } catch {
      // ignore
    }
  }

  function markAbsentAndRepick() {
    if (spin.kind !== "result") return;
    const id = spin.pick.pick.studentId.toUpperCase();
    // Build the next skip list synchronously so we can hand it to
    // `pick` directly — relying on the post-render `skipIds` would race
    // with React's async state updates and the just-absent student
    // could be re-picked.
    const nextSkip = skipIds.includes(id) ? skipIds : [...skipIds, id];
    setSkipIds(nextSkip);
    setSpin({ kind: "idle" });
    void pick(nextSkip);
  }

  function reset() {
    clearAnimTimer();
    setSpin({ kind: "idle" });
  }

  return (
    <div style={{ padding: "1.25rem", maxWidth: 760, margin: "0 auto" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "0.5rem",
          gap: "0.75rem",
          flexWrap: "wrap",
        }}
      >
        <div>
          <h2 style={{ margin: 0 }}>Spotlight</h2>
          <div style={{ fontSize: "0.85rem", opacity: 0.7 }}>
            Fair, random call-on for your current-period class.
          </div>
        </div>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <div className="spotlight-style-toggle" role="group" aria-label="Animation style">
            <button
              type="button"
              onClick={() => setAnimStyle("wheel")}
              className={animStyle === "wheel" ? "active" : ""}
              title="Spinning wheel"
            >
              🎡 Wheel
            </button>
            <button
              type="button"
              onClick={() => setAnimStyle("bottles")}
              className={animStyle === "bottles" ? "active" : ""}
              title="Water-bottle flip"
            >
              🥤 Bottles
            </button>
          </div>
          {isAdmin && (
            <button
              type="button"
              onClick={() => setPromptsModalOpen(true)}
              style={{
                background: "transparent",
                border: "1px solid #cbd5e1",
                borderRadius: 8,
                padding: "0.45rem 0.75rem",
                fontSize: "0.85rem",
                cursor: "pointer",
              }}
            >
              ⚙ Prompts
            </button>
          )}
        </div>
      </div>

      {isAdmin && (
        <div
          className="card"
          style={{
            padding: "0.75rem 1rem",
            display: "flex",
            gap: "0.75rem",
            alignItems: "center",
            flexWrap: "wrap",
            marginBottom: "0.75rem",
            background: "#fef3c7",
            border: "1px solid #fcd34d",
          }}
        >
          <div style={{ fontWeight: 600, fontSize: "0.85rem" }}>
            Admin test mode:
          </div>
          <select
            value={teacherOverride}
            onChange={(e) =>
              setTeacherOverride(
                e.target.value === "" ? "" : Number(e.target.value),
              )
            }
            style={{
              padding: "0.4rem 0.6rem",
              borderRadius: 8,
              border: "1px solid #cbd5e1",
              minWidth: 220,
            }}
          >
            <option value="">My own roster (default)</option>
            {teacherList.map((t) => (
              <option key={t.id} value={t.id}>
                {t.displayName ?? `Staff #${t.id}`}
              </option>
            ))}
          </select>
          {teacherOverride !== "" && (
            <button
              type="button"
              onClick={() => setTeacherOverride("")}
              style={{
                padding: "0.3rem 0.6rem",
                borderRadius: 6,
                border: "1px solid #cbd5e1",
                background: "white",
                cursor: "pointer",
                fontSize: "0.8rem",
              }}
            >
              Clear
            </button>
          )}
          <div
            style={{
              fontSize: "0.75rem",
              opacity: 0.75,
              fontStyle: "italic",
              flexBasis: "100%",
            }}
          >
            Pick any teacher + period to preview Spotlight against their
            roster. Useful for testing outside school hours. Picks still
            count toward the no-repeat tail.
          </div>
        </div>
      )}

      <div
        className="card"
        style={{
          padding: "1rem",
          display: "flex",
          gap: "0.75rem",
          alignItems: "center",
          flexWrap: "wrap",
          marginBottom: "1rem",
        }}
      >
        <div style={{ fontWeight: 600 }}>Period:</div>
        {periods.length === 0 ? (
          <div style={{ fontSize: "0.85rem", opacity: 0.7 }}>
            {loading ? "Loading bell schedule…" : "No periods available."}
          </div>
        ) : (
          <select
            value={activePeriod ?? ""}
            onChange={(e) => setActivePeriod(Number(e.target.value))}
            style={{
              padding: "0.4rem 0.6rem",
              borderRadius: 8,
              border: "1px solid #cbd5e1",
            }}
          >
            {periods.map((p) => (
              <option key={p.periodNumber} value={p.periodNumber}>
                {periodsAreSynthetic
                  ? `Period ${p.periodNumber}`
                  : `Period ${p.periodNumber} (${p.startTime}–${p.endTime})`}
              </option>
            ))}
          </select>
        )}
        {periodsAreSynthetic && (
          <div
            style={{
              fontSize: "0.75rem",
              opacity: 0.7,
              fontStyle: "italic",
            }}
            title="No bell schedule is configured for this school, so Spotlight is using a generic 1–7 list. Roster lookup by period still works."
          >
            (no schedule — generic periods)
          </div>
        )}
        <div
          style={{
            marginLeft: "auto",
            fontSize: "0.85rem",
            opacity: 0.75,
          }}
        >
          {eligibleRoster.length} student
          {eligibleRoster.length === 1 ? "" : "s"} in pool
          {skipIds.length > 0 ? ` · ${skipIds.length} marked absent` : ""}
        </div>
      </div>

      <div
        className="card spotlight-stage"
        style={{
          padding: "1.5rem 1rem",
          textAlign: "center",
          minHeight: 420,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "1rem",
        }}
      >
        {spin.kind === "result" ? (
          <ResultCard
            pick={spin.pick}
            onPickAgain={() => void pick()}
            onReroll={() => void rerollPrompt()}
            onAbsentAndRepick={markAbsentAndRepick}
            onDone={reset}
          />
        ) : animStyle === "wheel" ? (
          <Wheel
            roster={eligibleRoster}
            rotation={wheelRotation}
            spinning={spin.kind === "animating" || spin.kind === "loading"}
            onPick={() => void pick()}
            disabled={
              eligibleRoster.length === 0 ||
              spin.kind === "loading" ||
              spin.kind === "animating"
            }
            statusLabel={
              spin.kind === "loading"
                ? "Loading…"
                : spin.kind === "animating"
                  ? "Spinning…"
                  : null
            }
          />
        ) : (
          <Bottles
            slots={
              spin.kind === "animating" && spin.bottleSlots
                ? spin.bottleSlots
                : eligibleRoster.slice(0, 6)
            }
            winnerIndex={
              spin.kind === "animating" ? spin.targetIndex : -1
            }
            spinning={spin.kind === "animating" || spin.kind === "loading"}
            onPick={() => void pick()}
            disabled={
              eligibleRoster.length === 0 ||
              spin.kind === "loading" ||
              spin.kind === "animating"
            }
            statusLabel={
              spin.kind === "loading"
                ? "Loading…"
                : spin.kind === "animating"
                  ? "Flip!"
                  : null
            }
          />
        )}

        {skipIds.length > 0 && spin.kind === "idle" && (
          <button
            type="button"
            onClick={() => setSkipIds([])}
            style={{
              background: "transparent",
              border: "none",
              color: "#1d4ed8",
              fontSize: "0.85rem",
              cursor: "pointer",
              textDecoration: "underline",
            }}
          >
            Reset absent list ({skipIds.length})
          </button>
        )}
      </div>

      {error && (
        <div
          style={{
            marginTop: "0.75rem",
            padding: "0.65rem 0.85rem",
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#991b1b",
            borderRadius: 8,
            fontSize: "0.9rem",
          }}
        >
          {error}
        </div>
      )}

      {promptsModalOpen && (
        <PromptsManagerModal onClose={() => setPromptsModalOpen(false)} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Wheel
// ---------------------------------------------------------------------------

interface WheelProps {
  roster: RosterStudent[];
  rotation: number;
  spinning: boolean;
  onPick: () => void;
  disabled: boolean;
  statusLabel: string | null;
}

function Wheel({
  roster,
  rotation,
  spinning,
  onPick,
  disabled,
  statusLabel,
}: WheelProps) {
  const n = roster.length;
  const cx = 200;
  const cy = 200;
  const r = 195;
  const wedge = n > 0 ? 360 / n : 360;

  return (
    <div className="spotlight-wheel-wrap">
      <div className="spotlight-wheel-pointer" aria-hidden />
      <div className="spotlight-wheel-container">
        <svg
          viewBox="0 0 400 400"
          className="spotlight-wheel"
          style={{
            transform: `rotate(${rotation}deg)`,
            transition: spinning
              ? `transform ${ANIM_DURATION_MS}ms cubic-bezier(0.18, 0.7, 0.21, 1)`
              : "none",
          }}
        >
          {n === 0 ? (
            <circle cx={cx} cy={cy} r={r} fill="#e2e8f0" />
          ) : (
            roster.map((s, i) => {
              const startAngle = i * wedge - 90;
              const endAngle = startAngle + wedge;
              const startRad = (startAngle * Math.PI) / 180;
              const endRad = (endAngle * Math.PI) / 180;
              const x1 = cx + r * Math.cos(startRad);
              const y1 = cy + r * Math.sin(startRad);
              const x2 = cx + r * Math.cos(endRad);
              const y2 = cy + r * Math.sin(endRad);
              const largeArc = wedge > 180 ? 1 : 0;
              const path = `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z`;
              const midAngle = startAngle + wedge / 2;
              const midRad = (midAngle * Math.PI) / 180;
              const labelDist = r * 0.66;
              const lx = cx + labelDist * Math.cos(midRad);
              const ly = cy + labelDist * Math.sin(midRad);
              const color = WHEEL_COLORS[i % WHEEL_COLORS.length];
              const fname = (s.firstName ?? s.studentId).slice(0, 10);
              // Text rotation: align with the wedge's radial direction,
              // then auto-flip if it'd be upside down.
              let textRotation = midAngle;
              if (textRotation > 90 && textRotation < 270) {
                textRotation += 180;
              }
              // Hide labels when wedges become too small to read.
              const showLabel = wedge >= 9;
              const fontSize = wedge >= 30 ? 16 : wedge >= 15 ? 13 : 11;
              return (
                <g key={s.studentId}>
                  <path
                    d={path}
                    fill={color}
                    stroke="white"
                    strokeWidth="1.5"
                  />
                  {showLabel && (
                    <text
                      x={lx}
                      y={ly}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      transform={`rotate(${textRotation} ${lx} ${ly})`}
                      fontSize={fontSize}
                      fontWeight={700}
                      fill="white"
                      style={{
                        paintOrder: "stroke",
                        stroke: "rgba(0,0,0,0.18)",
                        strokeWidth: 2,
                      }}
                    >
                      {fname}
                    </text>
                  )}
                </g>
              );
            })
          )}
          <circle
            cx={cx}
            cy={cy}
            r={26}
            fill="white"
            stroke="#1e293b"
            strokeWidth="3"
          />
          <circle cx={cx} cy={cy} r={10} fill="#1e293b" />
        </svg>
      </div>
      <button
        type="button"
        onClick={onPick}
        disabled={disabled}
        className="spotlight-spin-btn"
      >
        {statusLabel ?? "Spin the wheel"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bottle flip
// ---------------------------------------------------------------------------

interface BottlesProps {
  slots: RosterStudent[];
  winnerIndex: number;
  spinning: boolean;
  onPick: () => void;
  disabled: boolean;
  statusLabel: string | null;
}

function Bottles({
  slots,
  winnerIndex,
  spinning,
  onPick,
  disabled,
  statusLabel,
}: BottlesProps) {
  // Pre-computed per-slot animation parameters so each "miss" looks
  // distinct (different toss height, different end position, different
  // rotation count). Stable across renders so the animation doesn't
  // jitter when state updates.
  const params = useMemo(
    () =>
      slots.map((_, i) => {
        const dir = i % 2 === 0 ? -1 : 1;
        const lateralBase = 140 + (i * 37) % 130;
        return {
          midX: dir * (40 + (i * 13) % 60),
          midY: -(160 + (i * 29) % 80),
          endX: dir * lateralBase,
          endY: 80,
          spins: 540 + (i * 137) % 360, // total rotation in degrees
        };
      }),
    [slots],
  );

  return (
    <div className="spotlight-bottles-wrap">
      <div className="spotlight-table" aria-hidden />
      <div className="spotlight-bottles-row">
        {slots.length === 0 ? (
          <div style={{ opacity: 0.6 }}>No students in the pool</div>
        ) : (
          slots.map((s, i) => {
            const p = params[i];
            const isWinner = spinning && i === winnerIndex;
            const cls = spinning
              ? isWinner
                ? "spotlight-bottle bottle-winner"
                : "spotlight-bottle bottle-miss"
              : "spotlight-bottle";
            const style: React.CSSProperties & Record<string, string> = {
              ["--mid-x"]: `${p.midX}px`,
              ["--mid-y"]: `${p.midY}px`,
              ["--end-x"]: `${p.endX}px`,
              ["--end-y"]: `${p.endY}px`,
              ["--end-rot"]: `${p.spins}deg`,
            };
            return (
              <div key={s.studentId} className={cls} style={style}>
                <div className="bottle-cap" />
                <div className="bottle-body">
                  <div className="bottle-label">
                    {(s.firstName ?? s.studentId).slice(0, 12)}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
      <button
        type="button"
        onClick={onPick}
        disabled={disabled}
        className="spotlight-spin-btn"
      >
        {statusLabel ?? "Flip the bottles"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Result card
// ---------------------------------------------------------------------------

interface ResultCardProps {
  pick: PickResult;
  onPickAgain: () => void;
  onReroll: () => void;
  onAbsentAndRepick: () => void;
  onDone: () => void;
}

function ResultCard({
  pick,
  onPickAgain,
  onReroll,
  onAbsentAndRepick,
  onDone,
}: ResultCardProps) {
  return (
    <div className="spotlight-result">
      <div className="spotlight-result-eyebrow">🎉 Spotlight</div>
      <div className="spotlight-result-name">
        {pick.pick.firstName ?? pick.pick.studentId}{" "}
        {pick.pick.lastName ?? ""}
      </div>
      {pick.prompt && (
        <div className="spotlight-result-prompt">{pick.prompt.text}</div>
      )}
      <div className="spotlight-result-actions">
        <button
          type="button"
          onClick={onDone}
          className="spotlight-result-btn primary"
        >
          Got it!
        </button>
        <button
          type="button"
          onClick={onPickAgain}
          className="spotlight-result-btn"
        >
          Pick again
        </button>
        <button
          type="button"
          onClick={onReroll}
          className="spotlight-result-btn"
        >
          New prompt
        </button>
        <button
          type="button"
          onClick={onAbsentAndRepick}
          className="spotlight-result-btn"
        >
          They're absent — re-pick
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Prompts manager (admin-only)
// ---------------------------------------------------------------------------

function PromptsManagerModal({ onClose }: { onClose: () => void }) {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [loading, setLoading] = useState(true);
  const [newText, setNewText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [savingNew, setSavingNew] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const res = await authFetch("/api/spotlight/prompts", {
        credentials: "include",
      });
      if (res.ok) {
        const body = (await res.json()) as { prompts: Prompt[] };
        setPrompts(body.prompts);
      }
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function add() {
    if (!newText.trim()) return;
    setSavingNew(true);
    setError(null);
    try {
      const res = await authFetch("/api/spotlight/prompts", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: newText.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? `Failed (${res.status})`);
        return;
      }
      setNewText("");
      await load();
    } finally {
      setSavingNew(false);
    }
  }

  async function toggle(p: Prompt) {
    await authFetch(`/api/spotlight/prompts/${p.id}`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !p.active }),
    });
    await load();
  }

  async function remove(p: Prompt) {
    if (!confirm(`Delete prompt: "${p.text}"?`)) return;
    await authFetch(`/api/spotlight/prompts/${p.id}`, {
      method: "DELETE",
      credentials: "include",
    });
    await load();
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1rem",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#fff",
          borderRadius: 12,
          width: "min(640px, 95vw)",
          maxHeight: "85vh",
          overflowY: "auto",
          padding: "1.25rem",
          boxShadow: "0 20px 50px rgba(0,0,0,0.3)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "0.75rem",
          }}
        >
          <h3 style={{ margin: 0 }}>Spotlight prompts</h3>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              fontSize: "1.4rem",
              cursor: "pointer",
              lineHeight: 1,
            }}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div
          style={{
            fontSize: "0.85rem",
            opacity: 0.7,
            marginBottom: "0.75rem",
          }}
        >
          One of these is shown alongside the picked student's name. Inactive
          prompts are kept but never drawn.
        </div>
        <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
          <input
            type="text"
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            placeholder="Add a new prompt…"
            style={{
              flex: 1,
              padding: "0.55rem 0.7rem",
              border: "1px solid #cbd5e1",
              borderRadius: 8,
              fontSize: "0.95rem",
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void add();
            }}
          />
          <button
            type="button"
            onClick={() => void add()}
            disabled={savingNew || !newText.trim()}
            style={{
              background: "#1d4ed8",
              color: "#fff",
              border: "none",
              borderRadius: 8,
              padding: "0.55rem 1rem",
              fontWeight: 600,
              cursor: savingNew || !newText.trim() ? "not-allowed" : "pointer",
              opacity: savingNew || !newText.trim() ? 0.6 : 1,
            }}
          >
            Add
          </button>
        </div>
        {error && (
          <div
            style={{
              marginBottom: "0.75rem",
              padding: "0.55rem 0.7rem",
              background: "#fef2f2",
              border: "1px solid #fecaca",
              color: "#991b1b",
              borderRadius: 8,
              fontSize: "0.85rem",
            }}
          >
            {error}
          </div>
        )}
        {loading ? (
          <div style={{ opacity: 0.6 }}>Loading…</div>
        ) : (
          prompts.map((p) => (
            <div
              key={p.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                padding: "0.55rem 0.65rem",
                background: p.active ? "#f8fafc" : "#fafafa",
                border: "1px solid #e5e7eb",
                borderRadius: 8,
                marginBottom: "0.4rem",
                opacity: p.active ? 1 : 0.55,
              }}
            >
              <div style={{ flex: 1, fontSize: "0.95rem" }}>{p.text}</div>
              <button
                type="button"
                onClick={() => void toggle(p)}
                style={{
                  background: "transparent",
                  border: "1px solid #cbd5e1",
                  borderRadius: 6,
                  padding: "0.3rem 0.55rem",
                  fontSize: "0.8rem",
                  cursor: "pointer",
                }}
              >
                {p.active ? "Disable" : "Enable"}
              </button>
              <button
                type="button"
                onClick={() => void remove(p)}
                style={{
                  background: "transparent",
                  border: "1px solid #ef4444",
                  color: "#ef4444",
                  borderRadius: 6,
                  padding: "0.3rem 0.55rem",
                  fontSize: "0.8rem",
                  cursor: "pointer",
                }}
              >
                Delete
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
