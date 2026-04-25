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
  { id: 2, side: "left",  intensity: 0.55, initials: "JM", color: "bg-amber-500",   name: "Jordan M.",   action: "Bathroom pass",   detail: "14 min out of class" },
  { id: 3, side: "right", intensity: 0.78, initials: "AR", color: "bg-emerald-400", name: "Aliyah R.",   action: "Trusted adult",   detail: "Counselor check-in" },
  { id: 4, side: "left",  intensity: 0.85, initials: "DK", color: "bg-rose-500",    name: "Devon K.",    action: "Pull-out",        detail: "Disruptive · ESE referral" },
  { id: 5, side: "right", intensity: 0.65, initials: "TC", color: "bg-emerald-400", name: "Tomás C.",    action: "+5 PBIS",         detail: "Leadership in PE" },
  { id: 6, side: "left",  intensity: 0.40, initials: "RB", color: "bg-orange-500",  name: "Riya B.",     action: "Tardy",           detail: "Period 4 · 6 min late" },
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

export function TrunkSegmented() {
  // Each branch produces a cumulative horizontal hinge
  let cumX = 0;
  const segments = branches.map((b) => {
    const dx = (b.side === "right" ? 1 : -1) * (12 + b.intensity * 28);
    const startX = cumX;
    cumX += dx;
    return { ...b, startX, endX: cumX, dx };
  });

  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-[#0a0612] via-[#0d0817] to-[#06030d] text-white overflow-hidden relative">
      <header className="flex items-center justify-between px-6 pt-5 pb-3 border-b border-white/5 relative z-20">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-rose-500 to-violet-500 grid place-items-center"><Heart className="h-4 w-4 text-white fill-white" /></div>
          <div>
            <div className="text-[10px] uppercase tracking-[0.25em] text-white/50">Trunk variant · Hinged segments</div>
            <div className="text-base font-bold">Trunk hinges at each event · stacks visibly</div>
          </div>
        </div>
        <div className="px-3 py-1 rounded-full bg-rose-500/10 border border-rose-400/30 text-rose-200 text-[10px] uppercase tracking-widest flex items-center gap-1">
          <Activity className="h-3 w-3" /> Net trend negative · drifted left
        </div>
      </header>

      <div className="relative h-[520px] overflow-hidden">
        <div className="absolute inset-0 flex flex-col items-center pt-6 pb-6">
          {segments.map((s, i) => {
            const grad = colorForBranch(s.side, s.intensity);
            const isRight = s.side === "right";
            return (
              <div key={s.id} className="relative w-full" style={{ height: `${100 / segments.length}%` }}>
                {/* Trunk segment, translated by cumulative X */}
                <div
                  className="absolute top-0 left-1/2 w-[14px] rounded-md bg-gradient-to-b from-rose-500/80 via-red-500 to-rose-700/80 shadow-[0_0_30px_-5px_rgba(239,68,68,0.7)]"
                  style={{ height: "100%", transform: `translateX(calc(-50% + ${s.endX}px))` }}
                />
                {/* Connector showing the hinge */}
                <div
                  className="absolute top-0 h-[2px] bg-rose-300/40"
                  style={{
                    left: `calc(50% + ${Math.min(s.startX, s.endX)}px)`,
                    width: `${Math.abs(s.dx)}px`,
                  }}
                />
                {/* Branch pill */}
                <div
                  className="absolute top-1/2 -translate-y-1/2 flex items-center gap-2"
                  style={{
                    left: isRight ? `calc(50% + ${s.endX + 8}px)` : undefined,
                    right: isRight ? undefined : `calc(50% - ${s.endX - 8}px)`,
                    flexDirection: isRight ? "row" : "row-reverse",
                  }}
                >
                  <div className={`h-[3px] w-[40px] bg-gradient-to-${isRight ? "r" : "l"} ${grad} rounded-full`} />
                  <div className={`px-2 py-1.5 rounded-2xl bg-gradient-to-${isRight ? "r" : "l"} ${grad} border border-white/15 backdrop-blur flex items-center gap-2 min-w-[200px] max-w-[230px]`}>
                    <div className={`h-7 w-7 rounded-full ${s.color} grid place-items-center font-bold text-[10px] ring-2 ring-white/30 shrink-0`}>{s.initials}</div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[11px] font-semibold truncate">{s.name}</div>
                      <div className="text-[10px] text-white/85 truncate">{s.action}</div>
                      <div className="text-[9px] text-white/60 truncate">{s.detail}</div>
                    </div>
                  </div>
                </div>
                {/* Index marker */}
                <div className="absolute top-1 left-2 text-[9px] text-white/30 tabular-nums">#{i + 1}</div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="px-6 py-4 border-t border-white/10 text-[11px] text-white/50 text-center bg-black/30">
        Each event physically nudges the trunk left/right · cumulative drift = today's net direction.
      </div>
    </div>
  );
}
