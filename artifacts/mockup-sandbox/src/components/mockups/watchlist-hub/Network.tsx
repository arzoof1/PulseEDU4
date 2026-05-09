import {
  ArrowLeft,
  Calendar,
  ChevronRight,
  CircleDot,
  Eye,
  Filter,
  GitBranch,
  Layers,
  Megaphone,
  MessageSquareWarning,
  Minus,
  Plus,
  Search,
  Shield,
  Sparkles,
  Users,
  Zap,
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
  graphBg: "#FAF7F0",
};

type Role = "direct" | "target" | "instigator" | "rumor" | "witness" | "peripheral" | "deescalator";

const ROLE_META: Record<Role, { label: string; color: string; soft: string }> = {
  direct: { label: "Direct", color: COLORS.alert, soft: COLORS.alertSoft },
  target: { label: "Target", color: COLORS.brand, soft: COLORS.brandSoft },
  instigator: { label: "Instigator", color: "#7A2E1A", soft: "#EFD9CF" },
  rumor: { label: "Rumor spreader", color: COLORS.warn, soft: COLORS.warnSoft },
  witness: { label: "Witness", color: COLORS.cool, soft: COLORS.coolSoft },
  peripheral: { label: "Peripheral", color: "#7A6B5A", soft: "#E6DFD3" },
  deescalator: { label: "De-escalator", color: COLORS.ok, soft: COLORS.okSoft },
};

type Flag = "always-peripheral" | "rising" | "co-occur" | "watch" | undefined;

type Node = {
  id: string;
  name: string;
  initials: string;
  grade: 6 | 7 | 8;
  cluster: "A" | "B" | "C" | "D";
  x: number;
  y: number;
  size: number; // total involvements
  flag: Flag;
  primaryRole: Role;
};

type Edge = {
  a: string;
  b: string;
  weight: number; // # of shared incidents
  caseId?: string; // shared case id
  kind: "incident" | "rumor" | "peripheral";
};

// Manually placed nodes — small school-week subset, three loose clusters + a satellite.
const NODES: Node[] = [
  // Cluster A: 8th-grade hallway arc (Case #112)
  { id: "mw", name: "Marcus Whitfield", initials: "MW", grade: 8, cluster: "A", x: 360, y: 230, size: 7, flag: "always-peripheral", primaryRole: "peripheral" },
  { id: "dr", name: "Devontae Ruiz", initials: "DR", grade: 8, cluster: "A", x: 470, y: 170, size: 4, flag: "co-occur", primaryRole: "peripheral" },
  { id: "tr", name: "Trey Robinson", initials: "TR", grade: 8, cluster: "A", x: 540, y: 290, size: 5, flag: undefined, primaryRole: "direct" },
  { id: "jb", name: "Jamal Bell", initials: "JB", grade: 8, cluster: "A", x: 410, y: 340, size: 4, flag: undefined, primaryRole: "instigator" },
  { id: "tk", name: "Tyrese King", initials: "TK", grade: 8, cluster: "A", x: 290, y: 320, size: 3, flag: undefined, primaryRole: "target" },
  { id: "th", name: "Tariq Holloway", initials: "TH", grade: 8, cluster: "A", x: 250, y: 200, size: 4, flag: undefined, primaryRole: "witness" },

  // Cluster B: 7th-grade cafeteria pattern (Case #101)
  { id: "jo", name: "Janelle Ortiz", initials: "JO", grade: 7, cluster: "B", x: 850, y: 220, size: 6, flag: "always-peripheral", primaryRole: "peripheral" },
  { id: "mc", name: "Mia Chen", initials: "MC", grade: 7, cluster: "B", x: 950, y: 290, size: 4, flag: undefined, primaryRole: "witness" },
  { id: "kt", name: "Kai Thompson", initials: "KT", grade: 7, cluster: "B", x: 770, y: 310, size: 4, flag: undefined, primaryRole: "witness" },
  { id: "rs", name: "Riley Sawyer", initials: "RS", grade: 7, cluster: "B", x: 920, y: 170, size: 3, flag: undefined, primaryRole: "direct" },
  { id: "no", name: "Naomi Okafor", initials: "NO", grade: 7, cluster: "B", x: 800, y: 130, size: 2, flag: undefined, primaryRole: "deescalator" },

  // Cluster C: 6th-grade rumor cluster (Case #114)
  { id: "ab", name: "Aaliyah Brooks", initials: "AB", grade: 6, cluster: "C", x: 380, y: 580, size: 3, flag: "rising", primaryRole: "rumor" },
  { id: "jm", name: "Jorge Medina", initials: "JM", grade: 6, cluster: "C", x: 290, y: 640, size: 3, flag: undefined, primaryRole: "target" },
  { id: "lc", name: "Lila Carter", initials: "LC", grade: 6, cluster: "C", x: 480, y: 640, size: 2, flag: undefined, primaryRole: "rumor" },
  { id: "eh", name: "Elena Hayes", initials: "EH", grade: 6, cluster: "C", x: 400, y: 700, size: 2, flag: undefined, primaryRole: "witness" },

  // Cluster D: Bus 14 (Case #108)
  { id: "sp", name: "Selena Park", initials: "SP", grade: 8, cluster: "D", x: 850, y: 580, size: 6, flag: "rising", primaryRole: "witness" },
  { id: "ip", name: "Isaac Park", initials: "IP", grade: 6, cluster: "D", x: 920, y: 660, size: 3, flag: undefined, primaryRole: "direct" },
  { id: "dc", name: "Dante Cole", initials: "DC", grade: 8, cluster: "D", x: 760, y: 660, size: 4, flag: undefined, primaryRole: "instigator" },
  { id: "ja", name: "Jada Allen", initials: "JA", grade: 7, cluster: "D", x: 870, y: 720, size: 2, flag: undefined, primaryRole: "deescalator" },

  // Bridge nodes
  { id: "br1", name: "Tariq Holloway*", initials: "·", grade: 8, cluster: "A", x: 660, y: 430, size: 0, flag: undefined, primaryRole: "witness" },
];

