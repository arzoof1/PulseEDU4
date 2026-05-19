const STOPS = [
  { sub: "L5", label: "Level 5", band: "L5" },
  { sub: "L4", label: "Level 4", band: "L4" },
  { sub: "L3", label: "Level 3", band: "L3" },
  { sub: "L2.2", label: "High 2", band: "L2" },
  { sub: "L2.1", label: "Low 2", band: "L2" },
  { sub: "L1.3", label: "High 1", band: "L1" },
  { sub: "L1.2", label: "Mid 1", band: "L1" },
  { sub: "L1.1", label: "Low 1", band: "L1" },
] as const;

const BAND_COLOR: Record<string, string> = {
  L1: "bg-red-400 ring-red-300",
  L2: "bg-orange-400 ring-orange-300",
  L3: "bg-green-500 ring-green-300",
  L4: "bg-blue-500 ring-blue-300",
  L5: "bg-purple-500 ring-purple-300",
};

export function ClimbLadder() {
  const currentIdx = 6; // L1.2 (Mid 1)
  const startIdx = 7; // L1.1 (Low 1) at PM1
  const targetIdx = 5; // L1.3 (High 1)

  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-slate-50 to-slate-100 p-4 font-sans flex flex-col">
      <div className="mb-3">
        <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
          Sub-Level Climb
        </div>
        <div className="text-lg font-bold text-slate-900 leading-tight">
          Mason R. · Grade 7
        </div>
        <div className="text-xs text-slate-600">ELA Reading · PM2</div>
      </div>

      <div className="flex-1 flex gap-2 relative">
        <div className="flex flex-col justify-between flex-1 py-1">
          {STOPS.map((stop, i) => {
            const isCurrent = i === currentIdx;
            const isStart = i === startIdx;
            const isTarget = i === targetIdx;
            const isPast = i > currentIdx;
            return (
              <div
                key={stop.sub}
                className="flex items-center gap-2 relative"
                style={{ height: 14 }}
              >
                <div
                  className={[
                    "w-3 h-3 rounded-full ring-2",
                    isCurrent
                      ? `${BAND_COLOR[stop.band]} shadow-lg scale-150`
                      : isStart
                      ? "bg-slate-300 ring-slate-200 opacity-60"
                      : isPast
                      ? `${BAND_COLOR[stop.band]} opacity-30`
                      : "bg-slate-200 ring-slate-100",
                  ].join(" ")}
                />
                <div
                  className={[
                    "text-[11px] font-semibold",
                    isCurrent
                      ? "text-slate-900"
                      : isTarget
                      ? "text-emerald-700"
                      : "text-slate-500",
                  ].join(" ")}
                >
                  {stop.sub}
                </div>
                <div
                  className={[
                    "text-[10px]",
                    isCurrent
                      ? "text-slate-700"
                      : isTarget
                      ? "text-emerald-700 font-medium"
                      : "text-slate-400",
                  ].join(" ")}
                >
                  {stop.label}
                </div>
                {isCurrent && (
                  <div className="ml-auto text-[10px] font-bold text-slate-800 bg-white px-1.5 py-0.5 rounded shadow-sm">
                    NOW
                  </div>
                )}
                {isStart && !isCurrent && (
                  <div className="ml-auto text-[9px] text-slate-400 italic">
                    PM1
                  </div>
                )}
                {isTarget && (
                  <div className="ml-auto text-[9px] font-bold text-emerald-700">
                    +8
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="absolute left-[5px] top-2 bottom-2 w-px bg-slate-200 -z-0" />
      </div>

      <div className="mt-3 rounded-lg bg-white p-3 shadow-sm border border-slate-200">
        <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
          Next Stop
        </div>
        <div className="flex items-baseline gap-1 mt-1">
          <div className="text-xl font-bold text-emerald-600">+8</div>
          <div className="text-sm font-semibold text-slate-700">
            → High 1
          </div>
        </div>
        <div className="text-[11px] text-slate-500 mt-1">
          307 now · target 315
        </div>
        <div className="mt-2 inline-flex items-center gap-1 bg-emerald-50 text-emerald-700 text-[10px] font-bold px-2 py-1 rounded">
          ▲ L1.1 → L1.2 this window
        </div>
      </div>
    </div>
  );
}
