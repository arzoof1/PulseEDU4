import {
  AlertTriangle,
  Bell,
  ChevronRight,
  CircleDot,
  Clock,
  Eye,
  FileText,
  Filter,
  Flame,
  GitBranch,
  Megaphone,
  MessageSquareWarning,
  Plus,
  Search,
  Shield,
  Sparkles,
  TrendingDown,
  TrendingUp,
  UserPlus,
  Users,
} from "lucide-react";

const COLORS = {
  bg: "#F4F1EA",
  panel: "#FFFFFF",
  ink: "#1F1B16",
  inkSoft: "#5B5249",
  line: "#E7E0D2",
  brand: "#7A1F2B",
  brandSoft: "#F5E2E5",
  accent: "#C9A961",
  warn: "#B8531A",
  warnSoft: "#FBE6D4",
  alert: "#9B1C2E",
  alertSoft: "#F6D7DC",
  ok: "#3B6B4C",
  okSoft: "#DDEBDF",
  cool: "#2D4F6B",
  coolSoft: "#DCE6EE",
};

type AlertCard = {
  id: string;
  student: string;
  grade: string;
  rule: string;
  ruleKind: "frequency" | "always-peripheral" | "co-occurrence" | "stale" | "escalation";
  trend: "up" | "down" | "flat";
  count: number;
  windowLabel: string;
  hint: string;
  initials: string;
  color: string;
};

const ALERTS: AlertCard[] = [
  {
    id: "a1",
    student: "Marcus Whitfield",
    grade: "8",
    rule: "5+ involvements in 14 days",
    ruleKind: "frequency",
    trend: "up",
    count: 7,
    windowLabel: "vs 2 prior 14d",
    hint: "All as witness or peripheral — never named direct.",
    initials: "MW",
    color: COLORS.alert,
  },
  {
    id: "a2",
    student: "Janelle Ortiz",
    grade: "7",
    rule: "Always peripheral",
    ruleKind: "always-peripheral",
    trend: "up",
    count: 6,
    windowLabel: "6 of 6 incidents",
    hint: "Shows up near every cafeteria conflict this month.",
    initials: "JO",
    color: COLORS.warn,
  },
  {
    id: "a3",
    student: "Devontae Ruiz",
    grade: "8",
    rule: "Co-occurrence with Whitfield",
    ruleKind: "co-occurrence",
    trend: "up",
    count: 4,
    windowLabel: "4 shared incidents",
    hint: "Pattern across 3 cases — possible group dynamic.",
    initials: "DR",
    color: COLORS.brand,
  },
  {
    id: "a4",
    student: "Aaliyah Brooks",
    grade: "6",
    rule: "Rumor spreader, escalating",
    ruleKind: "escalation",
    trend: "up",
    count: 3,
    windowLabel: "loose → case opened",
    hint: "2 separate rumor reports merged into Case #114.",
    initials: "AB",
    color: COLORS.warn,
  },
  {
    id: "a5",
    student: "Kai Thompson",
    grade: "7",
    rule: "Stale witness statement",
    ruleKind: "stale",
    trend: "flat",
    count: 9,
    windowLabel: "9 days outstanding",
    hint: "Statement requested 04/30, no response.",
    initials: "KT",
    color: COLORS.cool,
  },
];

type Case = {
  id: string;
  title: string;
  status: "open" | "monitoring" | "escalated";
  incidents: number;
  students: number;
  lastActivity: string;
  lead: string;
};

