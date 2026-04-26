import {
  Heart,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  Search,
  Filter,
  Calendar,
  Users,
  BookOpen,
  ShieldAlert,
  CalendarX,
  Activity,
  ChevronRight,
  Bookmark,
  Sparkles,
} from "lucide-react";

type Severity = "high" | "watch" | "info";

type Pillar = "academic" | "behavior" | "attendance" | "mtss";

type Signal = {
  label: string;
  value: string;
  pillar: Pillar;
  severity: Severity;
};

type WatchStudent = {
  id: string;
  initials: string;
  name: string;
  grade: number;
  tier: 1 | 2 | 3;
  topRiskLabel: string;
  topRiskSeverity: Severity;
  signals: Signal[];
  trend: { direction: "up" | "down" | "flat"; text: string };
  pillars: { academic: Severity | null; behavior: Severity | null; attendance: Severity | null; mtss: Severity | null };
  newThisWeek: boolean;
  avatarTone: string;
};

const STUDENTS: WatchStudent[] = [
  {
    id: "s1",
    initials: "DR",
    name: "Daniela Reyes",
    grade: 4,
    tier: 3,
    topRiskLabel: "Behavior escalating",
    topRiskSeverity: "high",
    signals: [
      { label: "Negatives", value: "9 in 7d", pillar: "behavior", severity: "high" },
      { label: "ISS days", value: "2", pillar: "behavior", severity: "high" },
      { label: "BQ Math", value: "yes", pillar: "academic", severity: "watch" },
    ],
    trend: { direction: "up", text: "↑ 6 more negatives than last week" },
    pillars: { academic: "watch", behavior: "high", attendance: null, mtss: "high" },
    newThisWeek: false,
    avatarTone: "from-rose-500 to-orange-400",
  },
  {
    id: "s2",
    initials: "JM",
    name: "Jamal Morrison",
    grade: 3,
    tier: 2,
    topRiskLabel: "Attendance + BQ ELA",
    topRiskSeverity: "high",
    signals: [
      { label: "Tardies", value: "11 in 30d", pillar: "attendance", severity: "high" },
      { label: "BQ ELA", value: "yes", pillar: "academic", severity: "high" },
      { label: "BQ Math", value: "yes", pillar: "academic", severity: "watch" },
    ],
    trend: { direction: "up", text: "First week on watch" },
    pillars: { academic: "high", behavior: null, attendance: "high", mtss: "watch" },
    newThisWeek: true,
    avatarTone: "from-violet-500 to-fuchsia-400",
  },
  {
    id: "s3",
    initials: "AT",
    name: "Aaliyah Thompson",
    grade: 5,
    tier: 2,
    topRiskLabel: "Bottom Quartile · ELA",
    topRiskSeverity: "watch",
    signals: [
      { label: "BQ ELA", value: "yes", pillar: "academic", severity: "watch" },
      { label: "Negatives", value: "3 in 7d", pillar: "behavior", severity: "watch" },
    ],
    trend: { direction: "down", text: "↓ Improving · -2 negatives" },
    pillars: { academic: "watch", behavior: "watch", attendance: null, mtss: "watch" },
    newThisWeek: false,
    avatarTone: "from-amber-500 to-yellow-400",
  },
  {
    id: "s4",
    initials: "TC",
    name: "Tomás Castillo",
    grade: 3,
    tier: 2,
    topRiskLabel: "MTSS Tier 2 · Reading",
    topRiskSeverity: "watch",
    signals: [
      { label: "Plan active", value: "42 days", pillar: "mtss", severity: "watch" },
      { label: "BQ ELA", value: "yes", pillar: "academic", severity: "watch" },
    ],
    trend: { direction: "flat", text: "Stable · holding gains" },
    pillars: { academic: "watch", behavior: null, attendance: null, mtss: "watch" },
    newThisWeek: false,
    avatarTone: "from-blue-500 to-cyan-400",
  },
  {
    id: "s5",
    initials: "SK",
    name: "Saanvi Krishnan",
    grade: 5,
    tier: 1,
    topRiskLabel: "New negatives this week",
    topRiskSeverity: "info",
    signals: [
      { label: "Negatives", value: "2 in 7d", pillar: "behavior", severity: "info" },
    ],
    trend: { direction: "up", text: "First time on watch" },
    pillars: { academic: null, behavior: "info", attendance: null, mtss: null },
    newThisWeek: true,
    avatarTone: "from-emerald-500 to-teal-400",
  },
  {
    id: "s6",
    initials: "MK",
    name: "Marcus King",
    grade: 4,
    tier: 3,
    topRiskLabel: "Behavior + ISS",
    topRiskSeverity: "high",
    signals: [
      { label: "Negatives", value: "7 in 7d", pillar: "behavior", severity: "high" },
      { label: "ISS days", value: "3", pillar: "behavior", severity: "high" },
      { label: "Tardies", value: "5 in 7d", pillar: "attendance", severity: "watch" },
    ],
    trend: { direction: "up", text: "↑ 4 more negatives than last week" },
    pillars: { academic: null, behavior: "high", attendance: "watch", mtss: "high" },
    newThisWeek: false,
    avatarTone: "from-red-500 to-rose-400",
  },
];

