import { Heart, Activity } from "lucide-react";

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
  { id: 1, side: "right", intensity: 0.92, initials: "MS", color: "bg-emerald-500", name: "Ms. Patel",   action: "Phone call home", detail: "+ Positive · Riya B.",         yPct: 8 },
  { id: 2, side: "left",  intensity: 0.55, initials: "JM", color: "bg-amber-500",   name: "Jordan M.",   action: "Bathroom pass",   detail: "14 min out of class",         yPct: 22 },
  { id: 3, side: "right", intensity: 0.78, initials: "AR", color: "bg-emerald-400", name: "Aliyah R.",   action: "Trusted adult",   detail: "Counselor check-in",          yPct: 36 },
  { id: 4, side: "left",  intensity: 0.85, initials: "DK", color: "bg-rose-500",    name: "Devon K.",    action: "Pull-out",        detail: "Disruptive · ESE referral",   yPct: 52 },
  { id: 5, side: "right", intensity: 0.65, initials: "TC", color: "bg-emerald-400", name: "Tomás C.",    action: "+5 PBIS",         detail: "Leadership in PE",            yPct: 68 },
  { id: 6, side: "left",  intensity: 0.40, initials: "RB", color: "bg-orange-500",  name: "Riya B.",     action: "Tardy",           detail: "Period 4 · 6 min late",       yPct: 84 },
];

// Build a meandering SVG path: starts dead center at top, deviates left/right at each branch y
function buildPath(): { d: string; xAt: (y: number) => number } {
  const W = 1000, H = 520, midX = W / 2;
  const points = branches.map((b) => ({
    y: (b.yPct / 100) * H,
    x: midX + (b.side === "right" ? 1 : -1) * (40 + b.intensity * 60),
  }));
  const all = [{ x: midX, y: 0 }, ...points, { x: midX + (points[points.length - 1].x - midX) * 0.6, y: H }];
  let d = `M ${all[0].x} ${all[0].y}`;
  for (let i = 1; i < all.length; i++) {
    const p0 = all[i - 1], p1 = all[i];
    const cy = (p0.y + p1.y) / 2;
    d += ` C ${p0.x} ${cy}, ${p1.x} ${cy}, ${p1.x} ${p1.y}`;
  }
  const xAt = (y: number) => {
    for (let i = 1; i < all.length; i++) {
      if (y <= all[i].y) {
        const p0 = all[i - 1], p1 = all[i];
        const t = (y - p0.y) / (p1.y - p0.y || 1);
        return p0.x + (p1.x - p0.x) * t;
      }
    }
    return midX;
  };
  return { d, xAt };
}

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

export function TrunkMeander() {
  const { d, xAt } = buildPath();
  const W = 1000, H = 520;

  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-[#0a0612] via-[#0d0817] to-[#06030d] text-white overflow-hidden relative">
      <header className="flex items-center justify-between px-6 pt-5 pb-3 border-b border-white/5 relative z-20">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-rose-500 to-violet-500 grid place-items-center"><Heart className="h-4 w-4 text-white fill-white" /></div>
          <div>
            <div className="text-[10px] uppercase tracking-[0.25em] text-white/50">Trunk variant · Meander</div>
            <div className="text-base font-bold">Wavy spine · curves to where action happens</div>
          </div>
        </div>
        <div className="px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-400/30 text-emerald-300 text-[10px] uppercase tracking-widest flex items-center gap-1">
          <Activity className="h-3 w-3" /> Net trend +
        </div>
      </header>

      <div className="relative" style={{ height: H }}>
        <svg className="absolute inset-0 w-full h-full" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          <defs>
            <linearGradient id="meanderGrad" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="#fb7185" stopOpacity="0.3" />
              <stop offset="0.5" stopColor="#ef4444" stopOpacity="0.95" />
              <stop offset="1" stopColor="#7f1d1d" stopOpacity="0.7" />
            </linearGradient>
            <filter id="meanderGlow"><feGaussianBlur stdDeviation="6" /></filter>
          </defs>
          <path d={d} stroke="url(#meanderGrad)" strokeWidth="22" fill="none" strokeLinecap="round" filter="url(#meanderGlow)" opacity="0.55" />
          <path d={d} stroke="url(#meanderGrad)" strokeWidth="10" fill="none" strokeLinecap="round" style={{ animation: "pulse 2.4s ease-in-out infinite" }} />
        </svg>

        {branches.map((b) => {
          const isRight = b.side === "right";
          const grad = colorForBranch(b.side, b.intensity);
          const yPx = (b.yPct / 100) * H;
          const trunkX = xAt(yPx);
          const leftPct = (trunkX / W) * 100;
          const length = 22 + b.intensity * 22;
          return (
            <div key={b.id} className="absolute" style={{ top: yPx - 26, left: `${leftPct}%`, transform: isRight ? "translate(0,0)" : "translate(-100%,0)" }}>
              <div className={`flex items-center gap-2 ${isRight ? "flex-row" : "flex-row-reverse"}`}>
                <div className={`h-[3px] bg-gradient-to-${isRight ? "r" : "l"} ${grad} rounded-full`} style={{ width: `${length * 4}px` }} />
                <div className={`relative px-2 py-1.5 rounded-2xl bg-gradient-to-${isRight ? "r" : "l"} ${grad} border border-white/15 backdrop-blur shadow-xl flex items-center gap-2 min-w-[180px] max-w-[210px]`}>
                  <div className={`h-7 w-7 rounded-full ${b.color} grid place-items-center font-bold text-[10px] ring-2 ring-white/30 shrink-0`}>{b.initials}</div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] font-semibold truncate">{b.name}</div>
                    <div className="text-[10px] text-white/85 truncate">{b.action}</div>
                    <div className="text-[9px] text-white/60 truncate">{b.detail}</div>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="px-6 py-4 border-t border-white/10 text-[11px] text-white/50 text-center bg-black/30">
        Trunk follows a curve through every entry — left for negative, right for positive. Heart-rate-style EKG.
      </div>
    </div>
  );
}