// Edges; weights drive line thickness, kind drives color/style.
const EDGES: Edge[] = [
  // Cluster A
  { a: "mw", b: "dr", weight: 4, caseId: "112", kind: "peripheral" },
  { a: "mw", b: "tr", weight: 2, caseId: "112", kind: "incident" },
  { a: "mw", b: "jb", weight: 3, caseId: "112", kind: "peripheral" },
  { a: "dr", b: "jb", weight: 3, caseId: "112", kind: "incident" },
  { a: "tr", b: "tk", weight: 2, caseId: "112", kind: "incident" },
  { a: "jb", b: "tk", weight: 2, caseId: "112", kind: "incident" },
  { a: "th", b: "mw", weight: 2, kind: "peripheral" },
  { a: "th", b: "dr", weight: 1, kind: "peripheral" },

  // Cluster B
  { a: "jo", b: "mc", weight: 3, caseId: "101", kind: "peripheral" },
  { a: "jo", b: "kt", weight: 2, caseId: "101", kind: "peripheral" },
  { a: "jo", b: "rs", weight: 2, caseId: "101", kind: "peripheral" },
  { a: "rs", b: "mc", weight: 2, caseId: "101", kind: "incident" },
  { a: "no", b: "rs", weight: 1, caseId: "101", kind: "incident" },
  { a: "kt", b: "mc", weight: 1, kind: "peripheral" },

  // Cluster C
  { a: "ab", b: "jm", weight: 2, caseId: "114", kind: "rumor" },
  { a: "ab", b: "lc", weight: 2, caseId: "114", kind: "rumor" },
  { a: "lc", b: "jm", weight: 1, caseId: "114", kind: "rumor" },
  { a: "eh", b: "ab", weight: 1, kind: "peripheral" },
  { a: "eh", b: "jm", weight: 1, kind: "peripheral" },

  // Cluster D
  { a: "sp", b: "dc", weight: 3, caseId: "108", kind: "incident" },
  { a: "sp", b: "ip", weight: 2, caseId: "108", kind: "incident" },
  { a: "dc", b: "ip", weight: 2, caseId: "108", kind: "incident" },
  { a: "ja", b: "sp", weight: 1, caseId: "108", kind: "incident" },
  { a: "ja", b: "dc", weight: 1, kind: "peripheral" },

  // Bridges between clusters — the interesting part
  { a: "th", b: "kt", weight: 2, kind: "peripheral" }, // A ↔ B
  { a: "mw", b: "sp", weight: 1, kind: "peripheral" }, // A ↔ D (Whitfield + rising 8th)
  { a: "ab", b: "lc", weight: 1, kind: "rumor" },
  { a: "jo", b: "mc", weight: 1, kind: "peripheral" },
];

