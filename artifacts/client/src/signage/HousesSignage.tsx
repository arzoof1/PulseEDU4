import { useEffect, useRef, useState } from "react";
import { Activity, Trophy, Filter, Users, Sparkles, Star } from "lucide-react";
import { usePolling, schoolIdFromUrl } from "./usePolling";

// =============================================================================
// HousesSignage — live "PBIS Houses" standings TV/kiosk screen.
// -----------------------------------------------------------------------------
// Adds the per-house mini-meter (positive vs negative count for the window)
// requested in the build plan, layered under each big house bar.  Uses the
// per-house brand color from the DB so admins can rebrand houses without
// touching code.  Polls every 30s.
// =============================================================================

interface HouseRow {
  id: number;
  name: string;
  color: string;
  motto: string | null;
  memberCount: number;
  totalPoints: number;
  weekPoints: number;
  positiveCount: number;
  negativeCount: number;
}

interface HousesPayload {
  schoolId: number;
  windowDays: number;
  houses: HouseRow[];
}

// Subset of the pulse-events payload — only what the houses screen needs.
interface PulseEventLite {
  id: string;
  kind: "positive" | "negative" | "neutral";
  source: "pbis" | "tardy" | "pullout" | "intervention";
  studentId: string;
  studentInitials: string;
  what: string;
  points: number | null;
  createdAt: string;
  // House of the awarded student — only present (non-null) for positive
  // PBIS events. Drives the rise-and-deliver sequencer on the bar that
  // matches this id.
  houseId: number | null;
}

interface EventsPayload {
  windowMinutes: number;
  events: PulseEventLite[];
}

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 30) return "just now";
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  return `${hr}h`;
}

function ScreenError({ message }: { message: string }) {
  return (
    <div className="min-h-screen w-full bg-slate-950 text-white grid place-items-center p-8">
      <div className="max-w-lg text-center space-y-3">
        <div className="text-6xl">📺</div>
        <div className="text-2xl font-bold">Houses signage paused</div>
        <div className="text-white/60">{message}</div>
        <div className="text-xs text-white/40 mt-4">
          Pass <code className="px-1 py-0.5 bg-white/10 rounded">?schoolId=N</code> in the URL to point this display at a school.
        </div>
      </div>
    </div>
  );
}

// "Stronger" gradient generated from the house's hex color so each bar
// looks distinct without needing per-house Tailwind classes.
function gradientFromColor(hex: string): string {
  return `linear-gradient(to top, ${hex} 0%, ${hex}cc 60%, ${hex}88 100%)`;
}

// =============================================================================
// CELEBRATION SEQUENCER — choreographed rise-and-deliver per award.
// -----------------------------------------------------------------------------
// One award at a time. Each new positive-PBIS event runs through three
// phases on its house's bar:
//
//   1. RISE   (RISE_MS)   — animation climbs the bar. Tile is hidden.
//   2. SHOW   (HOLD_MS)   — animation done; celebration tile is "delivered"
//                           at the top of the bar.
//   3. GAP    (GAP_MS)    — bar goes quiet; nothing on screen. Then the
//                           next queued event plays. This blank beat makes
//                           it unambiguous that the NEXT card is a new
//                           award, not a continuation of the previous one.
//
// Only ONE bar is ever active at a time, on the entire screen.
// =============================================================================
const RISE_MS = 1_300;
const HOLD_MS = 5_000;
const GAP_MS = 6_000;

