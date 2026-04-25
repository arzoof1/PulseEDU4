import { Activity, Sparkles, Trophy, Filter } from "lucide-react";

type Action = {
  id: number;
  initials: string;
  color: string;
  name: string;
  reason: string;
  pts: number;
  house: string;
  time: string;
};

type House = {
  name: string;
  emoji: string;
  total: number;
  goal: number;
  gradient: string;
  glow: string;
  textOnBar: string;
  popupBg: string;
  popupText: string;
  popupAccent: string;
};

const houses: House[] = [
  { name: "Phoenix", emoji: "🔥", total: 1842, goal: 2000,
    gradient: "from-red-500 via-orange-500 to-amber-400",
    glow: "shadow-[0_0_50px_-10px_rgba(249,115,22,0.7)]",
    textOnBar: "text-white", popupBg: "bg-amber-50", popupText: "text-red-900", popupAccent: "text-red-700" },
  { name: "Dragon", emoji: "🐉", total: 1701, goal: 2000,
    gradient: "from-emerald-500 via-green-500 to-lime-400",
    glow: "shadow-[0_0_50px_-10px_rgba(16,185,129,0.7)]",
    textOnBar: "text-white", popupBg: "bg-emerald-50", popupText: "text-emerald-900", popupAccent: "text-emerald-700" },
  { name: "Falcon", emoji: "🦅", total: 1588, goal: 2000,
    gradient: "from-blue-600 via-sky-500 to-cyan-400",
    glow: "shadow-[0_0_50px_-10px_rgba(14,165,233,0.7)]",
    textOnBar: "text-white", popupBg: "bg-cyan-50", popupText: "text-blue-900", popupAccent: "text-blue-700" },
  { name: "Wolf", emoji: "🐺", total: 1455, goal: 2000,
    gradient: "from-violet-600 via-purple-500 to-fuchsia-400",
    glow: "shadow-[0_0_50px_-10px_rgba(168,85,247,0.7)]",
    textOnBar: "text-white", popupBg: "bg-fuchsia-50", popupText: "text-violet-900", popupAccent: "text-fuchsia-700" },
];

const stack: Action[] = [
  { id: 1, initials: "JM", color: "bg-red-500",     name: "Jordan M.",  reason: "Helping a peer",         pts: 5, house: "Phoenix", time: "just now" },
  { id: 2, initials: "AR", color: "bg-emerald-500", name: "Aliyah R.",  reason: "On-task transition",     pts: 3, house: "Dragon",  time: "12s" },
  { id: 3, initials: "TC", color: "bg-blue-500",    name: "Tomás C.",   reason: "Leadership",             pts: 8, house: "Falcon",  time: "28s" },
  { id: 4, initials: "MS", color: "bg-violet-500",  name: "Maya S.",    reason: "Kind words",             pts: 4, house: "Wolf",    time: "41s" },
  { id: 5, initials: "DK", color: "bg-emerald-500", name: "Devon K.",   reason: "Hallway respect",        pts: 2, house: "Dragon",  time: "1m" },
  { id: 6, initials: "RB", color: "bg-red-500",     name: "Riya B.",    reason: "Classroom contribution", pts: 5, house: "Phoenix", time: "1m" },
];

const featuredAward = {
  initials: "TC",
  name: "Tomás Castillo",
  reason: "Leadership in PE",
  pts: 8,
  house: "Falcon",
};