const SELECTED_ID = "mw"; // Whitfield is the focal point.

const NODE_BY_ID = Object.fromEntries(NODES.map((n) => [n.id, n] as const));

function clusterFill(c: Node["cluster"]) {
  switch (c) {
    case "A":
      return "rgba(155, 28, 46, 0.07)"; // alert tint
    case "B":
      return "rgba(45, 79, 107, 0.07)"; // cool tint
    case "C":
      return "rgba(184, 83, 26, 0.07)"; // warn tint
    case "D":
      return "rgba(122, 31, 43, 0.06)"; // brand tint
  }
}

function clusterLabel(c: Node["cluster"]) {
  switch (c) {
    case "A":
      return "Case #112 · 8th hallway arc";
    case "B":
      return "Case #101 · 7th cafeteria";
    case "C":
      return "Case #114 · rumor cluster";
    case "D":
      return "Case #108 · Bus 14";
  }
}

function NetworkSVG() {
  const W = 1180;
  const H = 820;

  // Convex-ish hull rectangles per cluster (manually fit).
  const hulls: { c: Node["cluster"]; x: number; y: number; w: number; h: number; tx: number; ty: number }[] = [
    { c: "A", x: 200, y: 110, w: 410, h: 280, tx: 410, ty: 100 },
    { c: "B", x: 720, y: 90, w: 290, h: 260, tx: 870, ty: 80 },
    { c: "C", x: 240, y: 530, w: 280, h: 210, tx: 380, ty: 520 },
    { c: "D", x: 720, y: 540, w: 240, h: 230, tx: 850, ty: 530 },
  ];

  const selected = NODE_BY_ID[SELECTED_ID];

  const edgeColor = (kind: Edge["kind"]) =>
    kind === "rumor" ? COLORS.warn : kind === "incident" ? COLORS.alert : "#A89A85";

  const isSelectedEdge = (e: Edge) => e.a === SELECTED_ID || e.b === SELECTED_ID;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full">
      <defs>
        <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
          <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#EAE2D0" strokeWidth="0.5" />
        </pattern>
        <radialGradient id="selGlow">
          <stop offset="0%" stopColor={COLORS.alert} stopOpacity="0.35" />
          <stop offset="100%" stopColor={COLORS.alert} stopOpacity="0" />
        </radialGradient>
      </defs>

      <rect x={0} y={0} width={W} height={H} fill={COLORS.graphBg} />
      <rect x={0} y={0} width={W} height={H} fill="url(#grid)" />

      {/* Cluster halos */}
      {hulls.map((h) => (
        <g key={h.c}>
          <rect
            x={h.x}
            y={h.y}
            width={h.w}
            height={h.h}
            rx={32}
            fill={clusterFill(h.c)}
            stroke="#D9CFB8"
            strokeDasharray="4 6"
            strokeWidth={1}
          />
          <text
            x={h.tx}
            y={h.ty}
            fontSize={11}
            fontWeight={700}
            fill={COLORS.inkSoft}
            textAnchor="middle"
            style={{ letterSpacing: 0.6, textTransform: "uppercase" }}
          >
            {clusterLabel(h.c)}
          </text>
        </g>
      ))}

      {/* Selected node glow */}
      <circle cx={selected.x} cy={selected.y} r={90} fill="url(#selGlow)" />

      {/* Edges (non-selected first so selected sit on top) */}
      {EDGES.filter((e) => !isSelectedEdge(e)).map((e, i) => {
        const A = NODE_BY_ID[e.a];
        const B = NODE_BY_ID[e.b];
        if (!A || !B) return null;
        return (
          <line
            key={`e${i}`}
            x1={A.x}
            y1={A.y}
            x2={B.x}
            y2={B.y}
            stroke={edgeColor(e.kind)}
            strokeOpacity={0.35}
            strokeWidth={Math.max(1, e.weight * 0.9)}
            strokeDasharray={e.kind === "peripheral" ? "5 4" : undefined}
          />
        );
      })}

      {/* Selected edges (highlighted) */}
      {EDGES.filter(isSelectedEdge).map((e, i) => {
        const A = NODE_BY_ID[e.a];
        const B = NODE_BY_ID[e.b];
        if (!A || !B) return null;
        return (
          <g key={`se${i}`}>
            <line
              x1={A.x}
              y1={A.y}
              x2={B.x}
              y2={B.y}
              stroke={edgeColor(e.kind)}
              strokeOpacity={0.95}
              strokeWidth={Math.max(2, e.weight * 1.4)}
              strokeDasharray={e.kind === "peripheral" ? "5 4" : undefined}
            />
            <text
              x={(A.x + B.x) / 2}
              y={(A.y + B.y) / 2 - 4}
              fontSize={9}
              fill={edgeColor(e.kind)}
              fontWeight={700}
              textAnchor="middle"
              style={{ paintOrder: "stroke", stroke: COLORS.graphBg, strokeWidth: 3 }}
            >
              {e.weight}× {e.kind === "peripheral" ? "near" : e.kind === "rumor" ? "rumor" : "incident"}
              {e.caseId ? ` · #${e.caseId}` : ""}
            </text>
          </g>
        );
      })}

      {/* Nodes */}
      {NODES.filter((n) => n.size > 0).map((n) => {
        const r = 12 + n.size * 2.2;
        const meta = ROLE_META[n.primaryRole];
        const ringColor =
          n.flag === "always-peripheral"
            ? COLORS.alert
            : n.flag === "rising"
            ? COLORS.warn
            : n.flag === "co-occur"
            ? COLORS.brand
            : "transparent";
        const isSelected = n.id === SELECTED_ID;
        return (
          <g key={n.id}>
            {ringColor !== "transparent" && (
              <circle cx={n.x} cy={n.y} r={r + 5} fill="none" stroke={ringColor} strokeWidth={2.5} />
            )}
            <circle
              cx={n.x}
              cy={n.y}
              r={r}
              fill={meta.soft}
              stroke={meta.color}
              strokeWidth={isSelected ? 3 : 1.5}
            />
            <text
              x={n.x}
              y={n.y + 4}
              fontSize={Math.max(10, r * 0.55)}
              fontWeight={800}
              fill={meta.color}
              textAnchor="middle"
            >
              {n.initials}
            </text>
            <text
              x={n.x}
              y={n.y + r + 12}
              fontSize={10}
              fontWeight={isSelected ? 700 : 500}
              fill={COLORS.ink}
              textAnchor="middle"
              style={{ paintOrder: "stroke", stroke: COLORS.graphBg, strokeWidth: 3 }}
            >
              {n.name.split(" ")[1] ?? n.name} · {n.grade}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function FilterPill({ label, active = false, icon: Icon }: { label: string; active?: boolean; icon?: typeof Eye }) {
  return (
    <button
      className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-semibold"
      style={{
        background: active ? COLORS.ink : "transparent",
        color: active ? "#fff" : COLORS.ink,
        border: `1px solid ${active ? COLORS.ink : COLORS.line}`,
      }}
    >
      {Icon ? <Icon className="h-3 w-3" /> : null}
      {label}
    </button>
  );
}

function RoleSwatch({ role }: { role: Role }) {
  const m = ROLE_META[role];
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px]" style={{ color: COLORS.inkSoft }}>
      <span
        className="inline-block h-2.5 w-2.5 rounded-full"
        style={{ background: m.soft, border: `2px solid ${m.color}` }}
      />
      {m.label}
    </span>
  );
}

type Connection = { id: string; weight: number; kind: Edge["kind"]; caseId?: string };

const SELECTED = NODE_BY_ID[SELECTED_ID];
const SELECTED_CONNECTIONS: Connection[] = EDGES.filter(
  (e) => e.a === SELECTED_ID || e.b === SELECTED_ID,
).map((e) => ({
  id: e.a === SELECTED_ID ? e.b : e.a,
  weight: e.weight,
  kind: e.kind,
  caseId: e.caseId,
}));

const ROLE_BREAKDOWN = [
  { role: "peripheral" as Role, count: 5 },
  { role: "witness" as Role, count: 2 },
  { role: "direct" as Role, count: 0 },
  { role: "target" as Role, count: 0 },
  { role: "instigator" as Role, count: 0 },
];

const RECENT_FOR_SELECTED = [
  { when: "Today · 11:42a", text: "Cafeteria push-up — observed near scene, no role assigned.", case: "#112" },
  { when: "Mon · 1:15p", text: "Hallway altercation — listed as witness.", case: "#112" },
  { when: "Last Wed · 2:08p", text: "Verbal exchange — peripheral on incident #491.", case: undefined },
  { when: "May 1 · 8:14a", text: "Bus 14 tension — present, not named.", case: "#108" },
];

export function Network() {
  return (
    <div className="min-h-screen" style={{ background: COLORS.bg, color: COLORS.ink }}>
      <div className="mx-auto max-w-[1320px] px-8 py-8">
        {/* Header */}
        <div className="flex flex-wrap items-end justify-between gap-4 pb-6">
          <div>
            <a
              className="inline-flex items-center gap-1 text-[11px] font-semibold"
              style={{ color: COLORS.brand }}
            >
              <ArrowLeft className="h-3 w-3" /> Back to Watchlist Hub
            </a>
            <div className="mt-2 flex items-center gap-2">
              <div
                className="inline-flex items-center gap-2 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider"
                style={{ borderColor: COLORS.line, background: COLORS.panel, color: COLORS.brand }}
              >
                <Shield className="h-3.5 w-3.5" /> Core Team Only
              </div>
              <div
                className="inline-flex items-center gap-2 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold"
                style={{ borderColor: COLORS.line, background: COLORS.panel, color: COLORS.inkSoft }}
              >
                <Calendar className="h-3.5 w-3.5" /> Last 30 days · Lincoln Middle
              </div>
            </div>
            <h1 className="mt-2 text-3xl font-bold tracking-tight" style={{ fontFamily: "'Playfair Display', serif" }}>
              Interaction network
            </h1>
            <p className="mt-1 max-w-2xl text-sm" style={{ color: COLORS.inkSoft }}>
              School-wide map of who keeps showing up together. Each circle is a student; lines show shared incidents,
              rumors, or co-presence. Halos call out the alert flags from the hub.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="inline-flex overflow-hidden rounded-md border" style={{ borderColor: COLORS.line }}>
              <button
                className="px-3 py-1.5 text-xs font-semibold"
                style={{ background: COLORS.panel, color: COLORS.inkSoft }}
              >
                List
              </button>
              <button
                className="px-3 py-1.5 text-xs font-semibold"
                style={{ background: COLORS.ink, color: "#fff" }}
              >
                Network
              </button>
            </div>
            <button
              className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-semibold text-white shadow-sm"
              style={{ background: COLORS.brand }}
            >
              <Plus className="h-4 w-4" /> Log interaction
            </button>
          </div>
        </div>

        {/* Filter rail */}
        <div
          className="flex flex-wrap items-center gap-2 rounded-xl border p-3"
          style={{ borderColor: COLORS.line, background: COLORS.panel }}
        >
          <Filter className="h-4 w-4" style={{ color: COLORS.inkSoft }} />
          <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: COLORS.inkSoft }}>
            Window
          </span>
          <FilterPill label="7d" />
          <FilterPill label="14d" />
          <FilterPill label="30d" active />
          <FilterPill label="Term" />

          <span className="ml-3 text-[11px] font-semibold uppercase tracking-wider" style={{ color: COLORS.inkSoft }}>
            Roles shown
          </span>
          <FilterPill label="All" active />
          <FilterPill label="Direct + target" />
          <FilterPill label="Peripheral only" />
          <FilterPill label="Rumor only" />

          <span className="ml-3 text-[11px] font-semibold uppercase tracking-wider" style={{ color: COLORS.inkSoft }}>
            Edges
          </span>
          <FilterPill label="Incident" />
          <FilterPill label="Rumor" />
          <FilterPill label="Peripheral" active />

          <div className="ml-auto flex items-center gap-2">
            <div
              className="flex items-center gap-2 rounded-md border px-2.5 py-1.5"
              style={{ borderColor: COLORS.line, background: COLORS.bg }}
            >
              <Search className="h-4 w-4" style={{ color: COLORS.inkSoft }} />
              <input
                placeholder="Find student in graph"
                className="w-44 bg-transparent text-sm outline-none placeholder:text-[--ph]"
                style={{ ["--ph" as never]: COLORS.inkSoft } as React.CSSProperties}
              />
            </div>
            <div className="inline-flex items-center gap-1 rounded-md border" style={{ borderColor: COLORS.line }}>
              <button className="px-2 py-1.5" style={{ color: COLORS.inkSoft }}>
                <Minus className="h-3.5 w-3.5" />
              </button>
              <span className="px-1 text-[11px] font-semibold" style={{ color: COLORS.inkSoft }}>
                100%
              </span>
              <button className="px-2 py-1.5" style={{ color: COLORS.inkSoft }}>
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>

        {/* Stat strip */}
        <div className="mt-4 grid grid-cols-4 gap-4">
          {[
            { label: "Students in network", value: "19", sub: "across 4 active clusters", icon: Users, tone: COLORS.ink },
            { label: "Connections", value: "27", sub: "8 cross-cluster bridges", icon: GitBranch, tone: COLORS.brand },
            { label: "Active flags", value: "5", sub: "halos visible on graph", icon: Sparkles, tone: COLORS.alert },
            { label: "Loose incidents", value: "6", sub: "not linked to a case yet", icon: Layers, tone: COLORS.warn },
          ].map((t) => {
            const Icon = t.icon;
            return (
              <div
                key={t.label}
                className="flex flex-col gap-1.5 rounded-xl border p-4"
                style={{ borderColor: COLORS.line, background: COLORS.panel }}
              >
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: COLORS.inkSoft }}>
                    {t.label}
                  </span>
                  <Icon className="h-4 w-4" style={{ color: t.tone }} />
                </div>
                <div className="text-3xl font-bold tabular-nums" style={{ color: COLORS.ink }}>
                  {t.value}
                </div>
                <div className="text-[11px]" style={{ color: COLORS.inkSoft }}>
                  {t.sub}
                </div>
              </div>
            );
          })}
        </div>

        {/* Main graph + side rail */}
        <div className="mt-6 grid grid-cols-[1fr_360px] gap-4">
          <div
            className="overflow-hidden rounded-xl border"
            style={{ borderColor: COLORS.line, background: COLORS.panel }}
          >
            <div
              className="flex items-center justify-between border-b px-4 py-3"
              style={{ borderColor: COLORS.line }}
            >
              <div className="flex items-center gap-2">
                <Zap className="h-4 w-4" style={{ color: COLORS.brand }} />
                <span className="text-sm font-semibold">School-wide interaction graph</span>
                <span className="text-[11px]" style={{ color: COLORS.inkSoft }}>
                  · halos = active alerts · ring color = flag type
                </span>
              </div>
              <div className="flex items-center gap-3">
                <RoleSwatch role="direct" />
                <RoleSwatch role="target" />
                <RoleSwatch role="instigator" />
                <RoleSwatch role="rumor" />
                <RoleSwatch role="witness" />
                <RoleSwatch role="peripheral" />
                <RoleSwatch role="deescalator" />
              </div>
            </div>
            <NetworkSVG />
            <div
              className="flex items-center justify-between border-t px-4 py-2.5 text-[11px]"
              style={{ borderColor: COLORS.line, background: COLORS.bg, color: COLORS.inkSoft }}
            >
              <div className="flex items-center gap-4">
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className="inline-block h-0.5 w-6"
                    style={{ background: COLORS.alert }}
                  />
                  Incident
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className="inline-block h-0.5 w-6"
                    style={{ background: COLORS.warn }}
                  />
                  Rumor
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className="inline-block h-0.5 w-6"
                    style={{
                      background:
                        "repeating-linear-gradient(90deg, #A89A85 0 4px, transparent 4px 8px)",
                    }}
                  />
                  Peripheral / co-presence
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <CircleDot className="h-3 w-3" style={{ color: COLORS.alert }} /> Always peripheral
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <CircleDot className="h-3 w-3" style={{ color: COLORS.warn }} /> Rising
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <CircleDot className="h-3 w-3" style={{ color: COLORS.brand }} /> Co-occurring
                </span>
              </div>
              <span>Click a student to focus their connections</span>
            </div>
          </div>

          {/* Side rail: selected student detail */}
          <div className="flex flex-col gap-4">
            <div
              className="rounded-xl border p-5"
              style={{ borderColor: COLORS.line, background: COLORS.panel }}
            >
              <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: COLORS.inkSoft }}>
                Selected
              </div>
              <div className="mt-2 flex items-center gap-3">
                <div
                  className="flex h-12 w-12 items-center justify-center rounded-full text-lg font-bold text-white"
                  style={{ background: COLORS.alert }}
                >
                  {SELECTED.initials}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-base font-bold">{SELECTED.name}</div>
                  <div className="text-[11px]" style={{ color: COLORS.inkSoft }}>
                    Grade {SELECTED.grade} · 7 involvements (30d)
                  </div>
                </div>
              </div>
              <div
                className="mt-3 flex items-center gap-1.5 rounded-md px-2.5 py-2 text-[12px] font-semibold"
                style={{ background: COLORS.alertSoft, color: COLORS.alert }}
              >
                <CircleDot className="h-3 w-3" /> Always peripheral · 100% non-direct in window
              </div>

              <div className="mt-4">
                <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: COLORS.inkSoft }}>
                  Role breakdown (30d)
                </div>
                <div className="mt-2 flex flex-col gap-1.5">
                  {ROLE_BREAKDOWN.map((r) => {
                    const m = ROLE_META[r.role];
                    const max = Math.max(...ROLE_BREAKDOWN.map((x) => x.count), 1);
                    const pct = (r.count / max) * 100;
                    return (
                      <div key={r.role} className="flex items-center gap-2 text-[12px]">
                        <span className="w-24 shrink-0" style={{ color: COLORS.ink }}>
                          {m.label}
                        </span>
                        <div className="h-2.5 flex-1 overflow-hidden rounded-full" style={{ background: COLORS.bg }}>
                          <div
                            className="h-full rounded-full"
                            style={{ width: `${pct}%`, background: m.color, opacity: r.count === 0 ? 0.15 : 1 }}
                          />
                        </div>
                        <span className="w-6 text-right tabular-nums" style={{ color: COLORS.inkSoft }}>
                          {r.count}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="mt-4 flex flex-wrap gap-1.5">
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
                  Add to case
                </button>
                <button
                  className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11px] font-semibold"
                  style={{ borderColor: COLORS.line, color: COLORS.ink }}
                >
                  Request statement
                </button>
              </div>
            </div>

            {/* Top connections */}
            <div
              className="rounded-xl border p-5"
              style={{ borderColor: COLORS.line, background: COLORS.panel }}
            >
              <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: COLORS.inkSoft }}>
                Top connections
              </div>
              <div className="mt-2 flex flex-col">
                {SELECTED_CONNECTIONS.sort((a, b) => b.weight - a.weight)
                  .slice(0, 6)
                  .map((c) => {
                    const n = NODE_BY_ID[c.id];
                    if (!n) return null;
                    const meta = ROLE_META[n.primaryRole];
                    return (
                      <div
                        key={c.id}
                        className="flex items-center gap-3 border-b py-2 last:border-b-0"
                        style={{ borderColor: COLORS.line }}
                      >
                        <div
                          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold"
                          style={{ background: meta.soft, color: meta.color, border: `1.5px solid ${meta.color}` }}
                        >
                          {n.initials}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-semibold">{n.name}</div>
                          <div className="text-[11px]" style={{ color: COLORS.inkSoft }}>
                            {c.weight}× shared {c.kind === "peripheral" ? "co-presence" : c.kind}
                            {c.caseId ? ` · Case #${c.caseId}` : ""}
                          </div>
                        </div>
                        <span
                          className="rounded-full px-2 py-0.5 text-[10px] font-bold"
                          style={{ background: meta.soft, color: meta.color }}
                        >
                          {meta.label}
                        </span>
                      </div>
                    );
                  })}
              </div>
            </div>

            {/* Pattern callout */}
            <div
              className="rounded-xl border p-5"
              style={{ borderColor: COLORS.line, background: COLORS.alertSoft }}
            >
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4" style={{ color: COLORS.alert }} />
                <span className="text-sm font-bold" style={{ color: COLORS.alert }}>
                  Pattern detected
                </span>
              </div>
              <p className="mt-1 text-[12px] leading-snug" style={{ color: COLORS.alert }}>
                Marcus appears in <strong>3 of 4</strong> active clusters this month — always as peripheral or witness,
                never named direct. Consider a quiet check-in before the next incident pulls him in further.
              </p>
              <div className="mt-2 flex gap-1.5">
                <button
                  className="rounded-md px-2.5 py-1 text-[11px] font-semibold text-white"
                  style={{ background: COLORS.alert }}
                >
                  Schedule check-in
                </button>
                <button
                  className="rounded-md border px-2.5 py-1 text-[11px] font-semibold"
                  style={{ borderColor: COLORS.alert, color: COLORS.alert }}
                >
                  Snooze 7d
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Recent involvements for selected */}
        <div
          className="mt-4 rounded-xl border p-5"
          style={{ borderColor: COLORS.line, background: COLORS.panel }}
        >
          <div className="flex items-baseline justify-between">
            <h2 className="text-lg font-bold tracking-tight">Recent involvements · {SELECTED.name}</h2>
            <a className="text-xs font-semibold" style={{ color: COLORS.brand }}>
              See full timeline →
            </a>
          </div>
          <div className="mt-3 divide-y" style={{ borderColor: COLORS.line }}>
            {RECENT_FOR_SELECTED.map((r, i) => (
              <div key={i} className="flex items-start gap-3 py-3">
                <div
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md"
                  style={{ background: COLORS.bg, color: COLORS.brand }}
                >
                  {i % 3 === 0 ? (
                    <Eye className="h-4 w-4" />
                  ) : i % 3 === 1 ? (
                    <Megaphone className="h-4 w-4" />
                  ) : (
                    <MessageSquareWarning className="h-4 w-4" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className="text-[11px] font-semibold uppercase tracking-wider"
                      style={{ color: COLORS.inkSoft }}
                    >
                      {r.when}
                    </span>
                    {r.case ? (
                      <span
                        className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold"
                        style={{ background: COLORS.brandSoft, color: COLORS.brand }}
                      >
                        Case {r.case}
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
                  <div className="mt-0.5 text-sm" style={{ color: COLORS.ink }}>
                    {r.text}
                  </div>
                </div>
                <ChevronRight className="mt-2 h-4 w-4" style={{ color: COLORS.inkSoft }} />
              </div>
            ))}
          </div>
        </div>

        <div className="mt-6 text-center text-[11px]" style={{ color: COLORS.inkSoft }}>
          Mockup · Network view · PulseEDU Admin
        </div>
      </div>
    </div>
  );
}
