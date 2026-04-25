import { Activity, Trophy, Filter, Users } from "lucide-react";
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

export default function HousesSignage() {
  const schoolId = schoolIdFromUrl();
  const validSchool = Number.isFinite(schoolId) && schoolId > 0;

  const houses = usePolling<HousesPayload>(
    validSchool ? `/api/houses?schoolId=${schoolId}&windowDays=7` : null,
    30_000,
  );

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

  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-white overflow-hidden relative">
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
        <section className="px-8 pt-6 pb-8 relative">
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
            className={`grid gap-6 h-[460px]`}
            style={{ gridTemplateColumns: `repeat(${rows.length}, minmax(0, 1fr))` }}
          >
            {rows.map((h) => {
              const pct = Math.max(2, Math.min(100, (h.totalPoints / goal) * 100));
              const meterTotal = h.positiveCount + h.negativeCount;
              const posPct = meterTotal > 0 ? (h.positiveCount / meterTotal) * 100 : 0;
              const negPct = 100 - posPct;
              const isLeader = leader?.id === h.id;
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
                      }}
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
                    </div>
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
    </div>
  );
}
