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
// FeaturedPopup — celebratory card pinned inside the leading house's bar.
// -----------------------------------------------------------------------------
// Spec: when multiple awards arrive at once we queue them and hold each one
// for ~5 seconds before swapping to the next. Resets cleanly when the queue
// shrinks (e.g. when the underlying poll returns fewer recent positives).
// =============================================================================
const FEATURED_HOLD_MS = 5_000;

function FeaturedPopup({
  events,
  barPct,
}: {
  events: PulseEventLite[];
  // Height (in %) of the leading house's bar fill. We use this to keep the
  // popup visually attached to the TOP of the bar rather than the top of
  // the frame — otherwise the popup floats in empty space when the leader's
  // bar is short (early in a school year, or first day after rollout).
  barPct: number;
}) {
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    // Snap back to the head of the queue whenever the underlying list
    // changes — that way "newest first" stays true even if the previously-
    // featured event scrolled off after a poll.
    setIdx(0);
  }, [events.map((e) => e.id).join("|")]);

  useEffect(() => {
    if (events.length <= 1) return;
    const t = window.setInterval(() => {
      setIdx((i) => (i + 1) % events.length);
    }, FEATURED_HOLD_MS);
    return () => window.clearInterval(t);
  }, [events.length]);

  if (events.length === 0) return null;
  const e = events[idx % events.length];

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
  // Track prior totalPoints per house so we can fire an in-bar pulse
  // animation whenever a house's total grows. Stored as a counter that
  // increments on every detected gain — we feed that counter into a React
  // `key` on the pulse element, which remounts the node and replays the
  // CSS animation. Without the counter, identical class names wouldn't
  // re-run the animation on a second consecutive gain.
  const prevTotalsRef = useRef<Map<number, number>>(new Map());
  const [pulseTicks, setPulseTicks] = useState<Record<number, number>>({});
  useEffect(() => {
    const list = houses.data?.houses ?? [];
    if (list.length === 0) return;
    const next: Record<number, number> = { ...pulseTicks };
    let changed = false;
    for (const h of list) {
      const prev = prevTotalsRef.current.get(h.id);
      if (prev !== undefined && h.totalPoints > prev) {
        next[h.id] = (next[h.id] ?? 0) + 1;
        changed = true;
      }
      prevTotalsRef.current.set(h.id, h.totalPoints);
    }
    if (changed) setPulseTicks(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [houses.data]);
  // Polled separately from /houses so the action feed and featured-popup
  // queue refresh independently of the leaderboard math.
  const events = usePolling<EventsPayload>(eventsUrl, 30_000);

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
  // Featured popup queue = positive PBIS only — that's the celebratory
  // moment we want to broadcast on the leading bar.
  const featuredQueue = allEvents
    .filter((e) => e.kind === "positive" && e.source === "pbis" && (e.points ?? 0) > 0)
    .slice(0, 8);

  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-white overflow-hidden relative">
      {/* In-bar "heartbeat" pulse: a soft glow blip that rises from the
          bottom of a house's vertical bar to the top whenever that
          house gains points. Replayed by remounting the node on a
          counter-bound key. Kept under 1s so back-to-back awards stack
          visually without queuing. */}
      <style>{`
        @keyframes housePulseUp {
          0%   { transform: translateY(0%);    opacity: 0; }
          15%  { opacity: 1; }
          85%  { opacity: 1; }
          100% { transform: translateY(-100%); opacity: 0; }
        }
        @keyframes houseBarFlash {
          0%   { box-shadow: 0 0 50px -10px var(--bar-glow); }
          50%  { box-shadow: 0 0 90px 8px  var(--bar-glow); }
          100% { box-shadow: 0 0 50px -10px var(--bar-glow); }
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
              const pulseTick = pulseTicks[h.id] ?? 0;
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
                        // Re-trigger the bar flash on each pulse tick by
                        // remounting via key on the wrapper below; the
                        // animation itself runs unconditionally on mount.
                        animation: pulseTick > 0 ? "houseBarFlash 900ms ease-out" : undefined,
                      }}
                      key={`bar-${h.id}-${pulseTick}`}
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
                      {/* Rising-pulse blip — sits inside the filled portion of
                          the bar and rides from the bottom up to the top edge
                          of the fill. Keyed on pulseTick so React remounts and
                          the CSS animation replays on every detected gain. */}
                      {pulseTick > 0 && (
                        <div
                          key={`pulse-${h.id}-${pulseTick}`}
                          className="pointer-events-none absolute inset-x-0 bottom-0 h-6"
                          style={{
                            background: `linear-gradient(to top, transparent 0%, ${h.color}00 0%, #ffffffcc 50%, transparent 100%)`,
                            filter: `drop-shadow(0 0 12px ${h.color})`,
                            animation: "housePulseUp 900ms ease-out forwards",
                            mixBlendMode: "screen",
                          }}
                        />
                      )}
                    </div>
                    {/* Featured popup rotates 5s per item — only on the leading bar */}
                    {isLeader && <FeaturedPopup events={featuredQueue} barPct={pct} />}
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
