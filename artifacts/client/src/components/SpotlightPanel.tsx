import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import * as LucideIcons from "lucide-react";
import { authFetch } from "../lib/authToken";
import { HowToUseHelp, HowToSection, RoleSection, howtoListStyle } from "./HowToUseHelp";

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

interface HouseInfo {
  id: number;
  name: string;
  color: string;
  iconKey: string | null;
}

interface PickResult {
  pick: {
    studentId: string;
    firstName: string | null;
    lastName: string | null;
    house: HouseInfo | null;
  };
  prompt: { id: number; text: string } | null;
  poolSize: number;
}

// Mini house leaderboard row returned by /api/spotlight/award (and the
// initial /api/houses fetch). Sorted descending by totalPoints in the UI.
interface HouseTotal {
  id: number;
  name: string;
  color: string;
  iconKey: string | null;
  memberCount: number;
  totalPoints: number;
}

// Point-value chips. 10 is the "big swing" award for nailing a hard
// question; 1 is the participation pat. We keep the list small so the
// teacher's eye doesn't have to scan a long row mid-class.
const POINT_CHOICES = [1, 3, 5, 10] as const;
type PointChoice = (typeof POINT_CHOICES)[number];

type AnimStyle = "wheel" | "bottles" | "reel" | "spotlight";
const STYLE_STORAGE_KEY = "pulseedu.spotlight.style";

// Slot-reel layout constants. The strip is one long horizontal tape of
// names; the winner is forced into REEL_WINNER_INDEX so the strip can
// scroll a long way before stopping. Tweaking these affects how many
// names whiz past before the deceleration begins.
const REEL_TOTAL_SLOTS = 60;
const REEL_WINNER_INDEX = 50;
const REEL_SLOT_WIDTH = 160;
const REEL_VISIBLE_SLOTS = 5;