const CASES: Case[] = [
  {
    id: "112",
    title: "8th-grade hallway altercation arc",
    status: "escalated",
    incidents: 5,
    students: 6,
    lastActivity: "2h ago",
    lead: "M. Alvarez",
  },
  {
    id: "114",
    title: "Locker-room rumor cluster",
    status: "open",
    incidents: 3,
    students: 4,
    lastActivity: "yesterday",
    lead: "T. Greene",
  },
  {
    id: "108",
    title: "Bus 14 ongoing tension",
    status: "monitoring",
    incidents: 4,
    students: 5,
    lastActivity: "3d ago",
    lead: "M. Alvarez",
  },
  {
    id: "101",
    title: "Cafeteria peripheral pattern (Ortiz)",
    status: "monitoring",
    incidents: 6,
    students: 8,
    lastActivity: "5d ago",
    lead: "S. Patel",
  },
];

type Incident = {
  id: string;
  when: string;
  type: string;
  summary: string;
  severity: 1 | 2 | 3 | 4;
  participants: number;
  location: string;
  case?: string;
};

const INCIDENTS: Incident[] = [
  {
    id: "i501",
    when: "Today · 11:42a",
    type: "Fight",
    summary: "Pushing match outside cafeteria; broken up by Coach Reilly.",
    severity: 4,
    participants: 5,
    location: "Cafeteria",
    case: "#112",
  },
  {
    id: "i500",
    when: "Today · 9:15a",
    type: "Rumor",
    summary: "Group chat screenshot reported by parent — about A. Brooks.",
    severity: 2,
    participants: 4,
    location: "Off-campus",
    case: "#114",
  },
  {
    id: "i499",
    when: "Yesterday · 2:08p",
    type: "Verbal",
    summary: "Heated exchange in hallway, no contact. Witnessed by 3 staff.",
    severity: 2,
    participants: 3,
    location: "B-wing hallway",
  },
  {
    id: "i498",
    when: "Yesterday · 12:31p",
    type: "Peripheral note",
    summary: "Whitfield observed near tension point — no role assigned.",
    severity: 1,
    participants: 1,
    location: "Cafeteria",
    case: "#101",
  },
  {
    id: "i497",
    when: "Mon · 8:05a",
    type: "Property",
    summary: "Backpack contents dumped; no witnesses came forward yet.",
    severity: 3,
    participants: 2,
    location: "Locker bay 2",
  },
];

type Statement = {
  student: string;
  grade: string;
  incident: string;
  requested: string;
  ageDays: number;
  status: "new" | "reminded" | "stale";
};

const STATEMENTS: Statement[] = [
  { student: "Kai Thompson", grade: "7", incident: "#487 Bus 14 verbal", requested: "Apr 30", ageDays: 9, status: "stale" },
  { student: "Selena Park", grade: "8", incident: "#491 Hallway push", requested: "May 5", ageDays: 4, status: "reminded" },
  { student: "Jorge Medina", grade: "6", incident: "#494 Locker dump", requested: "May 6", ageDays: 3, status: "reminded" },
  { student: "Mia Chen", grade: "7", incident: "#499 Hallway verbal", requested: "May 8", ageDays: 1, status: "new" },
  { student: "Tariq Holloway", grade: "8", incident: "#500 Rumor screenshot", requested: "May 9", ageDays: 0, status: "new" },
];

type Orbit = {
  rank: number;
  student: string;
  grade: string;
  peripheral: number;
  witness: number;
  direct: number;
  ratio: string;
  flag?: "always-peripheral" | "rising" | "co-occur";
};

const ORBIT: Orbit[] = [
  { rank: 1, student: "Marcus Whitfield", grade: "8", peripheral: 5, witness: 2, direct: 0, ratio: "100% non-direct", flag: "always-peripheral" },
  { rank: 2, student: "Janelle Ortiz", grade: "7", peripheral: 6, witness: 0, direct: 0, ratio: "100% peripheral", flag: "always-peripheral" },
  { rank: 3, student: "Devontae Ruiz", grade: "8", peripheral: 3, witness: 1, direct: 0, ratio: "100% non-direct", flag: "co-occur" },
  { rank: 4, student: "Aaliyah Brooks", grade: "6", peripheral: 1, witness: 0, direct: 2, ratio: "67% direct (rumor)", flag: "rising" },
  { rank: 5, student: "Selena Park", grade: "8", peripheral: 2, witness: 3, direct: 1, ratio: "50% witness", flag: "rising" },
  { rank: 6, student: "Tariq Holloway", grade: "8", peripheral: 2, witness: 2, direct: 0, ratio: "100% non-direct" },
  { rank: 7, student: "Mia Chen", grade: "7", peripheral: 1, witness: 3, direct: 0, ratio: "75% witness" },
  { rank: 8, student: "Jorge Medina", grade: "6", peripheral: 2, witness: 1, direct: 0, ratio: "100% non-direct" },
];

