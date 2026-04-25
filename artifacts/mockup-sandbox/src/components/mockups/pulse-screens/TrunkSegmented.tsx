import { Heart, ChevronRight, ChevronLeft } from "lucide-react";

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
  { id: 1, side: "right", intensity: 0.85, initials: "MS", color: "bg-emerald-500", name: "Ms. Patel",   action: "Positive call home" },
  { id: 2, side: "left",  intensity: 0.95, initials: "DK", color: "bg-rose-500",    name: "Devon K.",    action: "Pull-out · ESE" },
  { id: 3, side: "left",  intensity: 0.50, initials: "JM", color: "bg-amber-500",   name: "Jordan M.",   action: "Bathroom 14 min" },
  { id: 4, side: "right", intensity: 0.65, initials: "TC", color: "bg-emerald-400", name: "Tomás C.",    action: "+5 PBIS" },
];

export function TrunkSegmented() {
  let cumX = 0;
  const segs = branches.map((b) => {
    const dx = (b.side === "right" ? 1 : -1) * (60 + b.intensity * 90);
    const startX = cumX;
    cumX += dx;
    return { ...b, startX, endX: cumX, dx };
  });
  const finalDrift = cumX;

  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-[#0a0612] via-[#100819] to-[#06030d] text-white overflow-hidden relative">
      <header className="flex items-center justify-between px-8 pt-6 pb-4 border-b border-white/5">
        <div className="flex items-center gap-3">
          <div className="h-11 w-11 rounded-xl bg-gradient-to-br from-rose-500 to-violet-500 grid place-items-center"><Heart className="h-5 w-5 text-white fill-white" /></div>
          <div>
            <div className="text-[11px] uppercase tracking-[0.25em] text-white/50">Trunk variant</div>
            <div className="text-2xl font-black">HINGED · trunk hinges at every entry</div>
          </div>
        </div>
        <div className={`px-4 py-1.5 rounded-full text-xs font-bold border ${finalDrift < 0 ? "bg-rose-500/10 border-rose-400/40 text-rose-200" : "bg-emerald-500/10 border-emerald-400/40 text-emerald-200"}`}>
          Net drift {finalDrift > 0 ? "+" : ""}{Math.round(finalDrift)}px
        </div>
      </header>

      <div className="relative" style={{ height: 640 }}>
        {/* Center reference */}
        <div className="absolute left-1/2 top-0 bottom-0 w-px border-l-2 border-dashed border-white/15" />
        <div className="absolute left-1/2 top-2 -translate-x-1/2 text-[10px] uppercase tracking-widest text-white/40 bg-black/40 px-2 rounded">center</div>

        <div className="absolute inset-0 flex flex-col">
          {segs.map((s) => {
            const isRight = s.side === "right";
            return (
              <div key={s.id} className="relative flex-1 flex items-center">
                {/* Hinge connector showing the lateral shift */}
                <div
                  className={`absolute top-0 h-[6px] ${isRight ? "bg-gradient-to-r from-rose-500 to-amber-400" : "bg-gradient-to-l from-rose-500 to-amber-400"} rounded-full shadow-[0_0_20px_rgba(251,113,133,0.6)]`}
                  style={{
                    left: `calc(50% + ${Math.min(s.startX, s.endX)}px)`,
                    width: `${Math.abs(s.dx)}px`,
                  }}
                />
                {/* Trunk segment, fat */}
                <div
                  className="absolute top-2 bottom-0 w-[60px] rounded-2xl bg-gradient-to-b from-rose-400 via-red-500 to-rose-700 shadow-[0_0_60px_-10px_rgba(239,68,68,0.9)]"
                  style={{ left: `calc(50% + ${s.endX}px - 30px)` }}
                />
                {/* Direction arrow on the trunk */}
                <div className="absolute top-3 z-10" style={{ left: `calc(50% + ${s.endX}px - 12px)` }}>
                  {isRight ? <ChevronRight className="h-6 w-6 text-white" /> : <ChevronLeft className="h-6 w-6 text-white" />}
                </div>

                {/* Branch pill */}
                <div
                  className="absolute top-1/2 -translate-y-1/2 z-20"
                  style={{
                    left: isRight ? `calc(50% + ${s.endX + 50}px)` : undefined,
                    right: isRight ? undefined : `calc(50% - ${s.endX - 50}px)`,
                  }}
                >
                  <div className={`px-4 py-3 rounded-2xl ${isRight ? "bg-emerald-500/25 border-emerald-300/40" : "bg-rose-500/25 border-rose-300/40"} border-2 backdrop-blur-md flex items-center gap-3 min-w-[260px] shadow-2xl`}>
                    <div className={`h-12 w-12 rounded-full ${s.color} grid place-items-center font-black text-base ring-2 ring-white/40 shrink-0`}>{s.initials}</div>
                    <div className="flex-1 min-w-0">
                      <div className="text-base font-bold truncate">{s.name}</div>
                      <div className="text-sm text-white/85 truncate">{s.action}</div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <footer className="px-8 py-4 border-t border-white/10 text-sm text-white/60 text-center bg-black/40">
        <span className="font-bold text-white/80">Read it like:</span> each event physically nudges the trunk left or right. Hinges show the kick direction. Trunk lands wherever the day's net behavior pushed it.
      </footer>
    </div>
  );
}