// Build a long, mostly-random strip of names with the winner forced into
// the late REEL_WINNER_INDEX position. The fillers are sampled from the
// pool with replacement — duplicates are fine, even desirable, because
// they read as "the reel is whirring past random names" rather than a
// curated list.
function buildReelSlots(
  pool: { studentId: string; firstName: string | null; lastName: string | null }[],
  winnerId: string,
) {
  if (pool.length === 0) return [];
  const winner = pool.find(
    (s) => s.studentId.toUpperCase() === winnerId.toUpperCase(),
  );
  if (!winner) return pool.slice(0, REEL_TOTAL_SLOTS);
  const slots = [];
  for (let i = 0; i < REEL_TOTAL_SLOTS; i++) {
    if (i === REEL_WINNER_INDEX) {
      slots.push(winner);
    } else {
      slots.push(pool[Math.floor(Math.random() * pool.length)]);
    }
  }
  return slots;
}
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
      // Long pre-built strip of names for the slot-reel animation. Winner
      // sits at a fixed index (`REEL_WINNER_INDEX`) so the strip can scroll
      // a long way before settling. Only set when animStyle === "reel".
      reelSlots?: RosterStudent[];
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
  // House standings — fetched once on mount but only RENDERED after the
  // first Correct! award of the session, so the picker stays minimal until
  // the teacher actually opts into the houses-game vibe. After that the
  // bar strip persists and animates on subsequent awards.
  const [houseTotals, setHouseTotals] = useState<HouseTotal[]>([]);
  const [showHouseBars, setShowHouseBars] = useState(false);
  // Tracks which house was just credited so its bar can flash + show
  // a floating "+N". Cleared by a short timer on the bar component.
  const [lastAward, setLastAward] = useState<{
    houseId: number | null;
    points: number;
    nonce: number;
  } | null>(null);
  // Toggle between fireworks-on (default) and silent. Persists per-device.
  const [fireworksEnabled, setFireworksEnabled] = useState(true);
  const [fireworksKey, setFireworksKey] = useState<number | null>(null);
  const [fireworksColor, setFireworksColor] = useState<string>("#fbbf24");

  // Teacher's chosen point value for the next Correct. Sticky across picks
  // — most teachers settle into one weight per warm-up. 5 is the default.
  const [pointChoice, setPointChoice] = useState<PointChoice>(5);
  const [awarding, setAwarding] = useState(false);
  const [awardError, setAwardError] = useState<string | null>(null);

  const [animStyle, setAnimStyle] = useState<AnimStyle>(() => {
    if (typeof window === "undefined") return "wheel";
    const saved = window.localStorage.getItem(STYLE_STORAGE_KEY);
    if (saved === "bottles" || saved === "reel" || saved === "spotlight") {
      return saved;
    }
    return "wheel";
  });
  // Wheel rotation accumulates so the wheel keeps spinning the same
  // direction across multiple picks rather than snapping back to 0.
  const [wheelRotation, setWheelRotation] = useState(0);
  const animTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track the auto-advance timeout so reset()/Done can cancel it before
  // it fires a stale `pick()` against an already-transitioned spin state.
  const awardAdvanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  // Mirror `spin` into a ref so the auto-advance closure can read the
  // *latest* state at fire time instead of the value captured at Correct.
  const spinRef = useRef<SpinState>({ kind: "idle" });

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

  // When the teacher switches animation style, wipe the last-picked
  // student card so the new picker starts fresh. Otherwise the old
  // winner sits on top of, say, the new wheel — confusing, and it
  // makes it look like nothing happened when they tap the new style.
  // Skip the very first run (style was just hydrated from localStorage,
  // there's no result to clear yet) by remembering the previous style.
  const prevStyleRef = useRef(animStyle);
  useEffect(() => {
    if (prevStyleRef.current === animStyle) return;
    prevStyleRef.current = animStyle;
    clearAnimTimer();
    setSpin({ kind: "idle" });
    setError(null);
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
      let reelSlots: RosterStudent[] | undefined;
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
      } else if (animStyle === "reel") {
        // Slot-reel: build a long strip of random fillers with the
        // winner forced into a known late position. The animation
        // scrolls the strip from slot 0 → slot REEL_WINNER_INDEX so
        // the eye sees a long deceleration before the winner lands
        // under the center pointer.
        reelSlots = buildReelSlots(animationRoster, winnerId);
        targetIndex = REEL_WINNER_INDEX;
      } else if (animStyle === "spotlight") {
        targetIndex = animationRoster.findIndex(
          (r) => r.studentId.toUpperCase() === winnerId,
        );
        if (targetIndex < 0) targetIndex = 0;
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
        reelSlots,
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
    if (awardAdvanceTimerRef.current !== null) {
      clearTimeout(awardAdvanceTimerRef.current);
      awardAdvanceTimerRef.current = null;
    }
    setSpin({ kind: "idle" });
    setAwardError(null);
  }

  // Keep the ref synced so the auto-advance closure inside awardCorrect
  // sees the live spin state and bails out if the teacher hit Done first.
  useEffect(() => {
    spinRef.current = spin;
  }, [spin]);

  // Cancel any pending auto-advance on unmount so a stray timer can't
  // call setState on an unmounted SpotlightPanel.
  useEffect(() => {
    return () => {
      if (awardAdvanceTimerRef.current !== null) {
        clearTimeout(awardAdvanceTimerRef.current);
        awardAdvanceTimerRef.current = null;
      }
    };
  }, []);

  // ---- Houses + Spotlight Correct! flow --------------------------------
  // Initial fetch of house totals so we can populate the bars instantly
  // when the first Correct! lands. We DON'T render the bars yet — the
  // teacher opts in by hitting Correct. Best-effort: a 401/network blip
  // just means the bars come up empty on the first award and refill on
  // the second.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch("/api/houses?windowDays=7", {
          credentials: "include",
        });
        if (!res.ok) return;
        const body = (await res.json()) as { houses?: HouseTotal[] };
        if (cancelled) return;
        setHouseTotals(body.houses ?? []);
      } catch {
        // best-effort
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function awardCorrect() {
    if (spin.kind !== "result") return;
    if (awarding) return;
    setAwarding(true);
    setAwardError(null);
    try {
      const studentIds = [spin.pick.pick.studentId];
      const res = await authFetch("/api/spotlight/award", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentIds, points: pointChoice }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAwardError(body.error ?? `Award failed (${res.status})`);
        return;
      }
      const updated = (body.houses ?? []) as HouseTotal[];
      setHouseTotals(updated);
      setShowHouseBars(true);
      const houseId = spin.pick.pick.house?.id ?? null;
      const color = spin.pick.pick.house?.color ?? "#fbbf24";
      setLastAward({ houseId, points: pointChoice, nonce: Date.now() });
      if (fireworksEnabled) {
        setFireworksColor(color);
        setFireworksKey(Date.now());
        playChime();
      }
      // Auto-advance after a short celebration window so the teacher can
      // get back to the rhythm of asking the next question. Long enough
      // for the fireworks burst (~1.5s) to land and the bar to spring.
      // Read state via spinRef so a Done/Skip click during the wait
      // cancels the implicit re-pick instead of firing it anyway.
      if (awardAdvanceTimerRef.current !== null) {
        clearTimeout(awardAdvanceTimerRef.current);
      }
      awardAdvanceTimerRef.current = setTimeout(() => {
        awardAdvanceTimerRef.current = null;
        if (spinRef.current.kind === "result") {
          void pick();
        }
      }, 2200);
    } catch (e) {
      setAwardError(e instanceof Error ? e.message : "Award failed");
    } finally {
      setAwarding(false);
    }
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
          <HowToUseHelp title="How to use Spotlight">
            <HowToSection title="What it does">
              Picks a fair, random student from your current-period
              roster. Excludes anyone already called on recently and
              anyone you've marked absent for this session — so the
              wheel doesn't waste a spin on a kid who isn't there.
            </HowToSection>
            <HowToSection title="Four animation styles">
              <ul style={howtoListStyle}>
                <li><strong>🎡 Wheel</strong> — classic spinning prize wheel; one wedge per student.</li>
                <li><strong>🥤 Bottles</strong> — water-bottle flip reveal; faster on phones.</li>
                <li><strong>🎰 Reel</strong> — slot-machine reel; names whiz past before settling under the pointer.</li>
                <li><strong>🔦 Spotlight</strong> — a roving spotlight sweeps the roster and lands on the winner.</li>
              </ul>
              Switch styles any time — the picker resets so the next pick starts fresh. Your choice is saved per-device.
            </HowToSection>
            <RoleSection for="teacher" title="Pairing with prompts">
              Each pick can show a prompt card from your school's
              prompt library. Use this for warm-up questions, PBIS
              shoutouts, or quick formative checks.
            </RoleSection>
          </HowToUseHelp>
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
            <button
              type="button"
              onClick={() => setAnimStyle("reel")}
              className={animStyle === "reel" ? "active" : ""}
              title="Slot reel"
            >
              🎰 Reel
            </button>
            <button
              type="button"
              onClick={() => setAnimStyle("spotlight")}
              className={animStyle === "spotlight" ? "active" : ""}
              title="Spotlight sweep"
            >
              🔦 Spotlight
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
            pointChoice={pointChoice}
            onPointChoice={setPointChoice}
            onCorrect={() => void awardCorrect()}
            awarding={awarding}
            awardError={awardError}
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
        ) : animStyle === "reel" ? (
          <Reel
            slots={
              spin.kind === "animating" && spin.reelSlots
                ? spin.reelSlots
                : eligibleRoster.slice(0, REEL_VISIBLE_SLOTS)
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
                  ? "Rolling…"
                  : null
            }
          />
        ) : animStyle === "spotlight" ? (
          <SpotlightSweep
            roster={eligibleRoster}
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
                  ? "Searching…"
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

      {showHouseBars && houseTotals.length > 0 && (
        <HouseBars
          houses={houseTotals}
          lastAward={lastAward}
        />
      )}

      {fireworksKey !== null && (
        <Fireworks key={fireworksKey} color={fireworksColor} />
      )}

      {/* The fireworks/chime opt-out only matters once the teacher has
          actually used Correct at least once this session — keeping it
          hidden until then preserves the goal that all celebration
          chrome appears post-first-Correct. */}
      {showHouseBars && (
        <div
          style={{
            marginTop: "0.75rem",
            display: "flex",
            alignItems: "center",
            gap: "0.6rem",
            fontSize: "0.8rem",
            opacity: 0.7,
          }}
        >
          <label
            style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}
          >
            <input
              type="checkbox"
              checked={fireworksEnabled}
              onChange={(e) => setFireworksEnabled(e.target.checked)}
            />
            Fireworks &amp; chime on Correct
          </label>
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
// Slot reel
// ---------------------------------------------------------------------------
// Casino-style horizontal reel: a long strip of names scrolls leftward
// past a fixed center pointer, decelerating into the winner. The strip
// is built upstream in `buildReelSlots` with the winner forced into
// REEL_WINNER_INDEX, so all this component does is translate the strip
// from "slot 0 centered" → "winner slot centered" with one fat
// ease-out cubic-bezier transition.

interface ReelProps {
  slots: RosterStudent[];
  winnerIndex: number;
  spinning: boolean;
  onPick: () => void;
  disabled: boolean;
  statusLabel: string | null;
}

function Reel({
  slots,
  winnerIndex,
  spinning,
  onPick,
  disabled,
  statusLabel,
}: ReelProps) {
  const windowWidth = REEL_SLOT_WIDTH * REEL_VISIBLE_SLOTS;
  // To put slot `i` under the center pointer the strip must translate
  // by (windowCenter − slotCenter). When idle, center slot 0 so the
  // reel doesn't appear shifted off-screen at rest.
  const startTx = windowWidth / 2 - REEL_SLOT_WIDTH / 2;
  const targetIdx = winnerIndex >= 0 ? winnerIndex : 0;
  const targetTx =
    windowWidth / 2 - targetIdx * REEL_SLOT_WIDTH - REEL_SLOT_WIDTH / 2;
  const tx = spinning ? targetTx : startTx;

  return (
    <div className="spotlight-reel-wrap">
      <div className="spotlight-reel-window" style={{ width: windowWidth }}>
        {/* Center highlight frame stays put; the strip slides under it. */}
        <div
          className="spotlight-reel-pointer"
          style={{ width: REEL_SLOT_WIDTH }}
          aria-hidden
        />
        <div
          className="spotlight-reel-strip"
          style={{
            transform: `translateX(${tx}px)`,
            transition: spinning
              ? `transform ${ANIM_DURATION_MS}ms cubic-bezier(0.15, 0.6, 0.15, 1)`
              : "none",
          }}
        >
          {slots.map((s, i) => (
            <div
              key={`${s.studentId}-${i}`}
              className="spotlight-reel-slot"
              style={{ width: REEL_SLOT_WIDTH }}
            >
              <div className="spotlight-reel-slot-name">
                {s.firstName ?? s.studentId}
              </div>
              {s.lastName && (
                <div className="spotlight-reel-slot-last">
                  {s.lastName[0]}.
                </div>
              )}
            </div>
          ))}
        </div>
        {/* Edge fades — the strip blurs out toward the sides so the
            speeding tape reads as motion rather than a discrete list. */}
        <div className="spotlight-reel-fade spotlight-reel-fade-l" aria-hidden />
        <div className="spotlight-reel-fade spotlight-reel-fade-r" aria-hidden />
      </div>
      <button
        type="button"
        onClick={onPick}
        disabled={disabled}
        className="spotlight-spin-btn"
      >
        {statusLabel ?? "Pull the lever"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Spotlight sweep
// ---------------------------------------------------------------------------
// Yearbook-style grid of names on a dark stage. A bright "spotlight"
// circle sweeps in a lazy path across the grid, finally settling on the
// winner cell. The winner cell brightens to gold late in the animation
// (via a delayed cell keyframe) so the audience sees the spotlight
// "lock on" rather than learning the answer up front.

interface SpotlightSweepProps {
  roster: RosterStudent[];
  winnerIndex: number;
  spinning: boolean;
  onPick: () => void;
  disabled: boolean;
  statusLabel: string | null;
}

function SpotlightSweep({
  roster,
  winnerIndex,
  spinning,
  onPick,
  disabled,
  statusLabel,
}: SpotlightSweepProps) {
  // Pick a sensible columns count. Square-ish but capped at 6 columns
  // so cells don't get too narrow on phones. Below 6 students we use
  // the roster size directly so we don't end up with empty cells.
  const cols = Math.min(
    6,
    roster.length <= 6 ? Math.max(1, roster.length) : Math.ceil(Math.sqrt(roster.length)),
  );
  const rows = Math.max(1, Math.ceil(roster.length / cols));
  const winnerCol = winnerIndex >= 0 ? winnerIndex % cols : 0;
  const winnerRow = winnerIndex >= 0 ? Math.floor(winnerIndex / cols) : 0;
  // Target cell center as a percentage of the stage (left/top accept %
  // relative to the parent, which is what we want for the cone overlay).
  const targetX = `${((winnerCol + 0.5) * 100) / cols}%`;
  const targetY = `${((winnerRow + 0.5) * 100) / rows}%`;

  return (
    <div className="spotlight-grid-wrap">
      <div className="spotlight-grid-stage">
        <div
          className="spotlight-grid"
          style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}
        >
          {roster.map((s, i) => (
            <div
              key={s.studentId}
              className={`spotlight-grid-cell${
                spinning && i === winnerIndex ? " is-winner-spot" : ""
              }`}
            >
              <div className="spotlight-grid-cell-first">
                {s.firstName ?? s.studentId}
              </div>
              {s.lastName && (
                <div className="spotlight-grid-cell-last">{s.lastName}</div>
              )}
            </div>
          ))}
        </div>
        {spinning && (
          <div
            className="spotlight-cone"
            style={
              {
                "--target-x": targetX,
                "--target-y": targetY,
              } as React.CSSProperties
            }
            aria-hidden
          />
        )}
      </div>
      <button
        type="button"
        onClick={onPick}
        disabled={disabled}
        className="spotlight-spin-btn"
      >
        {statusLabel ?? "Sweep the spotlight"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Result card
// ---------------------------------------------------------------------------

interface ResultCardProps {
  pick: PickResult;
  pointChoice: PointChoice;
  onPointChoice: (n: PointChoice) => void;
  onCorrect: () => void;
  awarding: boolean;
  awardError: string | null;
  onPickAgain: () => void;
  onReroll: () => void;
  onAbsentAndRepick: () => void;
  onDone: () => void;
}

function ResultCard({
  pick,
  pointChoice,
  onPointChoice,
  onCorrect,
  awarding,
  awardError,
  onPickAgain,
  onReroll,
  onAbsentAndRepick,
  onDone,
}: ResultCardProps) {
  const house = pick.pick.house;
  const fullName = `${pick.pick.firstName ?? pick.pick.studentId} ${
    pick.pick.lastName ?? ""
  }`.trim();
  return (
    <div className="spotlight-result" style={{ width: "100%" }}>
      <div className="spotlight-result-eyebrow">🎉 Spotlight</div>
      <div className="spotlight-result-name">{fullName}</div>

      {house ? (
        <HouseBadge house={house} />
      ) : (
        <div
          style={{
            fontSize: "0.8rem",
            opacity: 0.7,
            marginTop: "0.4rem",
            fontStyle: "italic",
          }}
          title="This student isn't assigned to a house yet — points will still be awarded, just not credited to a house."
        >
          (not yet in a house)
        </div>
      )}

      {pick.prompt && (
        <div className="spotlight-result-prompt">{pick.prompt.text}</div>
      )}

      {/* Point-value chips: small, sticky, easy to scan. */}
      <div
        style={{
          display: "flex",
          gap: "0.4rem",
          alignItems: "center",
          justifyContent: "center",
          marginTop: "0.85rem",
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontSize: "0.85rem", opacity: 0.75 }}>Worth</span>
        {POINT_CHOICES.map((n) => {
          const active = n === pointChoice;
          return (
            <button
              key={n}
              type="button"
              onClick={() => onPointChoice(n)}
              disabled={awarding}
              style={{
                background: active ? "#1d4ed8" : "#fff",
                color: active ? "#fff" : "#1e293b",
                border: active ? "1px solid #1d4ed8" : "1px solid #cbd5e1",
                borderRadius: 999,
                padding: "0.3rem 0.75rem",
                fontWeight: 600,
                fontSize: "0.9rem",
                minWidth: 44,
                cursor: awarding ? "not-allowed" : "pointer",
              }}
              aria-pressed={active}
            >
              {n} pt{n === 1 ? "" : "s"}
            </button>
          );
        })}
      </div>

      {/* Correct / Skip — the two big "decide now" buttons. */}
      <div
        style={{
          display: "flex",
          gap: "0.6rem",
          justifyContent: "center",
          marginTop: "0.85rem",
          flexWrap: "wrap",
        }}
      >
        <button
          type="button"
          onClick={onCorrect}
          disabled={awarding}
          style={{
            background: house?.color ?? "#16a34a",
            color: "#fff",
            border: "none",
            borderRadius: 12,
            padding: "0.7rem 1.4rem",
            fontWeight: 700,
            fontSize: "1.05rem",
            cursor: awarding ? "wait" : "pointer",
            boxShadow: "0 6px 16px rgba(0,0,0,0.18)",
            opacity: awarding ? 0.7 : 1,
            minWidth: 180,
          }}
        >
          {awarding
            ? "Awarding…"
            : `✅ Correct! +${pointChoice} pt${pointChoice === 1 ? "" : "s"}`}
        </button>
        <button
          type="button"
          onClick={onPickAgain}
          disabled={awarding}
          style={{
            background: "#fff",
            color: "#334155",
            border: "1px solid #cbd5e1",
            borderRadius: 12,
            padding: "0.7rem 1.1rem",
            fontWeight: 600,
            fontSize: "1rem",
            cursor: awarding ? "not-allowed" : "pointer",
          }}
        >
          Skip — pick next
        </button>
      </div>

      {awardError && (
        <div
          style={{
            marginTop: "0.65rem",
            color: "#991b1b",
            background: "#fef2f2",
            border: "1px solid #fecaca",
            borderRadius: 8,
            padding: "0.4rem 0.6rem",
            fontSize: "0.85rem",
          }}
        >
          {awardError}
        </div>
      )}

      {/* Secondary actions kept compact under the primary row so the
          original "absent / re-roll prompt / done" affordances remain
          accessible without competing visually with Correct/Skip. */}
      <div
        className="spotlight-result-actions"
        style={{ marginTop: "0.85rem" }}
      >
        <button
          type="button"
          onClick={onReroll}
          className="spotlight-result-btn"
        >
          New prompt
        </button>
        {/* "They're absent — re-pick" button hidden by user request.
            The handler (onAbsentAndRepick / markAbsentAndRepick) is left
            wired up so we can resurface this affordance trivially later
            without re-plumbing state. To restore: uncomment below.
        <button
          type="button"
          onClick={onAbsentAndRepick}
          className="spotlight-result-btn"
        >
          They're absent — re-pick
        </button>
        */}
        <button
          type="button"
          onClick={onDone}
          className="spotlight-result-btn"
        >
          Done
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// HouseBadge — colored chip with Lucide icon + house name. Falls back to
// the house's first letter inside a colored circle when iconKey is null
// or doesn't resolve to a known Lucide icon.
// ---------------------------------------------------------------------------

function HouseBadge({ house }: { house: HouseInfo }) {
  const Icon = resolveLucideIcon(house.iconKey);
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.5rem",
        background: house.color,
        color: "#fff",
        borderRadius: 999,
        padding: "0.35rem 0.85rem 0.35rem 0.4rem",
        marginTop: "0.5rem",
        fontWeight: 600,
        fontSize: "0.95rem",
        boxShadow: "0 2px 6px rgba(0,0,0,0.15)",
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 26,
          height: 26,
          borderRadius: "50%",
          background: "rgba(255,255,255,0.22)",
        }}
      >
        {Icon ? (
          <Icon size={16} strokeWidth={2.5} />
        ) : (
          <span style={{ fontSize: "0.85rem", fontWeight: 800 }}>
            {house.name.charAt(0).toUpperCase()}
          </span>
        )}
      </span>
      <span>House {house.name}</span>
    </div>
  );
}

// Resolve a Lucide icon name to a component, with a defensive cast since
// LucideIcons exposes many non-component exports (createLucideIcon, etc.).
// Returns null when the key is missing or doesn't map to a renderable
// component, so the badge can fall back to a letter avatar.
function resolveLucideIcon(
  key: string | null,
): React.ComponentType<{ size?: number; strokeWidth?: number }> | null {
  if (!key) return null;
  const all = LucideIcons as unknown as Record<string, unknown>;
  const candidate = all[key];
  if (typeof candidate === "function" || typeof candidate === "object") {
    return candidate as React.ComponentType<{
      size?: number;
      strokeWidth?: number;
    }>;
  }
  return null;
}

// ---------------------------------------------------------------------------
// HouseBars — mini leaderboard along the bottom of the Spotlight panel.
// Renders one bar per house, normalized so the leader is at 100%. The
// just-credited house gets a flash + floating "+N" overlay.
// ---------------------------------------------------------------------------

interface HouseBarsProps {
  houses: HouseTotal[];
  lastAward: { houseId: number | null; points: number; nonce: number } | null;
}

function HouseBars({ houses, lastAward }: HouseBarsProps) {
  const sorted = [...houses].sort((a, b) => b.totalPoints - a.totalPoints);
  const maxPoints = Math.max(1, ...sorted.map((h) => h.totalPoints));
  return (
    <div
      style={{
        marginTop: "1rem",
        background: "#fff",
        border: "1px solid #e2e8f0",
        borderRadius: 12,
        padding: "0.85rem 1rem",
        boxShadow: "0 2px 8px rgba(15,23,42,0.06)",
      }}
    >
      <div
        style={{
          fontSize: "0.75rem",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "#64748b",
          fontWeight: 700,
          marginBottom: "0.5rem",
        }}
      >
        House Standings
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.45rem" }}>
        {sorted.map((h) => {
          const pct = Math.round((h.totalPoints / maxPoints) * 100);
          const justCredited =
            lastAward !== null && lastAward.houseId === h.id;
          const Icon = resolveLucideIcon(h.iconKey);
          return (
            <div
              key={h.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.55rem",
                position: "relative",
              }}
            >
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 22,
                  height: 22,
                  borderRadius: "50%",
                  background: h.color,
                  color: "#fff",
                  flexShrink: 0,
                }}
              >
                {Icon ? (
                  <Icon size={13} strokeWidth={2.5} />
                ) : (
                  <span style={{ fontSize: "0.7rem", fontWeight: 800 }}>
                    {h.name.charAt(0).toUpperCase()}
                  </span>
                )}
              </span>
              <span
                style={{
                  fontSize: "0.85rem",
                  fontWeight: 600,
                  width: 80,
                  flexShrink: 0,
                }}
              >
                {h.name}
              </span>
              <div
                style={{
                  flex: 1,
                  height: 14,
                  background: "#f1f5f9",
                  borderRadius: 999,
                  overflow: "hidden",
                  position: "relative",
                }}
              >
                <motion.div
                  initial={false}
                  animate={{ width: `${pct}%` }}
                  transition={{ type: "spring", stiffness: 110, damping: 18 }}
                  style={{
                    height: "100%",
                    background: h.color,
                    borderRadius: 999,
                  }}
                />
              </div>
              <span
                style={{
                  fontSize: "0.85rem",
                  fontWeight: 700,
                  color: "#0f172a",
                  width: 56,
                  textAlign: "right",
                  flexShrink: 0,
                }}
              >
                {h.totalPoints.toLocaleString()}
              </span>
              <AnimatePresence>
                {justCredited && lastAward && (
                  <motion.div
                    key={lastAward.nonce}
                    initial={{ opacity: 0, y: 8, scale: 0.85 }}
                    animate={{ opacity: 1, y: -18, scale: 1 }}
                    exit={{ opacity: 0, y: -32 }}
                    transition={{ duration: 1.1 }}
                    style={{
                      position: "absolute",
                      right: 70,
                      top: -4,
                      pointerEvents: "none",
                      color: h.color,
                      fontWeight: 800,
                      fontSize: "1.1rem",
                      textShadow: "0 1px 2px rgba(255,255,255,0.9)",
                    }}
                  >
                    +{lastAward.points}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fireworks — short SVG burst overlay. Fixed-position, pointer-events
// none, auto-cleans by being unmounted via key change in the parent.
// 14 sparks fly out in evenly-spaced directions from the screen center,
// fade out over ~1.4s. Color comes from the house's hex.
// ---------------------------------------------------------------------------

function Fireworks({ color }: { color: string }) {
  const sparks = useMemo(() => {
    const N = 14;
    return Array.from({ length: N }, (_, i) => {
      const angle = (i / N) * Math.PI * 2;
      const dist = 120 + Math.random() * 80;
      return {
        dx: Math.cos(angle) * dist,
        dy: Math.sin(angle) * dist,
        delay: Math.random() * 0.05,
      };
    });
  }, []);
  return (
    <div
      aria-hidden
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        zIndex: 999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div style={{ position: "relative", width: 0, height: 0 }}>
        {sparks.map((s, i) => (
          <motion.div
            key={i}
            initial={{ x: 0, y: 0, opacity: 1, scale: 0.6 }}
            animate={{
              x: s.dx,
              y: s.dy,
              opacity: 0,
              scale: 1,
            }}
            transition={{ duration: 1.2, delay: s.delay, ease: "easeOut" }}
            style={{
              position: "absolute",
              width: 12,
              height: 12,
              borderRadius: "50%",
              background: color,
              boxShadow: `0 0 12px ${color}`,
            }}
          />
        ))}
        <motion.div
          initial={{ opacity: 0.7, scale: 0.4 }}
          animate={{ opacity: 0, scale: 2.4 }}
          transition={{ duration: 0.8, ease: "easeOut" }}
          style={{
            position: "absolute",
            width: 80,
            height: 80,
            left: -40,
            top: -40,
            borderRadius: "50%",
            background: color,
            filter: "blur(12px)",
          }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// playChime — short positive WebAudio "ding" played on Correct. Wrapped
// in a try/catch because some browsers block AudioContext outside of a
// user-gesture; we never want a missing chime to block the award flow.
// ---------------------------------------------------------------------------

function playChime() {
  try {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    const now = ctx.currentTime;
    // Two-note arpeggio: C5 → E5, fast ADSR. Triangle wave keeps it
    // friendly rather than the harsh sine-wave "alert" feel.
    [
      { freq: 523.25, start: 0 },
      { freq: 659.25, start: 0.09 },
    ].forEach(({ freq, start }) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now + start);
      gain.gain.linearRampToValueAtTime(0.18, now + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + start + 0.35);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + start);
      osc.stop(now + start + 0.4);
    });
    // Auto-close so we don't leak audio nodes if the teacher hits Correct
    // many times in a row. 600ms covers the longest oscillator above.
    window.setTimeout(() => void ctx.close().catch(() => undefined), 600);
  } catch {
    // best-effort
  }
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