function severityChip(s: 1 | 2 | 3 | 4) {
  const map = {
    1: { bg: COLORS.coolSoft, fg: COLORS.cool, label: "Note" },
    2: { bg: COLORS.okSoft, fg: COLORS.ok, label: "Low" },
    3: { bg: COLORS.warnSoft, fg: COLORS.warn, label: "Med" },
    4: { bg: COLORS.alertSoft, fg: COLORS.alert, label: "High" },
  } as const;
  const c = map[s];
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold tracking-wide"
      style={{ background: c.bg, color: c.fg }}
    >
      <CircleDot className="h-2.5 w-2.5" />
      {c.label}
    </span>
  );
}

function ruleIcon(kind: AlertCard["ruleKind"]) {
  switch (kind) {
    case "frequency":
      return Flame;
    case "always-peripheral":
      return Eye;
    case "co-occurrence":
      return GitBranch;
    case "stale":
      return Clock;
    case "escalation":
      return TrendingUp;
  }
}

function trendBadge(t: AlertCard["trend"]) {
  if (t === "up") {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold"
        style={{ background: COLORS.alertSoft, color: COLORS.alert }}
      >
        <TrendingUp className="h-3 w-3" /> rising
      </span>
    );
  }
  if (t === "down") {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold"
        style={{ background: COLORS.okSoft, color: COLORS.ok }}
      >
        <TrendingDown className="h-3 w-3" /> easing
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold"
      style={{ background: COLORS.line, color: COLORS.inkSoft }}
    >
      flat
    </span>
  );
}

function statusPill(s: Case["status"]) {
  const map = {
    open: { bg: COLORS.brandSoft, fg: COLORS.brand, label: "Open" },
    monitoring: { bg: COLORS.coolSoft, fg: COLORS.cool, label: "Monitoring" },
    escalated: { bg: COLORS.alertSoft, fg: COLORS.alert, label: "Escalated" },
  } as const;
  const c = map[s];
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold"
      style={{ background: c.bg, color: c.fg }}
    >
      {c.label}
    </span>
  );
}

function statementPill(s: Statement["status"]) {
  const map = {
    new: { bg: COLORS.coolSoft, fg: COLORS.cool, label: "Requested" },
    reminded: { bg: COLORS.warnSoft, fg: COLORS.warn, label: "Reminded" },
    stale: { bg: COLORS.alertSoft, fg: COLORS.alert, label: "Stale" },
  } as const;
  const c = map[s];
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold"
      style={{ background: c.bg, color: c.fg }}
    >
      {c.label}
    </span>
  );
}

function Avatar({ initials, color }: { initials: string; color: string }) {
  return (
    <div
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white"
      style={{ background: color }}
    >
      {initials}
    </div>
  );
}

