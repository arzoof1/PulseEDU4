const MOVERS = [
  { name: "Mason R.",     gr: 7, from: "L1.1", to: "L1.3", delta: +24, pts: [285, 295, 309] },
  { name: "Aaliyah B.",   gr: 6, from: "L1.2", to: "L2.1", delta: +21, pts: [298, 306, 319] },
  { name: "Devon E.",     gr: 7, from: "L2.1", to: "L2.2", delta: +18, pts: [318, 326, 336] },
  { name: "Jaxon K.",     gr: 6, from: "L1.3", to: "L2.1", delta: +17, pts: [305, 312, 322] },
  { name: "Isla J.",      gr: 8, from: "L2.2", to: "L3",   delta: +16, pts: [330, 339, 346] },
  { name: "Grace H.",     gr: 6, from: "L2.1", to: "L2.2", delta: +15, pts: [314, 323, 329] },
  { name: "Hassan I.",    gr: 8, from: "L1.1", to: "L1.2", delta: +14, pts: [282, 290, 296] },
  { name: "Camille D.",   gr: 7, from: "L1.3", to: "L2.1", delta: +13, pts: [308, 316, 321] },
  { name: "Liam M.",      gr: 8, from: "L2.1", to: "L2.2", delta: +12, pts: [320, 328, 332] },
  { name: "Brayden C.",   gr: 6, from: "L1.2", to: "L1.3", delta: +11, pts: [296, 302, 307] },
];

function Spark({ pts }: { pts: number[] }) {
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const range = Math.max(max - min, 1);
  const w = 38, h = 14;
  const stepX = w / (pts.length - 1);
  const points = pts.map((p, i) => `${i * stepX},${h - ((p - min) / range) * h}`).join(" ");
  return (
    <svg width={w} height={h} className="overflow-visible">
      <polyline
        points={points}
        fill="none"
        stroke="rgb(16,185,129)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle
        cx={(pts.length - 1) * stepX}
        cy={h - ((pts[pts.length - 1] - min) / range) * h}
        r="2"
        fill="rgb(16,185,129)"
      />
    </svg>
  );
}

export function TopMovers() {
  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-slate-50 to-slate-100 p-4 font-sans flex flex-col">
      <div className="mb-2">
        <div className="text-[10px] uppercase tracking-wider text-emerald-600 font-bold">
          ▲ Top Movers
        </div>
        <div className="text-lg font-bold text-slate-900 leading-tight">
          Biggest Climbs · PM3
        </div>
        <div className="text-[11px] text-slate-600">
          Celebrate these students this week
        </div>
      </div>

      <div className="flex-1 bg-white rounded-lg border border-slate-200 p-2 flex flex-col gap-1 overflow-hidden">
        {MOVERS.map((m, i) => (
          <div
            key={m.name}
            className="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-slate-50"
          >
            <div className="w-4 text-[10px] font-bold text-slate-400">
              {i + 1}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[11px] font-bold text-slate-900 truncate leading-tight">
                {m.name}
              </div>
              <div className="text-[9px] text-slate-500 leading-tight">
                G{m.gr} · {m.from} → {m.to}
              </div>
            </div>
            <Spark pts={m.pts} />
            <div className="w-9 text-right">
              <div className="text-[12px] font-bold text-emerald-600 leading-none">
                +{m.delta}
              </div>
              <div className="text-[8px] text-slate-500">pts</div>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-2 flex items-center justify-between text-[10px] text-slate-600">
        <span>Counterpart: ▼ Sliders tile</span>
        <span className="text-emerald-700 font-bold">10 / 671 students</span>
      </div>
    </div>
  );
}