const SEVERITY_TONES: Record<Severity, { ring: string; bg: string; text: string; chip: string; dot: string; stripe: string }> = {
  high: {
    ring: "ring-rose-300",
    bg: "bg-rose-50",
    text: "text-rose-700",
    chip: "bg-rose-100 text-rose-700 border-rose-300",
    dot: "bg-rose-500",
    stripe: "bg-rose-500",
  },
  watch: {
    ring: "ring-amber-300",
    bg: "bg-amber-50",
    text: "text-amber-700",
    chip: "bg-amber-100 text-amber-800 border-amber-300",
    dot: "bg-amber-400",
    stripe: "bg-amber-400",
  },
  info: {
    ring: "ring-indigo-300",
    bg: "bg-indigo-50",
    text: "text-indigo-700",
    chip: "bg-indigo-100 text-indigo-700 border-indigo-300",
    dot: "bg-indigo-400",
    stripe: "bg-indigo-400",
  },
};

const PILLAR_ICONS: Record<Pillar, React.ComponentType<{ className?: string }>> = {
  academic: BookOpen,
  behavior: ShieldAlert,
  attendance: CalendarX,
  mtss: Activity,
};

const PILLAR_LABELS: Record<Pillar, string> = {
  academic: "Acad",
  behavior: "Beh",
  attendance: "Att",
  mtss: "MTSS",
};

const SAVED_VIEWS = [
  { name: "MTSS Team · This Week", count: 48, active: true },
  { name: "Tier 3 — needs attention", count: 14 },
  { name: "Tier 2 — needs attention", count: 24 },
  { name: "Bottom Quartile ELA", count: 31 },
  { name: "Bottom Quartile Math", count: 27 },
  { name: "New on watch this week", count: 9 },
];

function Avatar({ initials, tone, severity }: { initials: string; tone: string; severity: Severity }) {
  const ring = SEVERITY_TONES[severity].ring;
  return (
    <div
      className={`h-12 w-12 rounded-xl bg-gradient-to-br ${tone} grid place-items-center text-white text-sm font-black ring-4 ${ring} shadow-sm shrink-0`}
    >
      {initials}
    </div>
  );
}

function PillarStrip({ pillars }: { pillars: WatchStudent["pillars"] }) {
  const order: Pillar[] = ["academic", "behavior", "attendance", "mtss"];
  return (
    <div className="grid grid-cols-4 gap-1 ml-auto shrink-0">
      {order.map((p) => {
        const sev = pillars[p];
        const Icon = PILLAR_ICONS[p];
        const tone = sev ? SEVERITY_TONES[sev] : null;
        return (
          <div
            key={p}
            className={`flex flex-col items-center justify-center h-12 w-12 rounded-lg border ${
              tone ? `${tone.bg} border-transparent ${tone.text}` : "bg-slate-50 border-slate-200 text-slate-300"
            }`}
            title={PILLAR_LABELS[p]}
          >
            <Icon className="h-3.5 w-3.5" />
            <div className="text-[9px] font-bold uppercase tracking-wider mt-0.5">{PILLAR_LABELS[p]}</div>
          </div>
        );
      })}
    </div>
  );
}