export function HousesPbis() {
  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-white overflow-hidden relative">
      <div className="absolute inset-0 opacity-[0.04] pointer-events-none" style={{ backgroundImage: "radial-gradient(circle at 1px 1px, white 1px, transparent 0)", backgroundSize: "24px 24px" }} />

      <header className="flex items-center justify-between px-8 pt-6 pb-4 border-b border-white/5">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-pink-500 via-violet-500 to-cyan-400 grid place-items-center shadow-lg">
            <Activity className="h-5 w-5 text-white" strokeWidth={2.5} />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-[0.25em] text-white/50">Pulse · Live</div>
            <div className="text-xl font-bold tracking-tight">PBIS Timeline — Houses</div>
          </div>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/5 border border-white/10 text-white/70 text-xs">
            <Filter className="h-3 w-3" /> All grades
          </div>
          <div className="flex items-center gap-2">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
            </span>
            <span className="text-emerald-300 font-medium">Live</span>
          </div>
          <div className="text-white/50">2:14 PM</div>
        </div>
      </header>

      <div className="px-8 pt-4 pb-2 flex items-center gap-2 text-xs text-white/40 uppercase tracking-widest">
        <Sparkles className="h-3.5 w-3.5" /> Latest actions across campus
      </div>

      <div className="px-8 mt-2 space-y-2 h-[330px] overflow-hidden flex flex-col-reverse">
        {stack.map((a, i) => {
          const opacity = 1 - i * 0.13;
          return (
            <div
              key={a.id}
              className="flex items-center gap-4 px-4 py-3 rounded-xl bg-white/5 backdrop-blur border border-white/10"
              style={{ opacity }}
            >
              <div className={`h-11 w-11 rounded-full ${a.color} grid place-items-center font-bold text-sm shrink-0 ring-2 ring-white/20`}>{a.initials}</div>
              <div className="flex-1 min-w-0">
                <div className="text-base font-semibold truncate">{a.name} <span className="text-white/40 font-normal">·</span> <span className="text-white/70">{a.reason}</span></div>
                <div className="text-xs text-white/40">House {a.house} · {a.time}</div>
              </div>
              <div className="text-2xl font-black text-emerald-400 tabular-nums">+{a.pts}</div>
            </div>
          );
        })}
      </div>

      <section className="absolute left-0 right-0 bottom-0 h-[290px] px-8 pt-4 pb-6 border-t border-white/10 bg-gradient-to-b from-slate-950/0 to-black/60">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2 text-xs text-white/50 uppercase tracking-widest">
            <Trophy className="h-3.5 w-3.5" /> House Cup · Live Standings
          </div>
          <div className="text-[11px] text-white/40">Goal: 2,000 pts</div>
        </div>

        {/* Fixed-height frame: every house occupies the same headspace; bars fill % of frame */}
        <div className="grid grid-cols-4 gap-6 h-[210px]">
          {houses.map((h) => {
            const pct = Math.min(100, (h.total / h.goal) * 100);
            const isFeatured = h.name === featuredAward.house;
            return (
              <div key={h.name} className="relative h-full flex flex-col">
                {/* Frame */}
                <div className="relative flex-1 rounded-2xl border border-white/10 bg-white/[0.02] overflow-hidden">
                  {/* Empty headspace shows at top; bar grows from bottom */}
                  <div
                    className={`absolute inset-x-0 bottom-0 rounded-2xl bg-gradient-to-t ${h.gradient} ${h.glow} ${isFeatured ? "ring-2 ring-white/60" : ""}`}
                    style={{ height: `${pct}%` }}
                  >
                    {/* Total at top of bar */}
                    <div className={`absolute inset-x-0 top-2 text-center text-sm font-black ${h.textOnBar} drop-shadow tabular-nums`}>
                      {h.total.toLocaleString()}
                    </div>

                    {/* Featured-student popup INSIDE the bar, below the total */}
                    {isFeatured && (
                      <div className="absolute inset-x-2 top-9 z-10">
                        <div className={`${h.popupBg} ${h.popupText} rounded-xl px-2 py-2 shadow-xl ring-2 ring-white/70 flex items-center gap-2 animate-pulse`}>
                          <div className="h-9 w-9 rounded-full bg-gradient-to-br from-blue-600 to-cyan-400 grid place-items-center text-white font-bold text-xs ring-2 ring-white shrink-0">{featuredAward.initials}</div>
                          <div className="flex-1 min-w-0">
                            <div className={`text-[11px] font-bold leading-tight truncate ${h.popupText}`}>{featuredAward.name}</div>
                            <div className={`text-[10px] leading-tight truncate ${h.popupAccent} opacity-80`}>{featuredAward.reason}</div>
                          </div>
                          <div className={`text-base font-black tabular-nums ${h.popupAccent}`}>+{featuredAward.pts}</div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Label */}
                <div className="mt-2 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className={`h-7 w-7 rounded-lg bg-gradient-to-br ${h.gradient} grid place-items-center text-sm shadow`}>{h.emoji}</div>
                    <div className="text-sm font-semibold">{h.name}</div>
                  </div>
                  <div className="text-[10px] text-white/40 tabular-nums">{Math.round(pct)}%</div>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