function FeaturedPopup({
  event,
  barPct,
}: {
  event: PulseEventLite;
  // Height (in %) of the host bar's fill. We use this to keep the
  // popup visually attached to the TOP of the bar rather than the top
  // of the frame — otherwise the popup floats in empty space when the
  // bar is short (early in a school year, or first day after rollout).
  barPct: number;
}) {
  const e = event;
  // Bar fill top edge in % from frame top. We sit the popup ~12px below
  // that edge so it visually overlaps the top of the colored bar. If the
  // bar is very tall the popup must still leave room for the points label
  // (top-2 + top-8 = ~48px), so clamp the minimum.  And keep it well clear
  // of the frame bottom so the card never gets cut off.
  const barTopPct = Math.max(0, Math.min(100, 100 - barPct));
  const popupTop = `clamp(56px, calc(${barTopPct}% + 12px), calc(100% - 88px))`;

  return (
    <div
      key={e.id}
      className="absolute inset-x-3 rounded-2xl bg-white/95 text-slate-900 shadow-2xl ring-2 ring-amber-300 px-3 py-2 flex items-center gap-3 z-20 animate-[fadeIn_0.3s_ease-out]"
      style={{ top: popupTop, backdropFilter: "blur(6px)" }}
    >
      <div className="h-11 w-11 rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 grid place-items-center font-black text-white text-sm ring-2 ring-white/80 shrink-0">
        {e.studentInitials}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-amber-600 font-bold">
          <Sparkles className="h-3 w-3" />
          Now celebrating
        </div>
        <div className="text-sm font-bold truncate text-slate-900">{e.studentId}</div>
        <div className="text-[11px] text-slate-600 truncate">{e.what}</div>
      </div>
      <div className="text-right shrink-0">
        <div className="flex items-center gap-1 text-emerald-600">
          <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-500" />
          <span className="text-lg font-black tabular-nums">+{e.points ?? 0}</span>
        </div>
        <div className="text-[9px] text-slate-400 uppercase tracking-wider">
          {relativeTime(e.createdAt)} ago
        </div>
      </div>
    </div>
  );
}

// `schoolId` prop:
//  - omitted (default): legacy TV/kiosk behavior — read schoolId from the
//    URL query string. The screen runs unauthenticated so the explicit
//    schoolId is required.
//  - "session": in-app authenticated render. Drop schoolId from the URL
//    and let the API fall back to the logged-in user's school. This is
//    how the in-app "House Rankings" nav item embeds the same screen.
interface HousesSignageProps {
  schoolId?: number | "session";
}