function StudentCard({ s }: { s: WatchStudent }) {
  const tone = SEVERITY_TONES[s.topRiskSeverity];
  const TrendIcon = s.trend.direction === "up" ? TrendingUp : s.trend.direction === "down" ? TrendingDown : Activity;
  const trendColor =
    s.trend.direction === "up"
      ? s.topRiskSeverity === "high"
        ? "text-rose-600"
        : "text-amber-600"
      : s.trend.direction === "down"
      ? "text-emerald-600"
      : "text-slate-500";

  return (
    <div className="relative rounded-2xl bg-white border border-slate-200 shadow-sm hover:shadow-md hover:border-slate-300 transition overflow-hidden cursor-pointer group">
      <div className={`absolute left-0 top-0 bottom-0 w-1 ${tone.stripe}`} />
      {s.newThisWeek && (
        <div className="absolute top-2 right-2 flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-violet-100 text-violet-700 text-[9px] font-black uppercase tracking-wider border border-violet-200">
          <Sparkles className="h-2.5 w-2.5" /> New
        </div>
      )}
      <div className="p-4 pl-5">
        <div className="flex items-start gap-3">
          <Avatar initials={s.initials} tone={s.avatarTone} severity={s.topRiskSeverity} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <div className="text-base font-black tracking-tight text-slate-900 truncate">{s.name}</div>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 font-bold">G{s.grade}</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-black ${
                s.tier === 3 ? "bg-rose-100 text-rose-700" : s.tier === 2 ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-600"
              }`}>T{s.tier}</span>
            </div>
            <div className={`mt-1 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-bold border ${tone.chip}`}>
              <AlertTriangle className="h-3 w-3" />
              {s.topRiskLabel}
            </div>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {s.signals.map((sig, i) => {
            const sigTone = SEVERITY_TONES[sig.severity];
            const Icon = PILLAR_ICONS[sig.pillar];
            return (
              <div
                key={i}
                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-semibold border ${sigTone.chip}`}
              >
                <Icon className="h-2.5 w-2.5" />
                {sig.label}: <span className="font-black tabular-nums">{sig.value}</span>
              </div>
            );
          })}
        </div>

        <div className="mt-3 flex items-end justify-between gap-3">
          <div className={`flex items-center gap-1.5 text-[11px] font-semibold ${trendColor}`}>
            <TrendIcon className="h-3.5 w-3.5" />
            {s.trend.text}
          </div>
          <PillarStrip pillars={s.pillars} />
        </div>

        <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-400">
          <button className="flex items-center gap-1 hover:text-slate-700 font-semibold">
            <Bookmark className="h-3 w-3" /> Add to my watch list
          </button>
          <div className="flex items-center gap-1 text-slate-500 font-semibold group-hover:text-slate-900">
            Open profile <ChevronRight className="h-3.5 w-3.5" />
          </div>
        </div>
      </div>
    </div>
  );
}

