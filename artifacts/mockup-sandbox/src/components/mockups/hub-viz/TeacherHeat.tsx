const TEACHERS = [
  { name: "Hayes",     subj: "ELA G6",  dist: [12, 22, 48, 25,  9] },
  { name: "Chen",      subj: "ELA G6",  dist: [18, 28, 42, 20,  6] },
  { name: "Rodriguez", subj: "ELA G7",  dist: [10, 18, 50, 28, 11] },
  { name: "Park",      subj: "ELA G7",  dist: [15, 24, 46, 22,  7] },
  { name: "Walsh",     subj: "ELA G8",  dist: [ 8, 16, 44, 30, 10] },
  { name: "Johnson",   subj: "ELA G8",  dist: [11, 21, 47, 19,  4] },
  { name: "Foster",    subj: "Math G6", dist: [20, 30, 38, 19,  8] },
  { name: "Patel",     subj: "Math G6", dist: [14, 22, 49, 23,  7] },
  { name: "OBrien",    subj: "Math G7", dist: [16, 26, 44, 21,  8] },
  { name: "Tanaka",    subj: "Math G7", dist: [ 9, 19, 51, 27, 10] },
  { name: "Sanchez",   subj: "Math G8", dist: [22, 28, 36, 15,  4] },
  { name: "Williams",  subj: "Math G8", dist: [13, 23, 45, 19,  5] },
] as const;

const COLORS = ["bg-red-400", "bg-orange-400", "bg-green-500", "bg-blue-500", "bg-purple-500"];

export function TeacherHeat() {
  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-slate-50 to-slate-100 p-4 font-sans flex flex-col">
      <div className="mb-2">
        <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
          Teacher Level Mix
        </div>
        <div className="text-lg font-bold text-slate-900 leading-tight">
          Parrott · All Teachers
        </div>
        <div className="text-[11px] text-slate-600">PM3 distribution · L1 → L5</div>
      </div>

      <div className="flex-1 bg-white rounded-lg border border-slate-200 p-2 flex flex-col gap-1.5 overflow-hidden">
        {TEACHERS.map((t) => {
          const total = t.dist.reduce((a, b) => a + b, 0);
          const masteryPct = Math.round(((t.dist[2] + t.dist[3] + t.dist[4]) / total) * 100);
          return (
            <div key={t.name} className="flex items-center gap-1.5">
              <div className="w-[78px] shrink-0">
                <div className="text-[10px] font-bold text-slate-800 leading-tight">
                  {t.name}
                </div>
                <div className="text-[8px] text-slate-500 leading-tight">
                  {t.subj}
                </div>
              </div>
              <div className="flex-1 flex h-4 rounded overflow-hidden ring-1 ring-slate-200">
                {t.dist.map((v, i) => (
                  <div
                    key={i}
                    className={COLORS[i]}
                    style={{ width: `${(v / total) * 100}%` }}
                    title={`L${i + 1}: ${v}`}
                  />
                ))}
              </div>
              <div className="w-7 text-right text-[10px] font-bold text-slate-700">
                {masteryPct}%
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-2 flex items-center justify-between text-[9px] text-slate-600">
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 bg-red-400 rounded-sm" />L1
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 bg-orange-400 rounded-sm" />L2
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 bg-green-500 rounded-sm" />L3
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 bg-blue-500 rounded-sm" />L4
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 bg-purple-500 rounded-sm" />L5
        </span>
        <span className="font-bold text-slate-700">% L3+</span>
      </div>

      <div className="mt-2 text-[10px] text-slate-500 italic">
        Click any row → roster filtered to that teacher's PM3 students.
      </div>
    </div>
  );
}
