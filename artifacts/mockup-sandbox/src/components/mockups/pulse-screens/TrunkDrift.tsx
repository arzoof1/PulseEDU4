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
};

const branches: Branch[] = [
  { id: 1, side: "right", intensity: 0.92, initials: "MS", color: "bg-emerald-500", name: "Ms. Patel",   action: "Phone call home", detail: "+ Positive · Riya B." },
  { id: 2, side: "right", intensity: 0.78, initials: "AR", color: "bg-emerald-400", name: "Aliyah R.",   action: "Trusted adult",   detail: "Counselor check-in" },
  { id: 3, side: "right", intensity: 0.65, initials: "TC", color: "bg-emerald-400", name: "Tomás C.",    action: "+5 PBIS",         detail: "Leadership in PE" },
  { id: 4, side: "left",  intensity: 0.30, initials: "JM", color: "bg-amber-500",   name: "Jordan M.",   action: "Bathroom pass",   detail: "14 min" },
  { id: 5, side: "right", intensity: 0.85, initials: "MS", color: "bg-emerald-500", name: "Maya S.",     action: "Email home",      detail: "+ Reading growth" },
  { id: 6, side: "right", intensity: 0.70, initials: "EL", color: "bg-emerald-500", name: "Mr. Lopez",   action: "Restorative",     detail: "Circle · 5 students" },
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

export function TrunkDrift() {
  // Heavy positive day — trunk drifts strongly to the right by the bottom.
  const W = 1000, H = 520;
  const driftRight = 220; // px the trunk drifts right by H
  const yAt = (i: number) => (i + 0.5) * (H / branches.length);
  const xAt = (y: number) => W / 2 + (y / H) * driftRight; // linear drift

  // Build a smooth curve from top center to bottom-right
  let d = `M ${W / 2} 0`;
  const segments = 12;
  for (let i = 1; i <= segments; i++) {
    const y = (i / segments) * H;
    d += ` L ${xAt(y)} ${y}`;
  }

  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-[#0a0612] via-[#0d0817] to-[#06030d] text-white overflow-hidden relative">
      <header className="flex items-center justify-between px-6 pt-5 pb-3 border-b border-white/5 relative z-20">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-rose-500 to-violet-500 grid place-items-center"><Heart className="h-4 w-4 text-white fill-white" /></div>
          <div>
            <div className="text-[10px] uppercase tracking-[0.25em] text-white/50">Trunk variant · Cumulative drift</div>
            <div className="text-base font-bold">Trunk leans further the longer the trend holds</div>
          </div>
        </div>
        <div className="px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-400/30 text-emerald-300 text-[10px] uppercase tracking-widest flex items-center gap-1">
          <Activity className="h-3 w-3" /> Strong positive day · +22°
        </div>
      </header>

      <div className="relative" style={{ height: H }}>
        <svg className="absolute inset-0 w-full h-full" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          <defs>
            <linearGradient id="driftGrad" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="#fb7185" stopOpacity="0.3" />
              <stop offset="0.5" stopColor="#ef4444" stopOpacity="0.95" />
              <stop offset="1" stopColor="#7f1d1d" stopOpacity="0.7" />
            </linearGradient>
            <filter id="driftGlow"><feGaussianBlur stdDeviation="7" /></filter>
            <line id="centerline" x1={W / 2} y1="0" x2={W / 2} y2={H} stroke="white" strokeOpacity="0.06" strokeDasharray="4 6" />
          </defs>
          <line x1={W / 2} y1="0" x2={W / 2} y2={H} stroke="white" strokeOpacity="0.06" strokeDasharray="4 6" />
          <path d={d} stroke="url(#driftGrad)" strokeWidth="22" fill="none" strokeLinecap="round" filter="url(#driftGlow)" opacity="0.55" />
          <path d={d} stroke="url(#driftGrad)" strokeWidth="10" fill="none" strokeLinecap="round" style={{ animation: "pulse 2.4s ease-in-out infinite" }} />
        </svg>

        {branches.map((b, i) => {
          const yPx = yAt(i);
          const trunkX = xAt(yPx);
          const isRight = b.side === "right";
          const grad = colorForBranch(b.side, b.intensity);
          const length = 22 + b.intensity * 22;
          const leftPct = (trunkX / W) * 100;
          return (
            <div key={b.id} className="absolute" style={{ top: yPx - 24, left: `${leftPct}%`, transform: isRight ? "translate(8px,0)" : "translate(calc(-100% - 8px),0)" }}>
              <div className={`flex items-center gap-2 ${isRight ? "flex-row" : "flex-row-reverse"}`}>
                <div className={`h-[3px] bg-gradient-to-${isRight ? "r" : "l"} ${grad} rounded-full`} style={{ width: `${length * 4}px` }} />
                <div className={`px-2 py-1.5 rounded-2xl bg-gradient-to-${isRight ? "r" : "l"} ${grad} border border-white/15 backdrop-blur flex items-center gap-2 min-w-[180px] max-w-[210px]`}>
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

        {/* Drift indicator at bottom */}
        <div className="absolute bottom-2 left-0 right-0 flex justify-center">
          <div className="text-[10px] text-emerald-300 bg-emerald-500/10 border border-emerald-400/30 rounded-full px-3 py-1">
            ← center · trunk drifted +{driftRight}px right
          </div>
        </div>
      </div>

      <div className="px-6 py-4 border-t border-white/10 text-[11px] text-white/50 text-center bg-black/30">
        Single sweeping trunk · the more sustained the trend, the further it leans · resets each day.
      </div>
    </div>
  );
}