export function WatchListRedesign() {
  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-slate-50 via-white to-slate-100 text-slate-900">
      {/* HEADER */}
      <header className="px-8 pt-6 pb-5 bg-white border-b border-slate-200">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2 text-xs uppercase tracking-[0.25em] text-slate-400">
            <Heart className="h-3.5 w-3.5 text-rose-500 fill-rose-500" /> Pulse · Insights · Watch List
          </div>
          <div className="text-[11px] text-slate-400">Parrott Middle · Updated 2 min ago</div>
        </div>

        <div className="flex items-end justify-between gap-6 flex-wrap">
          <div>
            <div className="text-3xl font-black tracking-tight">Students on watch</div>
            <div className="text-sm text-slate-500 mt-0.5">Sorted by severity · Click any card to open the whole-child profile</div>
          </div>

          {/* KPI STRIP */}
          <div className="flex items-stretch gap-2">
            {[
              { label: "On watch", value: 48, tone: "bg-slate-50 text-slate-900 border-slate-200" },
              { label: "High", value: 12, tone: "bg-rose-50 text-rose-700 border-rose-200" },
              { label: "Watch", value: 24, tone: "bg-amber-50 text-amber-700 border-amber-200" },
              { label: "Info", value: 12, tone: "bg-indigo-50 text-indigo-700 border-indigo-200" },
              { label: "New this wk", value: 9, tone: "bg-violet-50 text-violet-700 border-violet-200" },
            ].map((k) => (
              <div key={k.label} className={`px-4 py-2.5 rounded-xl border ${k.tone} min-w-[80px]`}>
                <div className="text-2xl font-black tabular-nums leading-none">{k.value}</div>
                <div className="text-[9px] uppercase tracking-wider font-bold mt-1 opacity-80">{k.label}</div>
              </div>
            ))}
          </div>
        </div>
      </header>

      {/* SAVED VIEW PILLS — surfaced instead of buried in a dropdown */}
      <div className="px-8 py-3 bg-white border-b border-slate-200 flex items-center gap-2 overflow-x-auto">
        <Bookmark className="h-3.5 w-3.5 text-slate-400 shrink-0" />
        <div className="text-[10px] uppercase tracking-wider font-bold text-slate-400 shrink-0 mr-2">Saved views</div>
        {SAVED_VIEWS.map((v) => (
          <button
            key={v.name}
            className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border transition ${
              v.active
                ? "bg-slate-900 text-white border-slate-900"
                : "bg-white text-slate-600 border-slate-200 hover:border-slate-300 hover:text-slate-900"
            }`}
          >
            {v.name}
            <span className={`tabular-nums ${v.active ? "text-slate-300" : "text-slate-400"}`}>{v.count}</span>
          </button>
        ))}
        <button className="shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-semibold text-slate-500 hover:text-slate-900">
          + Save current
        </button>
      </div>

      {/* FILTER BAR */}
      <div className="px-8 py-3 bg-slate-50 border-b border-slate-200 flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-sm">
          <Search className="h-3.5 w-3.5 text-slate-400" />
          <input
            placeholder="Quick lookup…"
            className="bg-transparent outline-none text-slate-700 placeholder-slate-400 w-44"
          />
        </div>
        <div className="flex items-center gap-1 px-2 py-1 rounded-lg bg-white border border-slate-200">
          <Calendar className="h-3.5 w-3.5 text-slate-400 ml-1" />
          {["3d", "7d", "15d", "30d"].map((w, i) => (
            <button
              key={w}
              className={`px-2 py-1 rounded text-xs font-semibold ${
                i === 1 ? "bg-slate-900 text-white" : "text-slate-500 hover:text-slate-900"
              }`}
            >
              {w}
            </button>
          ))}
        </div>
        <button className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-xs font-semibold text-slate-600 hover:text-slate-900">
          <Filter className="h-3.5 w-3.5" /> Grade · Tier · Flags
        </button>
        <button className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-xs font-semibold text-slate-600 hover:text-slate-900">
          <Users className="h-3.5 w-3.5" /> Whole school
        </button>
        <div className="ml-auto text-xs text-slate-500 font-semibold">
          Showing <span className="text-slate-900 font-black tabular-nums">6</span> of 48
        </div>
      </div>

      {/* CARD GRID */}
      <div className="px-8 py-6 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {STUDENTS.map((s) => (
          <StudentCard key={s.id} s={s} />
        ))}
      </div>

      <div className="px-8 pb-8 text-center">
        <button className="px-4 py-2 rounded-lg bg-white border border-slate-200 text-sm font-semibold text-slate-600 hover:text-slate-900 hover:border-slate-300">
          Load 42 more →
        </button>
      </div>
    </div>
  );
}
