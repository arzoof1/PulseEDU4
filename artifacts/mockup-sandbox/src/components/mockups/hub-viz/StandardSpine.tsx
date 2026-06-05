type Cell = "mastery" | "near" | "below" | null;
const C: Record<string, string> = {
  mastery: "bg-emerald-500",
  near: "bg-amber-400",
  below: "bg-red-400",
  none: "bg-slate-200",
};

const STANDARDS: { cat: string; code: string; pm1: Cell; pm2: Cell; pm3: Cell }[] = [
  { cat: "Reading Prose & Poetry", code: "6.R.1.1", pm1: "below", pm2: "near", pm3: "mastery" },
  { cat: "", code: "6.R.1.2", pm1: "near", pm2: "near", pm3: "mastery" },
  { cat: "", code: "6.R.1.3", pm1: "mastery", pm2: "mastery", pm3: "mastery" },
  { cat: "", code: "6.R.1.4", pm1: "below", pm2: "below", pm3: "near" },
  { cat: "Reading Informational", code: "6.R.2.1", pm1: "near", pm2: "mastery", pm3: "mastery" },
  { cat: "", code: "6.R.2.2", pm1: "below", pm2: "near", pm3: "near" },
  { cat: "", code: "6.R.2.3", pm1: "mastery", pm2: "near", pm3: "below" },
  { cat: "", code: "6.R.2.4", pm1: "near", pm2: "mastery", pm3: "mastery" },
  { cat: "Reading Across Genres", code: "6.R.3.1", pm1: "below", pm2: "below", pm3: "near" },
  { cat: "", code: "6.R.3.2", pm1: "near", pm2: "mastery", pm3: "mastery" },
  { cat: "", code: "6.R.3.3", pm1: "mastery", pm2: "mastery", pm3: "mastery" },
  { cat: "Communication", code: "6.C.1.1", pm1: "below", pm2: "near", pm3: "mastery" },
  { cat: "", code: "6.C.1.2", pm1: "near", pm2: "near", pm3: "near" },
  { cat: "", code: "6.C.1.3", pm1: "below", pm2: "below", pm3: "below" },
  { cat: "Vocabulary", code: "6.V.1.1", pm1: "near", pm2: "mastery", pm3: "mastery" },
  { cat: "", code: "6.V.1.2", pm1: "mastery", pm2: "mastery", pm3: "mastery" },
  { cat: "", code: "6.V.1.3", pm1: "below", pm2: "near", pm3: "mastery" },
];

export function StandardSpine() {
  const cls = (c: Cell) => (c ? C[c] : C.none);
  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-slate-50 to-slate-100 p-4 font-sans flex flex-col">
      <div className="mb-2">
        <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
          Standard Mastery Spine
        </div>
        <div className="text-lg font-bold text-slate-900 leading-tight">
          ELA · Grade 6
        </div>
        <div className="text-[11px] text-slate-600">
          Per-benchmark PM1 · PM2 · PM3 · class avg
        </div>
      </div>

      <div className="flex-1 bg-white rounded-lg border border-slate-200 p-2 overflow-hidden">
        <div className="flex items-center justify-between text-[9px] text-slate-400 uppercase font-semibold pb-1 border-b border-slate-100 mb-1">
          <span>Benchmark</span>
          <span className="flex gap-2.5">
            <span>PM1</span>
            <span>PM2</span>
            <span>PM3</span>
          </span>
        </div>
        {STANDARDS.map((s, i) => (
          <div key={i}>
            {s.cat && (
              <div className="text-[9px] uppercase tracking-wider text-indigo-700 font-bold mt-1.5 mb-0.5">
                {s.cat}
              </div>
            )}
            <div className="flex items-center justify-between py-[2px]">
              <span className="text-[11px] text-slate-700 font-mono">
                {s.code}
              </span>
              <div className="flex items-center gap-1.5">
                <span className={`${cls(s.pm1)} w-3 h-3 rounded-sm`} />
                <span className={`${cls(s.pm2)} w-3 h-3 rounded-sm`} />
                <span className={`${cls(s.pm3)} w-3 h-3 rounded-sm`} />
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-2 flex items-center justify-between text-[10px] text-slate-600">
        <span className="flex items-center gap-1">
          <span className="w-2.5 h-2.5 bg-emerald-500 rounded-sm" />≥80%
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2.5 h-2.5 bg-amber-400 rounded-sm" />50–79%
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2.5 h-2.5 bg-red-400 rounded-sm" />&lt;50%
        </span>
      </div>
    </div>
  );
}