function AlertCardView({ a }: { a: AlertCard }) {
  const Icon = ruleIcon(a.ruleKind);
  return (
    <div
      className="flex flex-col gap-3 rounded-xl border p-4"
      style={{ borderColor: COLORS.line, background: COLORS.panel }}
    >
      <div className="flex items-start gap-3">
        <Avatar initials={a.initials} color={a.color} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="truncate text-sm font-semibold" style={{ color: COLORS.ink }}>
              {a.student}
            </div>
            <span className="text-[11px]" style={{ color: COLORS.inkSoft }}>
              · Gr {a.grade}
            </span>
          </div>
          <div
            className="mt-0.5 flex items-center gap-1.5 text-[12px] font-medium"
            style={{ color: a.color }}
          >
            <Icon className="h-3.5 w-3.5" />
            {a.rule}
          </div>
        </div>
        {trendBadge(a.trend)}
      </div>
      <div className="flex items-baseline gap-2">
        <div className="text-3xl font-bold tabular-nums" style={{ color: COLORS.ink }}>
          {a.count}
        </div>
        <div className="text-[11px]" style={{ color: COLORS.inkSoft }}>
          {a.windowLabel}
        </div>
      </div>
      <div
        className="rounded-md px-2.5 py-1.5 text-[12px] leading-snug"
        style={{ background: COLORS.bg, color: COLORS.inkSoft }}
      >
        {a.hint}
      </div>
      <div className="flex flex-wrap gap-1.5 pt-1">
        <button
          className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-semibold text-white"
          style={{ background: COLORS.ink }}
        >
          Open profile <ChevronRight className="h-3 w-3" />
        </button>
        <button
          className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11px] font-semibold"
          style={{ borderColor: COLORS.line, color: COLORS.ink }}
        >
          <GitBranch className="h-3 w-3" /> View graph
        </button>
        <button
          className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11px] font-semibold"
          style={{ borderColor: COLORS.line, color: COLORS.ink }}
        >
          <FileText className="h-3 w-3" /> Add to case
        </button>
        <button
          className="inline-flex items-center rounded-md px-2 py-1 text-[11px] font-semibold"
          style={{ color: COLORS.inkSoft }}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

function StatTile({
  label,
  value,
  delta,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string;
  delta: string;
  icon: typeof Bell;
  tone: "ink" | "alert" | "warn" | "cool" | "brand";
}) {
  const toneMap = {
    ink: COLORS.ink,
    alert: COLORS.alert,
    warn: COLORS.warn,
    cool: COLORS.cool,
    brand: COLORS.brand,
  };
  return (
    <div
      className="flex flex-col gap-2 rounded-xl border p-4"
      style={{ borderColor: COLORS.line, background: COLORS.panel }}
    >
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: COLORS.inkSoft }}>
          {label}
        </span>
        <Icon className="h-4 w-4" style={{ color: toneMap[tone] }} />
      </div>
      <div className="text-3xl font-bold tabular-nums" style={{ color: COLORS.ink }}>
        {value}
      </div>
      <div className="text-[11px]" style={{ color: COLORS.inkSoft }}>
        {delta}
      </div>
    </div>
  );
}

