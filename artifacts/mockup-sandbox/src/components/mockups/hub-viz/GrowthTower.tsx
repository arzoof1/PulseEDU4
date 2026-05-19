const STUDENTS = [
  { name: "Aaliyah B.", pm1: [1, "L1"], pm2: [2, "L1"], pm3: [3, "L2"] },
  { name: "Brayden C.", pm1: [3, "L2"], pm2: [3, "L2"], pm3: [4, "L3"] },
  { name: "Camille D.", pm1: [4, "L3"], pm2: [4, "L3"], pm3: [5, "L3"] },
  { name: "Devon E.", pm1: [2, "L1"], pm2: [2, "L1"], pm3: [2, "L1"] },
  { name: "Elena F.", pm1: [5, "L3"], pm2: [6, "L4"], pm3: [7, "L4"] },
  { name: "Felix G.", pm1: [3, "L2"], pm2: [2, "L1"], pm3: [2, "L1"] },
  { name: "Grace H.", pm1: [4, "L3"], pm2: [5, "L3"], pm3: [6, "L4"] },
  { name: "Hassan I.", pm1: [1, "L1"], pm2: [1, "L1"], pm3: [2, "L1"] },
  { name: "Isla J.", pm1: [6, "L4"], pm2: [7, "L4"], pm3: [8, "L5"] },
  { name: "Jaxon K.", pm1: [2, "L1"], pm2: [3, "L2"], pm3: [4, "L3"] },
  { name: "Kira L.", pm1: [3, "L2"], pm2: [4, "L3"], pm3: [4, "L3"] },
  { name: "Liam M.", pm1: [4, "L3"], pm2: [4, "L3"], pm3: [5, "L3"] },
] as const;

const BAND: Record<string, string> = {
  L1: "bg-red-400",
  L2: "bg-orange-400",
  L3: "bg-green-500",
  L4: "bg-blue-500",
  L5: "bg-purple-500",
};

export function GrowthTower() {
  const maxH = 8;
  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-slate-50 to-slate-100 p-4 font-sans flex flex-col">
      <div className="mb-2">
        <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
          Class Growth Forest
        </div>
        <div className="text-lg font-bold text-slate-900 leading-tight">
          Mr. Hayes · ELA G6
        </div>
        <div className="text-xs text-slate-600">PM1 → PM2 → PM3 · n=116</div>
      </div>

      <div className="flex-1 flex items-end gap-[3px] mt-2 bg-white rounded-lg p-2 border border-slate-200">
        {STUDENTS.map((s) => {
          return (
            <div
              key={s.name}
              className="flex-1 flex flex-col items-center justify-end h-full gap-[1px]"
              title={s.name}
            >
              <div className="flex flex-col-reverse w-full gap-[1px] h-full justify-end">
                <div
                  className={`${BAND[s.pm1[1] as string]} w-full rounded-b-sm`}
                  style={{ height: `${(Number(s.pm1[0]) / maxH) * 100}%` }}
                />
                <div
                  className={`${BAND[s.pm2[1] as string]} w-full`}
                  style={{ height: `${(Number(s.pm2[0]) / maxH) * 100}%` }}
                />
                <div
                  className={`${BAND[s.pm3[1] as string]} w-full rounded-t-sm`}
                  style={{ height: `${(Number(s.pm3[0]) / maxH) * 100}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex justify-between text-[8px] text-slate-500 mt-1 px-2">
        {STUDENTS.map((s) => (
          <div
            key={s.name}
            className="flex-1 text-center truncate"
            style={{ writingMode: "vertical-rl", transform: "rotate(180deg)", height: 50 }}
          >
            {s.name}
          </div>
        ))}
      </div>

      <div className="mt-2 flex items-center justify-between text-[10px]">
        <div className="flex items-center gap-2">
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
        </div>
      </div>

      <div className="mt-3 rounded-lg bg-white p-2.5 shadow-sm border border-slate-200">
        <div className="flex items-baseline gap-2">
          <div className="text-2xl font-bold text-emerald-600">+9</div>
          <div className="text-[11px] text-slate-600">
            students at L3+ vs PM1
          </div>
        </div>
        <div className="text-[10px] text-slate-500 mt-0.5">
          7 climbed a sub-level · 2 fell · 3 held
        </div>
      </div>
    </div>
  );
}
