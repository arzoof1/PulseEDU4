import { Activity, Heart, Users } from "lucide-react";

type Branch = {
  id: number;
  side: "left" | "right";
  intensity: number;
  initials: string;
  color: string;
  name: string;
  action: string;
  detail: string;
  yPct: number;
};

const branches: Branch[] = [
  { id: 1, side: "right", intensity: 0.92, initials: "MS", color: "bg-emerald-500", name: "Ms. Patel",   action: "Phone call home", detail: "+ Positive · Riya B.",          yPct: 8 },
  { id: 2, side: "left",  intensity: 0.55, initials: "JM", color: "bg-amber-500",   name: "Jordan M.",   action: "Bathroom pass",   detail: "14 min out of class",          yPct: 18 },
  { id: 3, side: "right", intensity: 0.78, initials: "AR", color: "bg-emerald-400", name: "Aliyah R.",   action: "Trusted adult",   detail: "Counselor check-in",           yPct: 30 },
  { id: 4, side: "right", intensity: 0.65, initials: "TC", color: "bg-emerald-400", name: "Tomás C.",    action: "+5 PBIS",         detail: "Leadership in PE",             yPct: 42 },
  { id: 5, side: "left",  intensity: 0.85, initials: "DK", color: "bg-rose-500",    name: "Devon K.",    action: "Pull-out",        detail: "Disruptive · ESE referral",    yPct: 55 },
  { id: 6, side: "right", intensity: 0.42, initials: "MS", color: "bg-lime-500",    name: "Maya S.",     action: "Email home",      detail: "+ Positive · Reading growth",  yPct: 67 },
  { id: 7, side: "left",  intensity: 0.30, initials: "RB", color: "bg-orange-500",  name: "Riya B.",     action: "Tardy",           detail: "Period 4 · 6 min late",        yPct: 78 },
  { id: 8, side: "right", intensity: 0.70, initials: "EL", color: "bg-emerald-500", name: "Mr. Lopez",   action: "Intervention",    detail: "Restorative circle · 5 sts",   yPct: 88 },
];

const grades = [
  { label: "K",   pct: 88 },
  { label: "1st", pct: 72 },
  { label: "2nd", pct: 95 },
  { label: "3rd", pct: 61 },
  { label: "4th", pct: 78 },
  { label: "5th", pct: 54 },
];

function colorForBranch(side: "left" | "right", intensity: number): string {
  if (side === "right") {
    if (intensity > 0.75) return "from-emerald-400/90 to-emerald-300/40";
    if (intensity > 0.5)  return "from-emerald-500/80 to-lime-300/30";
    return "from-lime-500/70 to-yellow-200/30";
  }
  if (intensity > 0.75) return "from-rose-500/90 to-rose-400/40";
  if (intensity > 0.5)  return "from-orange-500/80 to-rose-400/30";
  return "from-amber-500/70 to-rose-300/30";
}

