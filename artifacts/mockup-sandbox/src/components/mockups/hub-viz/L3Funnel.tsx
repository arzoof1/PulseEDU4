const STAGES = [
  { label: "Tested PM3",      sub: "All scored students",   count: 671, pct: 100, color: "bg-slate-400" },
  { label: "Above Low 1",     sub: "Past L1.1 floor",       count: 612, pct: 91,  color: "bg-red-400" },
  { label: "Above High 2",    sub: "Past L2.2 ceiling",     count: 398, pct: 59,  color: "bg-orange-400" },
  { label: "At Level 3+",     sub: "On or above grade",     count: 287, pct: 43,  color: "bg-green-500" },
];

export function L3Funnel() {
  const target = 60;
  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-slate-50 to-slate-100 p-4 font-sans flex flex-col">
      <div className="mb-2">
        <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
          On Track to Level 3
        </div>
        <div className="text-lg font-bold text-slate-900 leading-tight">
          Parrott · PM3 Funnel
        </div>
        <div className="text-[11px] text-slate-600">
          District target: {target}% at L3+ by end of year
        </div>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center gap-2 mt-2">
        {STAGES.map((s, i) => {
          const widthPct = 40 + (s.pct / 100) * 55;
          return (
            <div key={s.label} className="w-full flex flex-col items-center">
              <div
                className={`${s.color} text-white rounded-md shadow-md flex flex-col items-center justify-center py-3 transition-all`}
                style={{ width: `${widthPct}%`, minHeight: 64 }}
              >
                <div className="text-[20px] font-bold leading-none">
                  {s.count}
                </div>
                <div className="text-[10px] uppercase tracking-wider font-semibold opacity-95 mt-1">
                  {s.label}
                </div>
                <div className="text-[9px] opacity-80">{s.sub}</div>
              </div>
              {i < STAGES.length - 1 && (
                <div className="text-[9px] text-slate-500 my-0.5 flex items-center gap-1">
                  <span className="font-bold text-slate-700">
                    −{STAGES[i].count - STAGES[i + 1].count}
                  </span>
                  <span>fall off</span>
                  <span className="text-slate-400">▼</span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-3 rounded-lg bg-white p-3 shadow-sm border border-slate-200">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
              Current
            </div>
            <div className="text-2xl font-bold text-slate-900 leading-none">
              43%
              <span className="text-xs font-semibold text-slate-500 ml-1">
                at L3+
              </span>
            </div>
          </div>
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
              Gap
            </div>
            <div className="text-2xl font-bold text-amber-600 leading-none">
              −17
              <span className="text-xs font-semibold text-amber-600 ml-1">pts</span>
            </div>
          </div>
        </div>
        <div className="mt-2 h-2 bg-slate-100 rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-green-500 to-emerald-600 rounded-full"
            style={{ width: `${(43 / target) * 100}%` }}
          />
        </div>
        <div className="text-[10px] text-slate-500 mt-1 text-center">
          43 of {target}% target
        </div>
      </div>
    </div>
  );
}