export default function HousesSignage({ schoolId: schoolIdProp }: HousesSignageProps = {}) {
  const urlSchoolId = schoolIdFromUrl();
  const sessionMode = schoolIdProp === "session";
  const schoolId =
    typeof schoolIdProp === "number" ? schoolIdProp : urlSchoolId;
  const validSchool = sessionMode || (Number.isFinite(schoolId) && schoolId > 0);

  // Build the API URL with schoolId omitted in session mode so the server
  // falls back to req.schoolId from the cookie session — avoids leaking
  // the current schoolId into a query param the user could tamper with.
  const housesUrl = validSchool
    ? sessionMode
      ? `/api/houses?windowDays=7`
      : `/api/houses?schoolId=${schoolId}&windowDays=7`
    : null;
  const eventsUrl = validSchool
    ? sessionMode
      ? `/api/pulse/events?windowMinutes=120&limit=24`
      : `/api/pulse/events?schoolId=${schoolId}&windowMinutes=120&limit=24`
    : null;

  const houses = usePolling<HousesPayload>(housesUrl, 30_000);
  // Polled separately from /houses so the action feed and sequencer
  // queue refresh independently of the leaderboard math.
  const events = usePolling<EventsPayload>(eventsUrl, 30_000);

  // ---------------------------------------------------------------------------
  // SEQUENCER — one award at a time, choreographed.
  // ---------------------------------------------------------------------------
  // On first successful events poll we snapshot every existing event id as
  // "already seen" so historical events don't replay when the screen loads.
  // From then on, any new positive-PBIS event with a known houseId is
  // pushed onto `pendingRef`. A driver effect drains the queue in order:
  //
  //   idle → rising (RISE_MS) → showing (HOLD_MS) → idle (GAP_MS) → next
  //
  // Only one event is ever active. While idle, every bar is quiet.
  const seenIdsRef = useRef<Set<string>>(new Set());
  const seededRef = useRef(false);
  const pendingRef = useRef<PulseEventLite[]>([]);
  // True while a rise→show→gap sequence is in flight. Prevents the driver
  // effect from starting a second sequence on top of the first.
  const runningRef = useRef(false);
  const [active, setActive] = useState<{
    event: PulseEventLite;
    phase: "rising" | "showing";
  } | null>(null);
  // Bump on every new-event detection AND at the end of each sequence so
  // the driver effect wakes up to pick the next event.
  const [enqueueTick, setEnqueueTick] = useState(0);

  useEffect(() => {
    const list = events.data?.events ?? [];
    if (!seededRef.current) {
      // First poll after mount: mark everything we already have as seen so
      // we don't replay history. Only events that arrive on subsequent
      // polls will trigger a celebration sequence.
      for (const e of list) seenIdsRef.current.add(e.id);
      seededRef.current = true;
      return;
    }
    // Newest first → push oldest first so playback order matches arrival.
    const fresh: PulseEventLite[] = [];
    for (const e of list) {
      if (seenIdsRef.current.has(e.id)) continue;
      seenIdsRef.current.add(e.id);
      if (
        e.kind === "positive" &&
        e.source === "pbis" &&
        (e.points ?? 0) > 0 &&
        e.houseId != null
      ) {
        fresh.push(e);
      }
    }
    if (fresh.length === 0) return;
    fresh.reverse();
    pendingRef.current.push(...fresh);
    setEnqueueTick((t) => t + 1);
  }, [events.data]);

  useEffect(() => {
    // Single driver. Re-entrant safe via runningRef — re-firing while a
    // sequence is playing is a no-op. We deliberately do NOT return a
    // cleanup that cancels timers: tearing down mid-sequence would cancel
    // the phase transition and the celebration tile would never get
    // rendered. The signage screen is a long-lived display, so accepting
    // a tiny shutdown leak is the right trade.
    if (runningRef.current) return;
    const next = pendingRef.current.shift();
    if (!next) return;
    runningRef.current = true;
    setActive({ event: next, phase: "rising" });
    window.setTimeout(() => {
      // Rise complete — deliver the celebration tile.
      setActive({ event: next, phase: "showing" });
      window.setTimeout(() => {
        // Hold complete — clear the tile, then wait out the gap before
        // releasing the lock so the next event can play.
        setActive(null);
        window.setTimeout(() => {
          runningRef.current = false;
          setEnqueueTick((t) => t + 1);
        }, GAP_MS);
      }, HOLD_MS);
    }, RISE_MS);
  }, [enqueueTick]);

  if (!validSchool) {
    return <ScreenError message="No schoolId in the URL." />;
  }
  if (houses.loading) {
    return (
      <div className="min-h-screen w-full bg-slate-950 text-white grid place-items-center">
        <div className="flex items-center gap-3 text-white/60">
          <Activity className="h-5 w-5 animate-pulse" /> Loading house standings…
        </div>
      </div>
    );
  }
  if (houses.error && !houses.data) {
    return <ScreenError message={`Couldn't load houses (${houses.error}).`} />;
  }

  // Sort leaderboard-style so the leader sits on the left side of the screen.
  const rows = [...(houses.data?.houses ?? [])].sort(
    (a, b) => b.totalPoints - a.totalPoints,
  );
  // Dynamic goal: keeps bars visually meaningful regardless of how new the
  // PBIS rollout is. Leader always tops out around 80% of frame height so
  // there's still visible "room to grow" on the bar.
  const topPoints = rows.length > 0 ? rows[0].totalPoints : 0;
  const goal = Math.max(100, Math.ceil((topPoints * 1.25) / 50) * 50);
  const leader = rows[0] ?? null;

  // Action feed = most recent point-bearing events. We show positives AND
  // negatives in the strip so the screen reflects the whole house economy,
  // not just wins.
  const allEvents = events.data?.events ?? [];
  const recentForFeed = allEvents
    .filter((e) => typeof e.points === "number" && e.points !== 0)
    .slice(0, 6);
  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-white overflow-hidden relative">
      {/* In-bar "heartbeat" pulse: a soft glow blip that rises from the
          bottom of a house's vertical bar to the top whenever that
          house gains points. Replayed by remounting the node on a
          counter-bound key. Kept under 1s so back-to-back awards stack
          visually without queuing. */}
      <style>{`
        /* Dramatic rising "heartbeat": starts as a small spark anchored
           to the bottom of the bar, then climbs and inflates as it rises,
           culminating right under the name/points label at the top. The
           transform-origin is bottom-center so scaling grows outward and
           upward from the source point, giving a flame/plume shape. */
        @keyframes housePulseRise {
          0%   { transform: translateY(0%)    scale(0.10); opacity: 0; }
          12%  { transform: translateY(-8%)   scale(0.18); opacity: 1; }
          55%  { transform: translateY(-55%)  scale(0.55); opacity: 1; }
          85%  { transform: translateY(-92%)  scale(1.05); opacity: 0.95; }
          100% { transform: translateY(-100%) scale(1.30); opacity: 0; }
        }
        /* Arrival burst — a bright halo that blooms behind the name/points
           label exactly when the rising spark reaches the top. Times its
           peak around 80% so it overlaps the climax of the rise. */
        @keyframes housePulseBurst {
          0%, 55% { opacity: 0; transform: scale(0.45); }
          78%     { opacity: 1; transform: scale(1.25); }
          100%    { opacity: 0; transform: scale(2.00); }
        }
        @keyframes houseBarFlash {
          0%   { box-shadow: 0 0  50px -10px var(--bar-glow); }
          45%  { box-shadow: 0 0 130px  20px var(--bar-glow); }
          100% { box-shadow: 0 0  50px -10px var(--bar-glow); }
        }
      `}</style>
      <div
        className="absolute inset-0 opacity-[0.04] pointer-events-none"
        style={{ backgroundImage: "radial-gradient(circle at 1px 1px, white 1px, transparent 0)", backgroundSize: "24px 24px" }}
      />

      <header className="flex items-center justify-between px-8 pt-6 pb-4 border-b border-white/5 relative">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-pink-500 via-violet-500 to-cyan-400 grid place-items-center shadow-lg">
            <Activity className="h-5 w-5 text-white" strokeWidth={2.5} />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-[0.25em] text-white/50">Pulse · Live</div>
            <div className="text-xl font-bold tracking-tight">PBIS House Cup — Live Standings</div>
          </div>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/5 border border-white/10 text-white/70 text-xs">
            <Filter className="h-3 w-3" /> Last 7 days
          </div>
          <div className="flex items-center gap-2">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
            </span>
            <span className="text-emerald-300 font-medium">Live</span>
          </div>
          <div className="text-white/50">
            {new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
          </div>
        </div>
      </header>

      {rows.length === 0 ? (
        <div className="grid place-items-center py-24 text-white/50">
          No houses configured for this school yet.
        </div>
      ) : (
        <section className="px-8 pt-5 pb-8 relative">
          {/* LIVE ACTION FEED — most recent point-bearing events */}
          <div className="mb-5">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2 text-[10px] text-white/50 uppercase tracking-[0.25em] font-bold">
                <Sparkles className="h-3 w-3 text-amber-300" />
                Live action feed · last {events.data?.windowMinutes ?? 120} min
              </div>
              <div className="text-[10px] text-white/40">
                {recentForFeed.length} recent {recentForFeed.length === 1 ? "award" : "awards"}
              </div>
            </div>
            {recentForFeed.length === 0 ? (
              <div className="rounded-xl border border-white/5 bg-white/[0.02] px-4 py-2 text-xs text-white/40">
                Quiet on the boards — awards will appear here as they're logged.
              </div>
            ) : (
              <div className="relative">
                {/* Top fade so older items "drop off" the strip */}
                <div className="pointer-events-none absolute inset-y-0 left-0 w-12 bg-gradient-to-r from-slate-950 to-transparent z-10" />
                <div className="pointer-events-none absolute inset-y-0 right-0 w-12 bg-gradient-to-l from-slate-950 to-transparent z-10" />
                <div className="flex items-stretch gap-2 overflow-x-auto pb-1 -mx-1 px-1 scrollbar-none">
                  {recentForFeed.map((e) => {
                    const isPos = e.kind === "positive";
                    const isConcern = e.kind === "neutral";
                    const tone = isPos
                      ? { bg: "from-emerald-500/15 to-emerald-500/5", border: "border-emerald-400/40", pts: "text-emerald-300", avatar: "bg-emerald-500" }
                      : isConcern
                        ? { bg: "from-amber-500/15 to-amber-500/5", border: "border-amber-400/40", pts: "text-amber-300", avatar: "bg-amber-500" }
                        : { bg: "from-rose-500/15 to-rose-500/5", border: "border-rose-400/40", pts: "text-rose-300", avatar: "bg-rose-500" };
                    return (
                      <div
                        key={e.id}
                        className={`shrink-0 min-w-[220px] rounded-xl bg-gradient-to-r ${tone.bg} border ${tone.border} px-3 py-2 flex items-center gap-3`}
                      >
                        <div className={`h-8 w-8 rounded-full ${tone.avatar} grid place-items-center font-black text-[11px] ring-2 ring-white/30 shrink-0`}>
                          {e.studentInitials}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-bold truncate">{e.studentId}</div>
                          <div className="text-[10px] text-white/60 truncate">{e.what}</div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className={`text-base font-black tabular-nums ${tone.pts}`}>
                            {(e.points ?? 0) > 0 ? "+" : ""}
                            {e.points ?? 0}
                          </div>
                          <div className="text-[9px] text-white/40 uppercase tracking-wider">
                            {relativeTime(e.createdAt)}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2 text-xs text-white/50 uppercase tracking-widest">
              <Trophy className="h-3.5 w-3.5" />
              House Cup · Live Standings
              {leader && (
                <span className="text-white/70 normal-case tracking-normal text-sm ml-3">
                  · 🏆 <span className="font-bold">{leader.name}</span> in the lead
                </span>
              )}
            </div>
            <div className="text-[11px] text-white/40">Goal: {goal.toLocaleString()} pts</div>
          </div>

          {/* Fixed-height frame; bars fill % of frame */}
          <div
            className={`grid gap-6 h-[400px]`}
            style={{ gridTemplateColumns: `repeat(${rows.length}, minmax(0, 1fr))` }}
          >
            {rows.map((h) => {
              const pct = Math.max(2, Math.min(100, (h.totalPoints / goal) * 100));
              const meterTotal = h.positiveCount + h.negativeCount;
              // Steady 50/50 resting state when a house has no polarized
              // signals yet — same convention as the heartbeat / parent /
              // student-timeline meters.
              const posPct = meterTotal > 0 ? (h.positiveCount / meterTotal) * 100 : 50;
              const negPct = 100 - posPct;
              const isLeader = leader?.id === h.id;
              // Sequencer hooks: only the bar matching the active event
              // animates, and only during its rising phase. Everything
              // else stays quiet.
              const isRising = active?.phase === "rising" && active.event.houseId === h.id;
              const isShowing = active?.phase === "showing" && active.event.houseId === h.id;
              const sequenceKey = active?.event.id ?? "idle";
              return (
                <div key={h.id} className="relative h-full flex flex-col">
                  {/* Frame */}
                  <div className="relative flex-1 rounded-2xl border border-white/10 bg-white/[0.02] overflow-hidden">
                    <div
                      className={`absolute inset-x-0 bottom-0 rounded-2xl ${isLeader ? "ring-2 ring-white/60" : ""}`}
                      style={{
                        height: `${pct}%`,
                        background: gradientFromColor(h.color),
                        boxShadow: `0 0 50px -10px ${h.color}b3`,
                        // CSS var consumed by the houseBarFlash keyframe so the
                        // glow tint matches the house color without inlining
                        // the hex into the animation.
                        ["--bar-glow" as string]: `${h.color}cc`,
                        // Flash only while the spark is rising on THIS bar.
                        animation: isRising ? "houseBarFlash 1300ms ease-out" : undefined,
                      }}
                      key={`bar-${h.id}-${sequenceKey}-${isRising ? "rise" : "idle"}`}
                    >
                      <div className="absolute inset-x-0 top-2 text-center text-sm font-black text-white drop-shadow tabular-nums">
                        {h.totalPoints.toLocaleString()}
                      </div>
                      <div className="absolute inset-x-0 top-8 text-center text-[10px] uppercase tracking-widest text-white/80 drop-shadow">
                        all-time pts
                      </div>
                      {h.weekPoints !== 0 && (
                        <div className="absolute inset-x-2 bottom-2 text-center text-[10px] font-bold text-white/90 bg-black/25 rounded-md py-0.5">
                          {h.weekPoints > 0 ? "+" : ""}
                          {h.weekPoints} pts this week
                        </div>
                      )}
                      {/* RISING SPARK — only renders during the rising
                          phase of THIS bar's active event. Keyed on the
                          event id so each celebration replays cleanly. */}
                      {isRising && (
                        <div
                          key={`pulse-rise-${h.id}-${sequenceKey}`}
                          className="pointer-events-none absolute left-1/2 bottom-0 z-10"
                          style={{
                            width: "100%",
                            height: "100%",
                            marginLeft: "-50%",
                            transformOrigin: "center bottom",
                            background: `radial-gradient(ellipse 35% 55% at 50% 100%, #ffffff 0%, ${h.color} 35%, ${h.color}66 60%, transparent 80%)`,
                            filter: `drop-shadow(0 0 24px ${h.color}) drop-shadow(0 0 48px #ffffff80)`,
                            animation: `housePulseRise ${RISE_MS}ms cubic-bezier(0.25, 0.8, 0.3, 1) forwards`,
                            mixBlendMode: "screen",
                          }}
                        />
                      )}
                      {/* ARRIVAL BURST — halo that blooms behind the
                          name/points label as the spark reaches the top.
                          Times out with the rise so the tile gets
                          "delivered" into a clean frame. */}
                      {isRising && (
                        <div
                          key={`pulse-burst-${h.id}-${sequenceKey}`}
                          className="pointer-events-none absolute inset-x-0 top-0 h-28 z-10"
                          style={{
                            background: `radial-gradient(ellipse 60% 80% at 50% 25%, #ffffff 0%, ${h.color} 35%, transparent 75%)`,
                            filter: `drop-shadow(0 0 32px #ffffff)`,
                            animation: `housePulseBurst ${RISE_MS}ms ease-out forwards`,
                            mixBlendMode: "screen",
                          }}
                        />
                      )}
                    </div>
                    {/* Celebration tile — delivered after the rise
                        completes, on the awarded bar only. */}
                    {isShowing && active && (
                      <FeaturedPopup event={active.event} barPct={pct} />
                    )}
                  </div>

                  {/* Label + member count */}
                  <div className="mt-2 flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      <div
                        className="h-7 w-7 rounded-lg grid place-items-center text-sm font-black shadow shrink-0"
                        style={{ background: gradientFromColor(h.color) }}
                      >
                        {h.name.charAt(0)}
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm font-semibold truncate">{h.name}</div>
                        {h.motto && (
                          <div className="text-[10px] text-white/40 truncate italic">{h.motto}</div>
                        )}
                      </div>
                    </div>
                    <div className="text-[10px] text-white/40 tabular-nums shrink-0">
                      {Math.round(pct)}%
                    </div>
                  </div>

                  {/* MINI-METER — per-house red(left)/green(right) split */}
                  <div className="mt-2">
                    <div className="relative h-2 rounded-full bg-white/5 overflow-hidden border border-white/10">
                      <div
                        className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-rose-600 to-rose-400"
                        style={{ width: `${negPct}%` }}
                      />
                      <div
                        className="absolute inset-y-0 right-0 rounded-full bg-gradient-to-l from-emerald-600 to-emerald-400"
                        style={{ width: `${posPct}%` }}
                      />
                    </div>
                    <div className="mt-1 flex items-center justify-between text-[10px] text-white/50 tabular-nums">
                      <span className="text-rose-300 font-bold">−{h.negativeCount}</span>
                      <span className="flex items-center gap-1 text-white/40">
                        <Users className="h-3 w-3" />
                        {h.memberCount}
                      </span>
                      <span className="text-emerald-300 font-bold">+{h.positiveCount}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <footer className="absolute left-0 right-0 bottom-0 px-8 py-3 border-t border-white/10 bg-black/40 flex items-center justify-between text-xs text-white/45">
        <div>
          PBIS House Cup · Last 7 days
          {houses.lastUpdatedAt && (
            <> · Updated {houses.lastUpdatedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}</>
          )}
        </div>
        <div className="font-semibold">PulseEDU · School Operations</div>
      </footer>
      <DemoFireButton />
    </div>
  );
}

// -----------------------------------------------------------------------------
// DemoFireButton — small bottom-right control that POSTs to the demo
// heartbeat fire endpoint. Bypasses cadence + bell-window so the operator
// can demo the in-bar pulse + action-feed on demand. The server gates the
// endpoint behind isDemoHeartbeatEnabled() so this is a no-op in prod.
// -----------------------------------------------------------------------------
function DemoFireButton() {
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<null | "ok" | "skip" | "err">(null);
  async function fire() {
    if (busy) return;
    setBusy(true);
    setFlash(null);
    try {
      const r = await fetch("/api/demo-heartbeat/fire", { method: "POST" });
      if (!r.ok) {
        setFlash("err");
      } else {
        const data = (await r.json()) as { fired: boolean };
        setFlash(data.fired ? "ok" : "skip");
      }
    } catch {
      setFlash("err");
    } finally {
      setBusy(false);
      window.setTimeout(() => setFlash(null), 2500);
    }
  }
  const label =
    flash === "ok" ? "Fired ✓" :
    flash === "skip" ? "Skipped (cooldown)" :
    flash === "err" ? "Failed" :
    busy ? "Firing…" : "Fire heartbeat";
  return (
    <button
      type="button"
      onClick={fire}
      disabled={busy}
      title="Force one demo PBIS award now (bypasses cadence + school hours)"
      className="fixed bottom-3 right-4 z-50 text-[11px] font-medium px-3 py-1.5 rounded-full bg-white/10 hover:bg-white/20 text-white/70 hover:text-white border border-white/15 backdrop-blur-sm transition-colors disabled:opacity-50"
    >
      {label}
    </button>
  );
}