export function SchoolTrunk() {
  const trunkSkew = 6;
  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-[#0a0612] via-[#0d0817] to-[#06030d] text-white overflow-hidden relative">
      <div className="absolute inset-0 opacity-[0.05] pointer-events-none" style={{ backgroundImage: "radial-gradient(circle at 1px 1px, white 1px, transparent 0)", backgroundSize: "28px 28px" }} />

      <header className="flex items-center justify-between px-8 pt-6 pb-4 border-b border-white/5 relative z-20">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-rose-500 via-fuchsia-500 to-violet-500 grid place-items-center shadow-lg">
            <Heart className="h-5 w-5 text-white fill-white" strokeWidth={2.5} />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-[0.25em] text-white/50">Pulse · Live</div>
            <div className="text-xl font-bold tracking-tight">School Pulse — The Heartbeat</div>
          </div>
        </div>
        <div className="flex items-center gap-6 text-sm">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
            </span>
            <span className="text-emerald-300 font-medium">Live</span>
          </div>
          <div className="px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-400/30 text-emerald-300 text-xs font-medium">
            Culture trending positive · +6°
          </div>
        </div>
      </header>

      <div className="absolute inset-0 pt-[88px] pb-[200px] flex items-center justify-center pointer-events-none">
        <div className="relative w-full h-full">
          <svg className="absolute inset-0 w-full h-full" preserveAspectRatio="none" viewBox="0 0 1280 512">
            <defs>
              <linearGradient id="trunkGrad" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor="#fb7185" stopOpacity="0.2" />
                <stop offset="0.5" stopColor="#ef4444" stopOpacity="0.95" />
                <stop offset="1" stopColor="#7f1d1d" stopOpacity="0.6" />
              </linearGradient>
              <filter id="glow"><feGaussianBlur stdDeviation="6" /></filter>
            </defs>
            <g transform={`translate(640 256) skewX(${-trunkSkew}) translate(-640 -256)`}>
              <rect x="632" y="0" width="16" height="512" fill="url(#trunkGrad)" rx="8" filter="url(#glow)" />
              <rect x="635" y="0" width="10" height="512" fill="url(#trunkGrad)" rx="5" className="origin-center" style={{ animation: "pulse 2.4s ease-in-out infinite" }} />
            </g>
          </svg>
        </div>
      </div>

      <div className="absolute inset-0 pt-[88px] pb-[200px] z-10">
        <div className="relative w-full h-full">
          {branches.map((b) => {
            const isRight = b.side === "right";
            const length = 30 + b.intensity * 30;
            const grad = colorForBranch(b.side, b.intensity);
            return (
              <div key={b.id} className="absolute" style={{ top: `${b.yPct}%`, left: isRight ? "50%" : undefined, right: isRight ? undefined : "50%" }}>
                <div className={`flex items-center gap-2 ${isRight ? "flex-row" : "flex-row-reverse"}`}>
                  <div className={`h-[3px] bg-gradient-to-${isRight ? "r" : "l"} ${grad} rounded-full`} style={{ width: `${length * 6}px` }} />
                  <div className={`relative px-3 py-2 rounded-2xl bg-gradient-to-${isRight ? "r" : "l"} ${grad} border border-white/15 backdrop-blur shadow-xl flex items-center gap-2 min-w-[220px] max-w-[260px]`}>
                    <div className={`h-9 w-9 rounded-full ${b.color} grid place-items-center font-bold text-xs ring-2 ring-white/30 shrink-0`}>{b.initials}</div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-semibold truncate">{b.name}</div>
                      <div className="text-[11px] text-white/85 truncate">{b.action}</div>
                      <div className="text-[10px] text-white/60 truncate">{b.detail}</div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <section className="absolute left-0 right-0 bottom-0 h-[200px] px-8 pt-4 pb-6 border-t border-white/10 bg-gradient-to-b from-black/0 to-black/70 z-20">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2 text-xs text-white/50 uppercase tracking-widest">
            <Users className="h-3.5 w-3.5" /> Grade-Level Engagement · App usage today
          </div>
          <div className="text-[11px] text-white/40">% of teachers active in last 4h</div>
        </div>
        <div className="grid grid-cols-6 gap-5 items-end h-[120px]">
          {grades.map((g) => (
            <div key={g.label} className="h-full flex flex-col justify-end">
              <div className="relative w-full rounded-t-xl bg-gradient-to-t from-violet-600 via-fuchsia-500 to-pink-400 shadow-[0_0_30px_-10px_rgba(217,70,239,0.7)]" style={{ height: `${g.pct}%` }}>
                <div className="absolute inset-x-0 -top-5 text-center text-[11px] font-bold text-white tabular-nums">{g.pct}%</div>
              </div>
              <div className="mt-2 text-center text-sm font-semibold text-white/85">{g.label}</div>
            </div>
          ))}
        </div>
      </section>

      <div className="absolute top-[100px] left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 px-3 py-1 rounded-full bg-rose-500/10 border border-rose-400/30 text-rose-200 text-[10px] uppercase tracking-widest">
        <Activity className="h-3 w-3" /> Trunk skew · +{trunkSkew}° culture
      </div>
    </div>
  );
}
