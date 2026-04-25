import { Heart, MoveRight } from "lucide-react";

type Branch = {
  id: number;
  side: "left" | "right";
  initials: string;
  color: string;
  name: string;
  action: string;
  yPct: number;
};

const branches: Branch[] = [
  { id: 1, side: "right", initials: "MS", color: "bg-emerald-500", name: "Ms. Patel",   action: "Phone call home",      yPct: 8 },
  { id: 2, side: "left",  initials: "JM", color: "bg-amber-500",   name: "Jordan M.",   action: "Bathroom 14 min",      yPct: 20 },
  { id: 3, side: "right", initials: "AR", color: "bg-emerald-400", name: "Aliyah R.",   action: "Trusted adult",        yPct: 32 },
  { id: 4, side: "right", initials: "TC", color: "bg-emerald-400", name: "Tomás C.",    action: "+5 PBIS · Leadership", yPct: 44 },
  { id: 5, side: "left",  initials: "DK", color: "bg-rose-500",    name: "Devon K.",    action: "Pull-out · ESE",       yPct: 56 },
  { id: 6, side: "right", initials: "MS", color: "bg-lime-500",    name: "Maya S.",     action: "Email home +",         yPct: 68 },
  { id: 7, side: "left",  initials: "RB", color: "bg-orange-500",  name: "Riya B.",     action: "Tardy · Period 4",     yPct: 80 },
  { id: 8, side: "right", initials: "EL", color: "bg-emerald-500", name: "Mr. Lopez",   action: "Restorative circle",   yPct: 92 },
];

const W = 1280, H = 640, midX = W / 2;
const PILL_W = 240, PILL_PAD = 24;
const DRIFT = 220; // total drift in px right by the bottom
const xAt = (y: number) => midX + (y / H) * DRIFT;

export function TrunkDrift() {
  const topX = xAt(0);
  const botX = xAt(H);
  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-[#0a0612] via-[#100819] to-[#06030d] text-white overflow-hidden relative">
      <header className="flex items-center justify-between px-8 pt-6 pb-4 border-b border-white/5">
        <div className="flex items-center gap-3">
          <div className="h-11 w-11 rounded-xl bg-gradient-to-br from-rose-500 to-violet-500 grid place-items-center"><Heart className="h-5 w-5 text-white fill-white" /></div>
          <div>
            <div className="text-[11px] uppercase tracking-[0.25em] text-white/50">Variant C · Drift</div>
            <div className="text-xl font-bold">School Pulse — Trunk leans with the trend</div>
          </div>
        </div>
        <div className="px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-400/40 text-emerald-200 text-xs font-bold flex items-center gap-1.5">
          <MoveRight className="h-3.5 w-3.5" /> Strong positive · drifted +{DRIFT}px right
        </div>
      </header>

      <div className="relative" style={{ height: H }}>
        <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          <defs>
            <linearGradient id="driftGrad" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="#fb7185" stopOpacity="0.4" />
              <stop offset="0.5" stopColor="#ef4444" stopOpacity="1" />
              <stop offset="1" stopColor="#7f1d1d" stopOpacity="0.7" />
            </linearGradient>
            <filter id="driftGlow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="6" /></filter>
          </defs>
          {/* center reference (where it would be on a neutral day) */}
          <line x1={midX} y1="0" x2={midX} y2={H} stroke="white" strokeOpacity="0.12" strokeDasharray="4 8" strokeWidth="1" />
          <text x={midX - 40} y={H - 8} fill="white" fillOpacity="0.35" fontSize="11">neutral day</text>
          {/* Ghost trunk in dim showing the neutral position */}
          <line x1={midX} y1="20" x2={midX} y2={H - 20} stroke="white" strokeOpacity="0.06" strokeWidth="14" strokeLinecap="round" />
          {/* drift halo */}
          <line x1={topX} y1="20" x2={botX} y2={H - 20} stroke="url(#driftGrad)" strokeWidth="34" strokeLinecap="round" filter="url(#driftGlow)" opacity="0.55" />
          {/* drift core */}
          <line x1={topX} y1="20" x2={botX} y2={H - 20} stroke="url(#driftGrad)" strokeWidth="16" strokeLinecap="round" style={{ animation: "pulse 2.4s ease-in-out infinite" }} />
          {/* Drift arc indicator at bottom */}
          <path d={`M ${midX} ${H - 30} Q ${(midX + botX) / 2} ${H - 60}, ${botX - 8} ${H - 30}`} stroke="#34d399" strokeWidth="2" fill="none" strokeDasharray="3 3" />
          <text x={(midX + botX) / 2} y={H - 64} textAnchor="middle" fill="#34d399" fontSize="11" fontWeight="bold">+{DRIFT}px →</text>
        </svg>

        {branches.map((b) => {
          const yPx = (b.yPct / 100) * H;
          const trunkX = xAt(yPx);
          const isRight = b.side === "right";
          const pillInnerX = isRight ? W - PILL_PAD - PILL_W : PILL_PAD + PILL_W;
          const lineStart = Math.min(trunkX, pillInnerX);
          const lineWidth = Math.max(0, Math.abs(pillInnerX - trunkX));
          const branchColor = isRight ? "from-emerald-400/80 to-emerald-300/30" : "from-rose-400/80 to-rose-300/30";
          return (
            <div key={b.id}>
              <div
                className={`absolute h-[3px] rounded-full bg-gradient-to-${isRight ? "r" : "l"} ${branchColor}`}
                style={{ top: yPx + 24, left: lineStart, width: lineWidth }}
              />
              <div
                className={`absolute px-3 py-2 rounded-2xl ${isRight ? "bg-emerald-500/20 border-emerald-300/40" : "bg-rose-500/20 border-rose-300/40"} border-2 backdrop-blur-md flex items-center gap-2 shadow-xl`}
                style={{ top: yPx, [isRight ? "right" : "left"]: PILL_PAD, width: PILL_W } as React.CSSProperties}
              >
                <div className={`h-9 w-9 rounded-full ${b.color} grid place-items-center font-black text-xs ring-2 ring-white/40 shrink-0`}>{b.initials}</div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-bold truncate">{b.name}</div>
                  <div className="text-xs text-white/85 truncate">{b.action}</div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <footer className="px-8 py-4 border-t border-white/10 text-sm text-white/65 text-center bg-black/40">
        <span className="font-bold text-white/90">Read it like:</span> dashed line = neutral day. Bright trunk = today. The longer a trend holds, the further the trunk leans away from neutral. Resets every morning.
      </footer>
    </div>
  );
}