function OrbitChart() {
  // Bubble chart: x = total involvements, y = % non-direct, size = peripheral count.
  const W = 640;
  const H = 280;
  const padL = 44;
  const padB = 38;
  const padT = 16;
  const padR = 16;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  type Pt = { x: number; y: number; r: number; label: string; color: string; flag?: string };
  const pts: Pt[] = ORBIT.map((o) => {
    const total = o.peripheral + o.witness + o.direct;
    const nonDirectPct = total === 0 ? 0 : ((o.peripheral + o.witness) / total) * 100;
    const color =
      o.flag === "always-peripheral"
        ? COLORS.alert
        : o.flag === "co-occur"
        ? COLORS.brand
        : o.flag === "rising"
        ? COLORS.warn
        : COLORS.cool;
    return { x: total, y: nonDirectPct, r: 6 + o.peripheral * 3, label: o.student.split(" ")[1] ?? o.student, color };
  });
  const maxX = Math.max(8, ...pts.map((p) => p.x));
  const xs = (v: number) => padL + (v / maxX) * innerW;
  const ys = (v: number) => padT + innerH - (v / 100) * innerH;

  const yTicks = [0, 25, 50, 75, 100];
  const xTicks = Array.from({ length: maxX + 1 }, (_, i) => i).filter((i) => i % 2 === 0);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full">
      <rect x={padL} y={padT} width={innerW} height={innerH} fill={COLORS.bg} />
      {/* danger band: y >= 75% non-direct */}
      <rect x={padL} y={ys(100)} width={innerW} height={ys(75) - ys(100)} fill={COLORS.alertSoft} opacity={0.55} />
      <text x={padL + 6} y={ys(100) + 12} fontSize={9} fill={COLORS.alert} fontWeight={700}>
        FROM-A-DISTANCE BAND
      </text>
      {yTicks.map((t) => (
        <g key={`y${t}`}>
          <line x1={padL} x2={W - padR} y1={ys(t)} y2={ys(t)} stroke={COLORS.line} strokeDasharray="3 3" />
          <text x={padL - 6} y={ys(t) + 3} fontSize={9} fill={COLORS.inkSoft} textAnchor="end">
            {t}%
          </text>
        </g>
      ))}
      {xTicks.map((t) => (
        <g key={`x${t}`}>
          <text x={xs(t)} y={H - padB + 14} fontSize={9} fill={COLORS.inkSoft} textAnchor="middle">
            {t}
          </text>
        </g>
      ))}
      <text x={padL + innerW / 2} y={H - 6} fontSize={10} fill={COLORS.inkSoft} textAnchor="middle">
        Total involvements (14d)
      </text>
      <text
        x={12}
        y={padT + innerH / 2}
        fontSize={10}
        fill={COLORS.inkSoft}
        textAnchor="middle"
        transform={`rotate(-90 12 ${padT + innerH / 2})`}
      >
        % non-direct (peripheral + witness)
      </text>
      {pts.map((p, i) => (
        <g key={i}>
          <circle cx={xs(p.x)} cy={ys(p.y)} r={p.r} fill={p.color} fillOpacity={0.35} stroke={p.color} strokeWidth={1.5} />
          <text x={xs(p.x) + p.r + 4} y={ys(p.y) + 3} fontSize={10} fill={COLORS.ink} fontWeight={600}>
            {p.label}
          </text>
        </g>
      ))}
    </svg>
  );
}

