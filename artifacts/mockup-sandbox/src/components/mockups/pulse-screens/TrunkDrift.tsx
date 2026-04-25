import { Heart, MoveRight } from "lucide-react";

type Branch = {
  id: number;
  side: "left" | "right";
  intensity: number;
  initials: string;
  color: string;
  name: string;
  action: string;
};

const branches: Branch[] = [
  { id: 1, side: "right", intensity: 0.95, initials: "MS", color: "bg-emerald-500", name: "Ms. Patel",   action: "Positive call home" },
  { id: 2, side: "right", intensity: 0.80, initials: "AR", color: "bg-emerald-400", name: "Aliyah R.",   action: "Trusted adult" },
  { id: 3, side: "right", intensity: 0.70, initials: "TC", color: "bg-emerald-400", name: "Tomás C.",    action: "+5 PBIS" },
  { id: 4, side: "left",  intensity: 0.30, initials: "JM", color: "bg-amber-500",   name: "Jordan M.",   action: "Bathroom 14 min" },
  { id: 5, side: "right", intensity: 0.85, initials: "MS", color: "bg-emerald-500", name: "Maya S.",     action: "Email home +" },
];

const W = 1280, H = 640, midX = W / 2;
const driftRight = 360;

const yAt = (i: number) => (i + 0.7) * (H / (branches.length + 0.5));
const xAt = (y: number) => midX + (y / H) * driftRight;

export function TrunkDrift() {
  const segments = 18;
  let d = `M ${midX} 0`;
  for (let i = 1; i <= segments; i++) {
    const y = (i / segments) * H;
    d += ` L ${xAt(y)} ${y}`;
  }

  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-[#0a0612] via-[#100819] to-[#06030d] text-white overflow-hidden relative">
      <header className="flex items-center justify-between px-8 pt-6 pb-4 border-b border-white/5">
        <div className="flex items-center gap-3">
          <div className="h-11 w-11 rounded-xl bg-gradient-to-br from-rose-500 to-violet-500 grid place-items-center"><Heart className="h-5 w-5 text-white fill-white" /></div>
          <div>
            <div className="text-[11px] uppercase tracking-[0.25em] text-white/50">Trunk variant</div>
            <div className="text-2xl font-black">DRIFT · trunk leans with the trend</div>
          </div>
        </div>
        <div className="px-4 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-400/40 text-emerald-200 text-xs font-bold flex items-center gap-1">
          <MoveRight className="h-3.5 w-3.5" /> Strong positive · drifted +{driftRight}px
        </div>
      </header>

      <div className="relative" style={{ height: H }}>
        <svg className="absolute inset-0 w-full h-full" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          <defs>
            <linearGradient id="driftGrad" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="#fb7185" stopOpacity="0.7" />
              <stop offset="0.5" stopColor="#ef4444" stopOpacity="1" />
              <stop offset="1" stopColor="#7f1d1d" stopOpacity="0.9" />
            </linearGradient>
            <filter id="driftGlow" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="14" />
            </filter>
          </defs>
          <line x1={midX} y1="0" x2={midX} y2={H} stroke="white" strokeOpacity="0.12" strokeDasharray="6 10" strokeWidth="2" />
          <text x={midX + 8} y="20" fill="white" fillOpacity="0.3" fontSize="11">center</text>
          <path d={d} stroke="url(#driftGrad)" strokeWidth="80" fill="none" strokeLinecap="round" filter="url(#driftGlow)" opacity="0.5" />
          <path d={d} stroke="url(#driftGrad)" strokeWidth="40" fill="none" strokeLinecap="round" style={{ animation: "pulse 2.4s ease-in-out infinite" }} />
        </svg>

        {branches.map((b, i) => {
          const isRight = b.side === "right";
          const yPx = yAt(i);
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
        <span className="font-bold text-white/80">Read it like:</span> the trunk is one straight line that pivots from the top. The longer a positive (or negative) trend holds, the further it leans by day's end.
      </footer>
    </div>
  );
}
