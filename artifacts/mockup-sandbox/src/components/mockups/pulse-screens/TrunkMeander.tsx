import { Heart } from "lucide-react";

type Branch = {
  id: number;
  side: "left" | "right";
  intensity: number;
  initials: string;
  color: string;
  name: string;
  action: string;
  yPct: number;
};

const branches: Branch[] = [
  { id: 1, side: "right", intensity: 0.95, initials: "MS", color: "bg-emerald-500", name: "Ms. Patel",   action: "Positive call home",  yPct: 14 },
  { id: 2, side: "left",  intensity: 0.70, initials: "JM", color: "bg-amber-500",   name: "Jordan M.",   action: "Bathroom 14 min",     yPct: 38 },
  { id: 3, side: "right", intensity: 0.85, initials: "AR", color: "bg-emerald-400", name: "Aliyah R.",   action: "Trusted adult",       yPct: 60 },
  { id: 4, side: "left",  intensity: 0.55, initials: "DK", color: "bg-rose-500",    name: "Devon K.",    action: "Pull-out · ESE",      yPct: 84 },
];

const W = 1280, H = 640, midX = W / 2;

function buildPath(): { d: string; xAt: (y: number) => number } {
  const points = branches.map((b) => ({
    y: (b.yPct / 100) * H,
    x: midX + (b.side === "right" ? 1 : -1) * (180 + b.intensity * 200),
  }));
  const all = [{ x: midX, y: 0 }, ...points, { x: midX, y: H }];
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

export function TrunkMeander() {
  const { d, xAt } = buildPath();
  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-[#0a0612] via-[#100819] to-[#06030d] text-white overflow-hidden relative">
      <header className="flex items-center justify-between px-8 pt-6 pb-4 border-b border-white/5">
        <div className="flex items-center gap-3">
          <div className="h-11 w-11 rounded-xl bg-gradient-to-br from-rose-500 to-violet-500 grid place-items-center"><Heart className="h-5 w-5 text-white fill-white" /></div>
          <div>
            <div className="text-[11px] uppercase tracking-[0.25em] text-white/50">Trunk variant</div>
            <div className="text-2xl font-black">MEANDER · trunk curves to every event</div>
          </div>
        </div>
        <div className="px-4 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-400/30 text-emerald-300 text-xs font-bold">EKG style</div>
      </header>

      <div className="relative" style={{ height: H }}>
        <svg className="absolute inset-0 w-full h-full" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          <defs>
            <linearGradient id="meanderGrad" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="#fb7185" stopOpacity="0.7" />
              <stop offset="0.5" stopColor="#ef4444" stopOpacity="1" />
              <stop offset="1" stopColor="#7f1d1d" stopOpacity="0.9" />
            </linearGradient>
            <filter id="meanderGlow" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="14" />
            </filter>
          </defs>
          <line x1={midX} y1="0" x2={midX} y2={H} stroke="white" strokeOpacity="0.12" strokeDasharray="6 10" strokeWidth="2" />
          <text x={midX + 8} y="20" fill="white" fillOpacity="0.3" fontSize="11">center</text>
          <path d={d} stroke="url(#meanderGrad)" strokeWidth="80" fill="none" strokeLinecap="round" filter="url(#meanderGlow)" opacity="0.5" />
          <path d={d} stroke="url(#meanderGrad)" strokeWidth="40" fill="none" strokeLinecap="round" style={{ animation: "pulse 2.4s ease-in-out infinite" }} />
        </svg>

        {branches.map((b) => {
          const isRight = b.side === "right";
          const yPx = (b.yPct / 100) * H;
          const trunkX = xAt(yPx);
          const leftPct = (trunkX / W) * 100;
          return (
            <div key={b.id} className="absolute" style={{ top: yPx - 36, left: `${leftPct}%`, transform: isRight ? "translate(40px,0)" : "translate(calc(-100% - 40px),0)" }}>
              <div className={`px-4 py-3 rounded-2xl ${isRight ? "bg-emerald-500/25 border-emerald-300/40" : "bg-rose-500/25 border-rose-300/40"} border-2 backdrop-blur-md flex items-center gap-3 min-w-[260px] shadow-2xl`}>
                <div className={`h-12 w-12 rounded-full ${b.color} grid place-items-center font-black text-base ring-2 ring-white/40 shrink-0`}>{b.initials}</div>
                <div className="flex-1 min-w-0">
                  <div className="text-base font-bold truncate">{b.name}</div>
                  <div className="text-sm text-white/85 truncate">{b.action}</div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <footer className="px-8 py-4 border-t border-white/10 text-sm text-white/60 text-center bg-black/40">
        <span className="font-bold text-white/80">Read it like:</span> the trunk swings to where action happens. Big positive = deep right swing. Big negative = deep left swing. Heartbeat from top to bottom.
      </footer>
    </div>
  );
}