export function Hub() {
  return (
    <div className="min-h-screen" style={{ background: COLORS.bg, color: COLORS.ink }}>
      <div className="mx-auto max-w-[1320px] px-8 py-8">
        {/* Header */}
        <div className="flex flex-wrap items-end justify-between gap-4 pb-6">
          <div>
            <div
              className="inline-flex items-center gap-2 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider"
              style={{ borderColor: COLORS.line, background: COLORS.panel, color: COLORS.brand }}
            >
              <Shield className="h-3.5 w-3.5" /> Core Team Only
            </div>
            <h1 className="mt-2 text-3xl font-bold tracking-tight" style={{ fontFamily: "'Playfair Display', serif" }}>
              Watchlist Hub
            </h1>
            <p className="mt-1 max-w-2xl text-sm" style={{ color: COLORS.inkSoft }}>
              Students surfacing across the Interaction Log — the ones showing up{" "}
              <span className="font-semibold" style={{ color: COLORS.brand }}>
                from a distance
              </span>{" "}
              but never quite in the middle. Triage alerts, open cases, request statements.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div
              className="flex items-center gap-2 rounded-md border px-2.5 py-1.5"
              style={{ borderColor: COLORS.line, background: COLORS.panel }}
            >
              <Search className="h-4 w-4" style={{ color: COLORS.inkSoft }} />
              <input
                placeholder="Find student or incident #"
                className="w-56 bg-transparent text-sm outline-none placeholder:text-[--ph]"
                style={{ ["--ph" as never]: COLORS.inkSoft } as React.CSSProperties}
              />
            </div>
            <button
              className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-semibold text-white shadow-sm"
              style={{ background: COLORS.brand }}
            >
              <Plus className="h-4 w-4" /> Log interaction
            </button>
          </div>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-4 gap-4">
          <StatTile label="Active alerts" value="5" delta="+2 since yesterday" icon={Bell} tone="alert" />
          <StatTile label="Open cases" value="4" delta="1 escalated to admin log" icon={FileText} tone="brand" />
          <StatTile label="Pending statements" value="5" delta="1 stale > 7 days" icon={MessageSquareWarning} tone="warn" />
          <StatTile label="Logged this week" value="18" delta="+6 vs last week" icon={Sparkles} tone="cool" />
        </div>

        {/* Filters */}
        <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border p-3" style={{ borderColor: COLORS.line, background: COLORS.panel }}>
          <Filter className="h-4 w-4" style={{ color: COLORS.inkSoft }} />
          <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: COLORS.inkSoft }}>
            Window
          </span>
          {["7 days", "14 days", "30 days", "Term"].map((w, i) => (
            <button
              key={w}
              className="rounded-md px-2.5 py-1 text-xs font-semibold"
              style={{
                background: i === 1 ? COLORS.ink : "transparent",
                color: i === 1 ? "#fff" : COLORS.ink,
                border: `1px solid ${i === 1 ? COLORS.ink : COLORS.line}`,
              }}
            >
              {w}
            </button>
          ))}
          <span className="ml-3 text-[11px] font-semibold uppercase tracking-wider" style={{ color: COLORS.inkSoft }}>
            Severity
          </span>
          {["Any", "Med+", "High only"].map((s, i) => (
            <button
              key={s}
              className="rounded-md border px-2.5 py-1 text-xs font-semibold"
              style={{
                background: i === 0 ? COLORS.bg : "transparent",
                borderColor: COLORS.line,
                color: COLORS.ink,
              }}
            >
              {s}
            </button>
          ))}
          <span className="ml-3 text-[11px] font-semibold uppercase tracking-wider" style={{ color: COLORS.inkSoft }}>
            Grade
          </span>
          {["All", "6", "7", "8"].map((g) => (
            <button
              key={g}
              className="rounded-md border px-2.5 py-1 text-xs font-semibold"
              style={{ borderColor: COLORS.line, color: COLORS.ink }}
            >
              {g}
            </button>
          ))}
          <div className="ml-auto text-[11px]" style={{ color: COLORS.inkSoft }}>
            Showing alerts triggered in the last 14 days · Lincoln Middle
          </div>
        </div>

        {/* Alerts strip */}
        <div className="mt-6 flex items-baseline justify-between">
          <h2 className="text-lg font-bold tracking-tight">Alerts requiring eyes</h2>
          <a className="text-xs font-semibold" style={{ color: COLORS.brand }}>
            See all rules →
          </a>
        </div>
        <div className="mt-3 grid grid-cols-5 gap-4">
          {ALERTS.map((a) => (
            <AlertCardView key={a.id} a={a} />
          ))}
        </div>

        {/* Two-column: orbit + cases */}
        <div className="mt-8 grid grid-cols-3 gap-4">
          <div
            className="col-span-2 rounded-xl border p-5"
            style={{ borderColor: COLORS.line, background: COLORS.panel }}
          >
            <div className="flex items-baseline justify-between">
              <div>
                <h2 className="text-lg font-bold tracking-tight">Top of orbit</h2>
                <p className="text-xs" style={{ color: COLORS.inkSoft }}>
                  Bubble = peripheral count. Y-axis = % of involvements that were{" "}
                  <span className="font-semibold">not</span> as a direct participant.
                </p>
              </div>
              <div className="flex items-center gap-3 text-[11px]" style={{ color: COLORS.inkSoft }}>
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: COLORS.alert }} /> Always peripheral
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: COLORS.warn }} /> Rising
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: COLORS.brand }} /> Co-occurring
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: COLORS.cool }} /> Watch
                </span>
              </div>
            </div>
            <div className="mt-2">
              <OrbitChart />
            </div>
            <div className="mt-2 overflow-hidden rounded-lg border" style={{ borderColor: COLORS.line }}>
              <table className="w-full text-sm">
                <thead style={{ background: COLORS.bg, color: COLORS.inkSoft }}>
                  <tr>
                    <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider">#</th>
                    <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider">Student</th>
                    <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wider">Periph.</th>
                    <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wider">Witness</th>
                    <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wider">Direct</th>
                    <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider">Pattern</th>
                  </tr>
                </thead>
                <tbody>
                  {ORBIT.map((o) => (
                    <tr key={o.rank} className="border-t" style={{ borderColor: COLORS.line }}>
                      <td className="px-3 py-2 text-xs tabular-nums" style={{ color: COLORS.inkSoft }}>
                        {o.rank}
                      </td>
                      <td className="px-3 py-2 text-sm font-semibold">
                        {o.student}{" "}
                        <span className="text-[11px] font-normal" style={{ color: COLORS.inkSoft }}>
                          · Gr {o.grade}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{o.peripheral}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{o.witness}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{o.direct}</td>
                      <td className="px-3 py-2 text-xs">
                        <span
                          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold"
                          style={{
                            background:
                              o.flag === "always-peripheral"
                                ? COLORS.alertSoft
                                : o.flag === "rising"
                                ? COLORS.warnSoft
                                : o.flag === "co-occur"
                                ? COLORS.brandSoft
                                : COLORS.bg,
                            color:
                              o.flag === "always-peripheral"
                                ? COLORS.alert
                                : o.flag === "rising"
                                ? COLORS.warn
                                : o.flag === "co-occur"
                                ? COLORS.brand
                                : COLORS.inkSoft,
                          }}
                        >
                          {o.ratio}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Active cases */}
          <div
            className="rounded-xl border p-5"
            style={{ borderColor: COLORS.line, background: COLORS.panel }}
          >
            <div className="flex items-baseline justify-between">
              <h2 className="text-lg font-bold tracking-tight">Active cases</h2>
              <button
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold"
                style={{ background: COLORS.bg, color: COLORS.ink }}
              >
                <Plus className="h-3 w-3" /> New
              </button>
            </div>
            <div className="mt-3 flex flex-col gap-2">
              {CASES.map((c) => (
                <div
                  key={c.id}
                  className="rounded-lg border p-3"
                  style={{ borderColor: COLORS.line, background: COLORS.bg }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-[11px] font-semibold" style={{ color: COLORS.inkSoft }}>
                        Case #{c.id}
                      </div>
                      <div className="truncate text-sm font-semibold">{c.title}</div>
                    </div>
                    {statusPill(c.status)}
                  </div>
                  <div className="mt-2 flex items-center justify-between text-[11px]" style={{ color: COLORS.inkSoft }}>
                    <span className="inline-flex items-center gap-3">
                      <span className="inline-flex items-center gap-1">
                        <FileText className="h-3 w-3" /> {c.incidents} inc.
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Users className="h-3 w-3" /> {c.students} students
                      </span>
                    </span>
                    <span>Last: {c.lastActivity}</span>
                  </div>
                  <div className="mt-1.5 flex items-center justify-between text-[11px]">
                    <span style={{ color: COLORS.inkSoft }}>Lead: {c.lead}</span>
                    <a className="font-semibold" style={{ color: COLORS.brand }}>
                      Open →
                    </a>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Two-column: incidents + statements */}
        <div className="mt-4 grid grid-cols-3 gap-4">
          <div
            className="col-span-2 rounded-xl border p-5"
            style={{ borderColor: COLORS.line, background: COLORS.panel }}
          >
            <div className="flex items-baseline justify-between">
              <h2 className="text-lg font-bold tracking-tight">Recent incidents</h2>
              <a className="text-xs font-semibold" style={{ color: COLORS.brand }}>
                Full log →
              </a>
            </div>
            <div className="mt-3 divide-y" style={{ borderColor: COLORS.line }}>
              {INCIDENTS.map((i) => (
                <div key={i.id} className="flex items-start gap-3 py-3">
                  <div
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md"
                    style={{ background: COLORS.bg, color: COLORS.brand }}
                  >
                    {i.type === "Fight" ? (
                      <AlertTriangle className="h-4 w-4" />
                    ) : i.type === "Rumor" ? (
                      <Megaphone className="h-4 w-4" />
                    ) : i.type === "Property" ? (
                      <Shield className="h-4 w-4" />
                    ) : i.type === "Peripheral note" ? (
                      <Eye className="h-4 w-4" />
                    ) : (
                      <MessageSquareWarning className="h-4 w-4" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: COLORS.inkSoft }}>
                        {i.when}
                      </span>
                      <span className="text-sm font-semibold">{i.type}</span>
                      {severityChip(i.severity)}
                      {i.case ? (
                        <span
                          className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold"
                          style={{ background: COLORS.brandSoft, color: COLORS.brand }}
                        >
                          Case {i.case}
                        </span>
                      ) : (
                        <span
                          className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold"
                          style={{ background: COLORS.bg, color: COLORS.inkSoft }}
                        >
                          Loose
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 truncate text-sm" style={{ color: COLORS.ink }}>
                      {i.summary}
                    </div>
                    <div className="mt-1 flex items-center gap-3 text-[11px]" style={{ color: COLORS.inkSoft }}>
                      <span className="inline-flex items-center gap-1">
                        <Users className="h-3 w-3" /> {i.participants} tagged
                      </span>
                      <span>· {i.location}</span>
                    </div>
                  </div>
                  <ChevronRight className="mt-2 h-4 w-4" style={{ color: COLORS.inkSoft }} />
                </div>
              ))}
            </div>
          </div>

          {/* Statements */}
          <div
            className="rounded-xl border p-5"
            style={{ borderColor: COLORS.line, background: COLORS.panel }}
          >
            <div className="flex items-baseline justify-between">
              <h2 className="text-lg font-bold tracking-tight">Witness statements</h2>
              <button
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold"
                style={{ background: COLORS.bg, color: COLORS.ink }}
              >
                <UserPlus className="h-3 w-3" /> Request
              </button>
            </div>
            <div className="mt-3 flex flex-col gap-2">
              {STATEMENTS.map((s) => (
                <div
                  key={s.student}
                  className="rounded-lg border p-3"
                  style={{ borderColor: COLORS.line, background: COLORS.bg }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold">
                        {s.student}{" "}
                        <span className="text-[11px] font-normal" style={{ color: COLORS.inkSoft }}>
                          · Gr {s.grade}
                        </span>
                      </div>
                      <div className="text-[11px]" style={{ color: COLORS.inkSoft }}>
                        {s.incident} · req. {s.requested}
                      </div>
                    </div>
                    {statementPill(s.status)}
                  </div>
                  <div className="mt-2 flex items-center justify-between">
                    <span className="text-[11px] font-semibold" style={{ color: s.ageDays >= 7 ? COLORS.alert : COLORS.inkSoft }}>
                      {s.ageDays === 0 ? "today" : `${s.ageDays}d outstanding`}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <button
                        className="rounded-md border px-2 py-0.5 text-[11px] font-semibold"
                        style={{ borderColor: COLORS.line, color: COLORS.ink }}
                      >
                        Remind
                      </button>
                      <button
                        className="rounded-md px-2 py-0.5 text-[11px] font-semibold text-white"
                        style={{ background: COLORS.ink }}
                      >
                        Mark complete
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-6 text-center text-[11px]" style={{ color: COLORS.inkSoft }}>
          Mockup · Watchlist Hub · PulseEDU Admin
        </div>
      </div>
    </div>
  );
}
