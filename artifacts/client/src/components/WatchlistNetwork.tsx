import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Calendar,
  ChevronRight,
  CircleDot,
  Filter,
  GitBranch,
  Layers,
  Plus,
  Sparkles,
  Users,
  Zap,
} from "lucide-react";
import { authFetch } from "../lib/authToken";
import LogInteractionModal from "./watchlist/LogInteractionModal";
import { ROLE_META, WL_COLORS as C, statusPillStyle, type Role } from "./watchlist/colors";

interface NetNode {
  studentId: string;
  firstName: string;
  lastName: string;
  grade: string | null;
  total: number;
  primaryRole: string;
  counts: Record<string, number>;
  caseIds: number[];
  nonDirectPct: number;
  flag: "always-peripheral" | "frequency" | null;
}

interface NetEdge {
  a: string;
  b: string;
  weight: number;
  caseIds: number[];
  kinds: string[];
}

interface NetCase {
  id: number;
  caseNumber: number;
  title: string;
  status: string;
  leadStaffName: string | null;
}

interface Resp {
  nodes: NetNode[];
  edges: NetEdge[];
  cases: NetCase[];
  windowDays: number;
}

interface Props {
  onBack?: () => void;
  onOpenCase?: (caseId: number) => void;
}

interface Positioned extends NetNode {
  x: number;
  y: number;
  cluster: number; // case id or -1 for loose
}

// Overview layout: grid of clusters. For real cases (cid >= 0) the
// anchor (highest total involvements) sits in the middle and the rest
// ring around it — same focal-point pattern as the zoomed view, just
// at smaller scale. The "loose / no case" cluster (cid === -1) keeps
// its original ring-of-many layout because there is no meaningful
// anchor in a roll-up of unrelated students.
function layout(nodes: NetNode[]): {
  positioned: Positioned[];
  clusters: Map<number, { cx: number; cy: number; r: number; size: number }>;
  anchorIds: Set<string>;
} {
  const W = 1180;
  const H = 820;
  const buckets = new Map<number, NetNode[]>();
  for (const n of nodes) {
    const cid = n.caseIds[0] ?? -1;
    let arr = buckets.get(cid);
    if (!arr) {
      arr = [];
      buckets.set(cid, arr);
    }
    arr.push(n);
  }
  const ids = [...buckets.keys()];
  const cols = Math.max(1, Math.ceil(Math.sqrt(ids.length || 1)));
  const rows = Math.max(1, Math.ceil(ids.length / cols));
  const cellW = W / cols;
  const cellH = H / rows;
  const positioned: Positioned[] = [];
  const clusters = new Map<number, { cx: number; cy: number; r: number; size: number }>();
  const anchorIds = new Set<string>();
  ids.forEach((cid, idx) => {
    const c = idx % cols;
    const r = Math.floor(idx / cols);
    const cx = cellW * c + cellW / 2;
    const cy = cellH * r + cellH / 2;
    const arr = buckets.get(cid)!;
    const n = arr.length;
    // Wider ring (was 0.32) so the bigger case spheres still have
    // breathing room and the cell looks fuller.
    const radius = Math.min(cellW, cellH) * 0.40;
    if (n === 0) {
      clusters.set(cid, { cx, cy, r: radius + 30, size: 0 });
      return;
    }
    if (cid < 0) {
      // Loose / no case — keep original ring layout.
      arr.forEach((node, i) => {
        const angle = (i / Math.max(1, n)) * Math.PI * 2 - Math.PI / 2;
        positioned.push({
          ...node,
          cluster: cid,
          x: cx + Math.cos(angle) * radius * (n === 1 ? 0 : 1),
          y: cy + Math.sin(angle) * radius * (n === 1 ? 0 : 1),
        });
      });
      clusters.set(cid, { cx, cy, r: radius + 50, size: n });
      return;
    }
    const sorted = [...arr].sort(
      (a, b) => b.total - a.total || a.lastName.localeCompare(b.lastName),
    );
    const anchor = sorted[0]!;
    const others = sorted.slice(1);
    anchorIds.add(anchor.studentId);
    positioned.push({ ...anchor, cluster: cid, x: cx, y: cy });
    others.forEach((node, i) => {
      const angle = (i / Math.max(1, others.length)) * Math.PI * 2 - Math.PI / 2;
      positioned.push({
        ...node,
        cluster: cid,
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius,
      });
    });
    clusters.set(cid, { cx, cy, r: radius + 50, size: n });
  });
  return { positioned, clusters, anchorIds };
}

// Single-cluster layout: the "primary" student (highest total
// involvements — i.e. the anchor of the case) sits at the center and
// the rest ring around it filling most of the viewport. Anchor in the
// middle reads as the focal point; the surrounding ring is wide enough
// for the spheres to dominate the canvas instead of floating in a
// half-empty disc.
function layoutZoomed(
  nodes: NetNode[],
  clusterId: number,
): {
  positioned: Positioned[];
  clusters: Map<number, { cx: number; cy: number; r: number; size: number }>;
  anchorId: string | null;
} {
  const W = 1180;
  const H = 820;
  const cx = W / 2;
  const cy = H / 2 + 10;
  const positioned: Positioned[] = [];
  const clusters = new Map<number, { cx: number; cy: number; r: number; size: number }>();
  if (nodes.length === 0) {
    clusters.set(clusterId, { cx, cy, r: 50, size: 0 });
    return { positioned, clusters, anchorId: null };
  }
  // Stable anchor pick: highest involvements, tiebreak alphabetical.
  const sorted = [...nodes].sort(
    (a, b) => b.total - a.total || a.lastName.localeCompare(b.lastName),
  );
  const anchor = sorted[0]!;
  const others = sorted.slice(1);
  // Ring radius is sized so big spheres (~r=50) clear the halo edge
  // and the anchor (~r=60 in the middle). 0.40 of the short edge fills
  // most of the canvas without crowding the labels.
  const ringRadius = Math.min(W, H) * 0.40;
  positioned.push({ ...anchor, cluster: clusterId, x: cx, y: cy });
  others.forEach((node, i) => {
    const angle = (i / Math.max(1, others.length)) * Math.PI * 2 - Math.PI / 2;
    positioned.push({
      ...node,
      cluster: clusterId,
      x: cx + Math.cos(angle) * ringRadius,
      y: cy + Math.sin(angle) * ringRadius,
    });
  });
  clusters.set(clusterId, { cx, cy, r: ringRadius + 90, size: nodes.length });
  return { positioned, clusters, anchorId: anchor.studentId };
}

function clusterFill(idx: number): string {
  const tints = [
    "rgba(155, 28, 46, 0.07)",
    "rgba(45, 79, 107, 0.07)",
    "rgba(184, 83, 26, 0.07)",
    "rgba(122, 31, 43, 0.06)",
    "rgba(59, 107, 76, 0.07)",
    "rgba(122, 107, 90, 0.07)",
  ];
  return tints[idx % tints.length];
}

function edgeColor(kinds: string[]): string {
  if (kinds.includes("rumor")) return C.warn;
  if (kinds.some((k) => ["fight", "verbal", "bullying"].includes(k))) return C.alert;
  return "#A89A85";
}

function edgeDashed(kinds: string[]): boolean {
  return kinds.every((k) => k === "peripheral_note");
}

export default function WatchlistNetwork({ onBack, onOpenCase }: Props) {
  const [data, setData] = useState<Resp | null>(null);
  const [windowDays, setWindowDays] = useState(30);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  // null = overview (all clusters); a number = zoom into one cluster
  // (case id, or -1 for the loose / no-case ring).
  const [zoomedClusterId, setZoomedClusterId] = useState<number | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    const r = await authFetch(`/api/watchlist/network?windowDays=${windowDays}`);
    if (!r.ok) {
      setError("Failed to load network");
      return;
    }
    const d = (await r.json()) as Resp;
    setData(d);
  }, [windowDays]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // When zoomed, restrict to nodes that belong to that cluster and run a
  // single-cluster layout so the bubbles fill the viewport. Edges are
  // filtered to those whose endpoints are both in the zoomed cluster so
  // we don't render dangling lines off-canvas.
  const zoomedData = useMemo(() => {
    if (!data || zoomedClusterId === null) return null;
    const inCluster = data.nodes.filter(
      (n) => (n.caseIds[0] ?? -1) === zoomedClusterId,
    );
    const ids = new Set(inCluster.map((n) => n.studentId));
    const edges = data.edges.filter((e) => ids.has(e.a) && ids.has(e.b));
    const cases = data.cases.filter((c) => c.id === zoomedClusterId);
    return { nodes: inCluster, edges, cases, windowDays: data.windowDays } as Resp;
  }, [data, zoomedClusterId]);

  const layoutResult = useMemo(() => {
    if (!data) return null;
    if (zoomedClusterId !== null && zoomedData) {
      const z = layoutZoomed(zoomedData.nodes, zoomedClusterId);
      return {
        positioned: z.positioned,
        clusters: z.clusters,
        anchorIds: z.anchorId ? new Set([z.anchorId]) : new Set<string>(),
      };
    }
    const o = layout(data.nodes);
    return { positioned: o.positioned, clusters: o.clusters, anchorIds: o.anchorIds };
  }, [data, zoomedClusterId, zoomedData]);

  const activeData: Resp | null = zoomedData ?? data;

  const zoomedCase = useMemo(() => {
    if (zoomedClusterId === null || !data) return null;
    if (zoomedClusterId < 0) return null;
    return data.cases.find((c) => c.id === zoomedClusterId) ?? null;
  }, [zoomedClusterId, data]);

  const nodeById = useMemo(() => {
    if (!layoutResult) return new Map<string, Positioned>();
    return new Map(layoutResult.positioned.map((n) => [n.studentId, n] as const));
  }, [layoutResult]);

  // Reload clears zoom + selection so we don't show stale focus state
  // pointing at nodes that no longer exist after a window change.
  useEffect(() => {
    setZoomedClusterId(null);
    setSelectedId(null);
  }, [windowDays]);

  const selected = selectedId ? nodeById.get(selectedId) ?? null : null;

  const selectedConnections = useMemo(() => {
    if (!data || !selectedId) return [];
    return data.edges
      .filter((e) => e.a === selectedId || e.b === selectedId)
      .map((e) => ({
        otherId: e.a === selectedId ? e.b : e.a,
        weight: e.weight,
        caseIds: e.caseIds,
        kinds: e.kinds,
      }))
      .sort((x, y) => y.weight - x.weight);
  }, [data, selectedId]);

  const stats = useMemo(() => {
    if (!data) return null;
    const flagged = data.nodes.filter((n) => n.flag !== null).length;
    const crossCluster = data.edges.filter((e) => {
      const a = data.nodes.find((n) => n.studentId === e.a);
      const b = data.nodes.find((n) => n.studentId === e.b);
      if (!a || !b) return false;
      const ac = a.caseIds[0] ?? -1;
      const bc = b.caseIds[0] ?? -1;
      return ac !== bc;
    }).length;
    return {
      students: data.nodes.length,
      edges: data.edges.length,
      flagged,
      crossCluster,
    };
  }, [data]);

  const checkInSelected = async () => {
    if (!selected) return;
    try {
      const r = await authFetch("/api/watchlist/alerts/check-in", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId: selected.studentId,
          ruleKind: "manual",
          ruleSummary: `Manual check-in from network view (${selected.total} involvements / ${selected.nonDirectPct}% non-direct)`,
        }),
      });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(t || `Failed (${r.status})`);
      }
      const d = (await r.json()) as { assignedTo?: { name: string }; createdPlan?: boolean };
      const who = d.assignedTo?.name || "Behavior Specialist";
      const planNote = d.createdPlan ? " (new MTSS plan opened)" : "";
      window.alert(`Check-in scheduled with ${who}${planNote}.`);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Failed to schedule check-in");
    }
  };

  return (
    <div className="min-h-screen" style={{ background: C.bg, color: C.ink }}>
      <div className="mx-auto max-w-[1320px] px-8 py-8">
        {/* Header */}
        <div className="flex flex-wrap items-end justify-between gap-4 pb-6">
          <div>
            <button
              type="button"
              onClick={() => onBack?.()}
              className="inline-flex items-center gap-1 text-[11px] font-semibold"
              style={{ color: C.brand }}
            >
              <ArrowLeft className="h-3 w-3" /> Back to Investigations
            </button>
            <div className="mt-2 flex items-center gap-2">
              <div
                className="inline-flex items-center gap-2 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold"
                style={{ borderColor: C.line, background: C.panel, color: C.inkSoft }}
              >
                <Calendar className="h-3.5 w-3.5" /> Last {windowDays} days
              </div>
            </div>
            <h1
              className="mt-2 text-3xl font-bold tracking-tight"
            >
              Interaction network
            </h1>
            <p className="mt-1 max-w-2xl text-sm" style={{ color: C.inkSoft }}>
              School-wide map of who keeps showing up together. Click a student to focus their
              connections. Click a case label to open the case file.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowLog(true)}
              className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-bold shadow-sm"
              style={{ background: C.brand, color: "#FFFFFF" }}
            >
              <Plus className="h-4 w-4" /> Log new statement
            </button>
          </div>
        </div>

        {/* Filter rail */}
        <div
          className="flex flex-wrap items-center gap-2 rounded-xl border p-3"
          style={{ borderColor: C.line, background: C.panel }}
        >
          <Filter className="h-4 w-4" style={{ color: C.inkSoft }} />
          <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: C.inkSoft }}>
            Window
          </span>
          {[7, 14, 30, 90].map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => setWindowDays(w)}
              className="rounded-md px-2.5 py-1 text-xs font-semibold"
              style={{
                background: w === windowDays ? C.ink : "transparent",
                color: w === windowDays ? "#fff" : C.ink,
                border: `1px solid ${w === windowDays ? C.ink : C.line}`,
              }}
            >
              {w === 90 ? "Term" : `${w}d`}
            </button>
          ))}
        </div>

        {error && (
          <div
            className="mt-4 rounded-md px-3 py-2 text-sm font-semibold"
            style={{ background: C.alert, color: "#FFFFFF" }}
          >
            {error}
          </div>
        )}

        {/* Stat strip */}
        {stats && (
          <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
            {[
              { label: "Students in network", value: stats.students, sub: `across ${data?.cases.length ?? 0} cases`, icon: Users, tone: C.ink },
              { label: "Connections", value: stats.edges, sub: `${stats.crossCluster} cross-case`, icon: GitBranch, tone: C.brand },
              { label: "Active flags", value: stats.flagged, sub: "halos visible on graph", icon: Sparkles, tone: C.alert },
              { label: "Loose participants", value: data?.nodes.filter((n) => n.caseIds.length === 0).length ?? 0, sub: "not linked to a case", icon: Layers, tone: C.warn },
            ].map((t) => {
              const Icon = t.icon;
              return (
                <div
                  key={t.label}
                  className="flex flex-col gap-1.5 rounded-xl border p-4"
                  style={{ borderColor: C.line, background: C.panel }}
                >
                  <div className="flex items-center justify-between">
                    <span
                      className="text-[11px] font-semibold uppercase tracking-wider"
                      style={{ color: C.inkSoft }}
                    >
                      {t.label}
                    </span>
                    <Icon className="h-4 w-4" style={{ color: t.tone }} />
                  </div>
                  <div className="text-3xl font-bold tabular-nums" style={{ color: C.ink }}>
                    {t.value}
                  </div>
                  <div className="text-[11px]" style={{ color: C.inkSoft }}>
                    {t.sub}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Main graph + side rail */}
        <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
          <div
            className="overflow-hidden rounded-xl border"
            style={{ borderColor: C.line, background: C.panel }}
          >
            <div
              className="flex items-center justify-between border-b px-4 py-3"
              style={{ borderColor: C.line }}
            >
              {zoomedClusterId !== null ? (
                <>
                  <div className="flex min-w-0 items-center gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        setZoomedClusterId(null);
                        setSelectedId(null);
                      }}
                      className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11px] font-semibold"
                      style={{ borderColor: C.line, color: C.brand, background: C.panel }}
                    >
                      <ArrowLeft className="h-3 w-3" /> Back to all cases
                    </button>
                    <div className="min-w-0">
                      <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: C.inkSoft }}>
                        {zoomedCase ? `Case #${zoomedCase.caseNumber}` : "Loose / no case"}
                      </div>
                      <div className="truncate text-sm font-bold" style={{ color: C.ink }}>
                        {zoomedCase ? zoomedCase.title : "Students not yet linked to a case"}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {zoomedCase && (
                      <>
                        <span
                          className="rounded-full px-2 py-0.5 text-[10px] font-bold"
                          style={{
                            background: statusPillStyle(zoomedCase.status).bg,
                            color: statusPillStyle(zoomedCase.status).fg,
                          }}
                        >
                          {statusPillStyle(zoomedCase.status).label}
                        </span>
                        <button
                          type="button"
                          onClick={() => onOpenCase?.(zoomedCase.id)}
                          className="rounded-md px-2.5 py-1 text-[11px] font-bold"
                          style={{ background: C.brand, color: "#FFFFFF" }}
                        >
                          Open case file
                        </button>
                      </>
                    )}
                  </div>
                </>
              ) : (
                <div className="flex items-center gap-2">
                  <Zap className="h-4 w-4" style={{ color: C.brand }} />
                  <span className="text-sm font-semibold">School-wide interaction graph</span>
                  <span className="text-[11px]" style={{ color: C.inkSoft }}>
                    · click any case ring to zoom in · click a node to focus
                  </span>
                </div>
              )}
            </div>

            {!activeData || activeData.nodes.length === 0 ? (
              <div className="p-12 text-center text-sm" style={{ color: C.inkSoft }}>
                No interactions in this window yet. Log one to start building the network.
              </div>
            ) : (
              <NetworkSVG
                data={activeData}
                positioned={layoutResult!.positioned}
                clusters={layoutResult!.clusters}
                selectedId={selectedId}
                zoomed={zoomedClusterId !== null}
                anchorIds={layoutResult!.anchorIds}
                onSelectNode={(id) => setSelectedId(id)}
                onOpenCase={(id) => onOpenCase?.(id)}
                onZoomCluster={(id) => {
                  setSelectedId(null);
                  setZoomedClusterId(id);
                }}
              />
            )}

            <div
              className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-2.5 text-[11px]"
              style={{ borderColor: C.line, background: C.bg, color: C.inkSoft }}
            >
              <div className="flex flex-wrap items-center gap-4">
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-block h-0.5 w-6" style={{ background: C.alert }} /> Incident
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-block h-0.5 w-6" style={{ background: C.warn }} /> Rumor
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className="inline-block h-0.5 w-6"
                    style={{
                      background:
                        "repeating-linear-gradient(90deg, #A89A85 0 4px, transparent 4px 8px)",
                    }}
                  />
                  Peripheral
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <CircleDot className="h-3 w-3" style={{ color: C.alert }} /> Always peripheral
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <CircleDot className="h-3 w-3" style={{ color: C.warn }} /> High frequency
                </span>
              </div>
              <span>Click a node to focus</span>
            </div>
          </div>

          {/* Side rail */}
          <div className="flex flex-col gap-4">
            {selected ? (
              <div className="rounded-xl border p-5" style={{ borderColor: C.line, background: C.panel }}>
                <div
                  className="text-[11px] font-semibold uppercase tracking-wider"
                  style={{ color: C.inkSoft }}
                >
                  Selected
                </div>
                <div className="mt-2 flex items-center gap-3">
                  <div
                    className="flex h-12 w-12 items-center justify-center rounded-full text-lg font-bold text-white"
                    style={{ background: ROLE_META[(selected.primaryRole as Role) ?? "peripheral"]?.color ?? C.cool }}
                  >
                    {selected.firstName.charAt(0)}
                    {selected.lastName.charAt(0)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-base font-bold">
                      {selected.firstName} {selected.lastName}
                    </div>
                    <div className="text-[11px]" style={{ color: C.inkSoft }}>
                      Grade {selected.grade ?? "?"} · {selected.total} involvements ({windowDays}d)
                    </div>
                  </div>
                </div>
                {selected.flag && (
                  <div
                    className="mt-3 flex items-center gap-1.5 rounded-md px-2.5 py-2 text-[12px] font-semibold"
                    style={{
                      background: selected.flag === "always-peripheral" ? C.alertSoft : C.warnSoft,
                      color: selected.flag === "always-peripheral" ? C.alert : C.warn,
                    }}
                  >
                    <CircleDot className="h-3 w-3" />{" "}
                    {selected.flag === "always-peripheral"
                      ? "Always peripheral · 100% non-direct"
                      : `High frequency · ${selected.nonDirectPct}% non-direct`}
                  </div>
                )}

                <div className="mt-4">
                  <div
                    className="text-[11px] font-semibold uppercase tracking-wider"
                    style={{ color: C.inkSoft }}
                  >
                    Role breakdown
                  </div>
                  <div className="mt-2 flex flex-col gap-1.5">
                    {(Object.keys(ROLE_META) as Role[]).map((r) => {
                      const count = selected.counts[r] ?? 0;
                      const max = Math.max(1, ...Object.values(selected.counts));
                      const pct = (count / max) * 100;
                      const m = ROLE_META[r];
                      return (
                        <div key={r} className="flex items-center gap-2 text-[12px]">
                          <span className="w-24 shrink-0">{m.label}</span>
                          <div
                            className="h-2.5 flex-1 overflow-hidden rounded-full"
                            style={{ background: C.bg }}
                          >
                            <div
                              className="h-full rounded-full"
                              style={{
                                width: `${pct}%`,
                                background: m.color,
                                opacity: count === 0 ? 0.15 : 1,
                              }}
                            />
                          </div>
                          <span
                            className="w-6 text-right tabular-nums"
                            style={{ color: C.inkSoft }}
                          >
                            {count}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={checkInSelected}
                    className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-bold"
                    style={{ background: C.brand, color: "#FFFFFF" }}
                    title="Routes to Behavior Specialist + opens an MTSS Tier 2 plan"
                  >
                    Schedule check-in <ChevronRight className="h-3 w-3" />
                  </button>
                  {selected.caseIds[0] != null && (
                    <button
                      type="button"
                      onClick={() => onOpenCase?.(selected.caseIds[0]!)}
                      className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11px] font-semibold"
                      style={{ borderColor: C.line, color: C.ink }}
                    >
                      Open case
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div
                className="rounded-xl border p-5 text-sm"
                style={{ borderColor: C.line, background: C.panel, color: C.inkSoft }}
              >
                Click a student node to see their role breakdown and top connections.
              </div>
            )}

            {/* Top connections */}
            {selected && selectedConnections.length > 0 && (
              <div
                className="rounded-xl border p-5"
                style={{ borderColor: C.line, background: C.panel }}
              >
                <div
                  className="text-[11px] font-semibold uppercase tracking-wider"
                  style={{ color: C.inkSoft }}
                >
                  Top connections
                </div>
                <div className="mt-2 flex flex-col">
                  {selectedConnections.slice(0, 8).map((c) => {
                    const n = nodeById.get(c.otherId);
                    if (!n) return null;
                    const meta = ROLE_META[(n.primaryRole as Role) ?? "peripheral"] ?? ROLE_META.peripheral;
                    return (
                      <button
                        key={c.otherId}
                        type="button"
                        onClick={() => setSelectedId(c.otherId)}
                        className="flex items-center gap-3 border-b py-2 text-left last:border-b-0 hover:bg-[--hov]"
                        style={
                          {
                            borderColor: C.line,
                            ["--hov" as never]: C.bg,
                          } as React.CSSProperties
                        }
                      >
                        <div
                          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold"
                          style={{
                            background: meta.soft,
                            color: meta.color,
                            border: `1.5px solid ${meta.color}`,
                          }}
                        >
                          {n.firstName.charAt(0)}
                          {n.lastName.charAt(0)}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-semibold">
                            {n.firstName} {n.lastName}
                          </div>
                          <div className="text-[11px]" style={{ color: C.inkSoft }}>
                            {c.weight}× shared · {c.kinds.join(", ") || "—"}
                            {c.caseIds.length > 0 ? ` · Case #${c.caseIds[0]}` : ""}
                          </div>
                        </div>
                        <span
                          className="rounded-full px-2 py-0.5 text-[10px] font-bold"
                          style={{ background: meta.soft, color: meta.color }}
                        >
                          {meta.label}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Cases legend */}
            {data && data.cases.length > 0 && (
              <div
                className="rounded-xl border p-5"
                style={{ borderColor: C.line, background: C.panel }}
              >
                <div
                  className="text-[11px] font-semibold uppercase tracking-wider"
                  style={{ color: C.inkSoft }}
                >
                  Active cases
                </div>
                <div className="mt-2 flex flex-col gap-1.5">
                  {data.cases
                    .filter((c) => c.status !== "closed")
                    .map((c) => {
                      const sp = statusPillStyle(c.status);
                      return (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => onOpenCase?.(c.id)}
                          className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-left hover:bg-[--hov]"
                          style={
                            {
                              borderColor: C.line,
                              ["--hov" as never]: C.bg,
                            } as React.CSSProperties
                          }
                        >
                          <div className="min-w-0">
                            <div className="text-[11px]" style={{ color: C.inkSoft }}>
                              Case #{c.caseNumber}
                            </div>
                            <div className="truncate text-sm font-semibold">{c.title}</div>
                          </div>
                          <span
                            className="rounded-full px-2 py-0.5 text-[10px] font-bold"
                            style={{ background: sp.bg, color: sp.fg }}
                          >
                            {sp.label}
                          </span>
                        </button>
                      );
                    })}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {showLog && (
        <LogInteractionModal onClose={() => setShowLog(false)} onCreated={() => void reload()} />
      )}
    </div>
  );
}

function NetworkSVG({
  data,
  positioned,
  clusters,
  selectedId,
  zoomed,
  anchorIds,
  onSelectNode,
  onOpenCase,
  onZoomCluster,
}: {
  data: Resp;
  positioned: Positioned[];
  clusters: Map<number, { cx: number; cy: number; r: number; size: number }>;
  selectedId: string | null;
  zoomed: boolean;
  anchorIds: Set<string>;
  onSelectNode: (id: string) => void;
  onOpenCase: (id: number) => void;
  onZoomCluster: (id: number) => void;
}) {
  const W = 1180;
  const H = 820;
  const nodeMap = new Map(positioned.map((n) => [n.studentId, n] as const));
  const caseById = new Map(data.cases.map((c) => [c.id, c] as const));
  const isSelectedEdge = (e: NetEdge) => e.a === selectedId || e.b === selectedId;
  const clusterIdsSorted = [...clusters.keys()];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full">
      <defs>
        <pattern id="wl-grid" width="40" height="40" patternUnits="userSpaceOnUse">
          <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#EAE2D0" strokeWidth="0.5" />
        </pattern>
        <radialGradient id="wl-selGlow">
          <stop offset="0%" stopColor={C.alert} stopOpacity="0.35" />
          <stop offset="100%" stopColor={C.alert} stopOpacity="0" />
        </radialGradient>
        {/* Per-role 3D sphere gradients. The highlight is offset toward
            the upper-left (cx=35%, cy=30%) so every node reads as a lit
            sphere instead of a flat disc. White tip → role.soft midtone
            → role.color rim gives depth without losing role identity. */}
        {(Object.keys(ROLE_META) as Role[]).map((role) => {
          const m = ROLE_META[role];
          return (
            <radialGradient
              key={role}
              id={`wl-sphere-${role}`}
              cx="35%"
              cy="30%"
              r="75%"
              fx="30%"
              fy="25%"
            >
              <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.95" />
              <stop offset="35%" stopColor={m.soft} stopOpacity="1" />
              <stop offset="100%" stopColor={m.color} stopOpacity="0.85" />
            </radialGradient>
          );
        })}
        {/* Cluster halo gradients — same lighting direction, much
            subtler so they recede behind the nodes. */}
        {[0, 1, 2, 3, 4, 5].map((i) => {
          const tints = [
            ["rgba(255,255,255,0.55)", "rgba(155,28,46,0.10)", "rgba(155,28,46,0.18)"],
            ["rgba(255,255,255,0.55)", "rgba(45,79,107,0.10)", "rgba(45,79,107,0.18)"],
            ["rgba(255,255,255,0.55)", "rgba(184,83,26,0.10)", "rgba(184,83,26,0.18)"],
            ["rgba(255,255,255,0.55)", "rgba(122,31,43,0.09)", "rgba(122,31,43,0.16)"],
            ["rgba(255,255,255,0.55)", "rgba(59,107,76,0.10)", "rgba(59,107,76,0.18)"],
            ["rgba(255,255,255,0.55)", "rgba(122,107,90,0.10)", "rgba(122,107,90,0.18)"],
          ][i]!;
          return (
            <radialGradient
              key={i}
              id={`wl-cluster-${i}`}
              cx="35%"
              cy="30%"
              r="80%"
              fx="30%"
              fy="25%"
            >
              <stop offset="0%" stopColor={tints[0]} />
              <stop offset="55%" stopColor={tints[1]} />
              <stop offset="100%" stopColor={tints[2]} />
            </radialGradient>
          );
        })}
        {/* Soft drop-shadow used by both halos and nodes. Two stacked
            blurs (tight + soft) give the "floating" look without the
            flat hard edge of a single shadow. */}
        <filter id="wl-shadow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur in="SourceAlpha" stdDeviation="1.4" result="b1" />
          <feGaussianBlur in="SourceAlpha" stdDeviation="3.5" result="b2" />
          <feOffset in="b1" dx="0" dy="1.2" result="o1" />
          <feOffset in="b2" dx="0" dy="3" result="o2" />
          <feComponentTransfer in="o1" result="s1">
            <feFuncA type="linear" slope="0.45" />
          </feComponentTransfer>
          <feComponentTransfer in="o2" result="s2">
            <feFuncA type="linear" slope="0.22" />
          </feComponentTransfer>
          <feMerge>
            <feMergeNode in="s2" />
            <feMergeNode in="s1" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <filter id="wl-shadow-soft" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur in="SourceAlpha" stdDeviation="6" result="b" />
          <feOffset in="b" dx="0" dy="3" result="o" />
          <feComponentTransfer in="o" result="s">
            <feFuncA type="linear" slope="0.18" />
          </feComponentTransfer>
          <feMerge>
            <feMergeNode in="s" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <rect x={0} y={0} width={W} height={H} fill={C.graphBg} />
      <rect x={0} y={0} width={W} height={H} fill="url(#wl-grid)" />

      {/* Cluster halos. In overview mode, the halo body is clickable to
          zoom into a single case (the title pill still routes to the
          full case file). In zoomed mode, zoom is disabled (already
          zoomed) and the title pill is hidden — the surrounding card
          header carries the case info + Back action. */}
      {clusterIdsSorted.map((cid, idx) => {
        const cl = clusters.get(cid)!;
        const c = cid >= 0 ? caseById.get(cid) : null;
        const label = c ? `Case #${c.caseNumber} · ${c.title}` : "Loose / no case";
        return (
          <g key={cid}>
            <circle
              cx={cl.cx}
              cy={cl.cy}
              r={cl.r}
              fill={`url(#wl-cluster-${idx % 6})`}
              stroke="#D9CFB8"
              strokeDasharray="4 6"
              strokeWidth={1}
              filter="url(#wl-shadow-soft)"
              onClick={zoomed ? undefined : () => onZoomCluster(cid)}
              style={{ cursor: zoomed ? "default" : "zoom-in" }}
            >
              {!zoomed && <title>Click to zoom into {label}</title>}
            </circle>
            {!zoomed && c ? (
              <g
                onClick={() => onOpenCase(c.id)}
                style={{ cursor: "pointer" }}
              >
                <rect
                  x={cl.cx - 110}
                  y={cl.cy - cl.r - 18}
                  width={220}
                  height={20}
                  rx={10}
                  fill={C.panel}
                  stroke={C.brand}
                  strokeWidth={1}
                />
                <text
                  x={cl.cx}
                  y={cl.cy - cl.r - 5}
                  fontSize={11}
                  fontWeight={700}
                  fill={C.brand}
                  textAnchor="middle"
                  style={{ letterSpacing: 0.4 }}
                >
                  {label.length > 32 ? label.slice(0, 30) + "…" : label}
                </text>
              </g>
            ) : !zoomed ? (
              <text
                x={cl.cx}
                y={cl.cy - cl.r - 5}
                fontSize={11}
                fontWeight={700}
                fill={C.inkSoft}
                textAnchor="middle"
                style={{ letterSpacing: 0.6, textTransform: "uppercase" }}
              >
                {label}
              </text>
            ) : null}
          </g>
        );
      })}

      {/* Selected glow */}
      {selectedId && nodeMap.get(selectedId) && (
        <circle
          cx={nodeMap.get(selectedId)!.x}
          cy={nodeMap.get(selectedId)!.y}
          r={90}
          fill="url(#wl-selGlow)"
        />
      )}

      {/* Edges (non-selected first) */}
      {data.edges.filter((e) => !isSelectedEdge(e)).map((e, i) => {
        const A = nodeMap.get(e.a);
        const B = nodeMap.get(e.b);
        if (!A || !B) return null;
        return (
          <line
            key={`e${i}`}
            x1={A.x}
            y1={A.y}
            x2={B.x}
            y2={B.y}
            stroke={edgeColor(e.kinds)}
            strokeOpacity={0.3}
            strokeWidth={Math.max(1, e.weight * 0.9)}
            strokeDasharray={edgeDashed(e.kinds) ? "5 4" : undefined}
          />
        );
      })}
      {selectedId &&
        data.edges.filter(isSelectedEdge).map((e, i) => {
          const A = nodeMap.get(e.a);
          const B = nodeMap.get(e.b);
          if (!A || !B) return null;
          return (
            <g key={`se${i}`}>
              <line
                x1={A.x}
                y1={A.y}
                x2={B.x}
                y2={B.y}
                stroke={edgeColor(e.kinds)}
                strokeOpacity={0.95}
                strokeWidth={Math.max(2, e.weight * 1.4)}
                strokeDasharray={edgeDashed(e.kinds) ? "5 4" : undefined}
              />
              <text
                x={(A.x + B.x) / 2}
                y={(A.y + B.y) / 2 - 4}
                fontSize={9}
                fill={edgeColor(e.kinds)}
                fontWeight={700}
                textAnchor="middle"
                style={{ paintOrder: "stroke", stroke: C.graphBg, strokeWidth: 3 }}
              >
                {e.weight}× {e.kinds[0] ?? "interaction"}
                {e.caseIds[0] != null ? ` · #${e.caseIds[0]}` : ""}
              </text>
            </g>
          );
        })}

      {/* Nodes. Both modes get a base size bump so case spheres are
          legible. Anchors (center of each case ring) get an extra boost
          so they read as the focal point. Zoomed mode amplifies both.
          Overview ring spheres are sized to roughly match the previous
          anchor size, and the anchor itself is ~2× that. */}
      {positioned.map((n) => {
        const isAnchor = anchorIds.has(n.studentId);
        const baseR = 14 + Math.min(22, n.total * 2.2);
        const overviewScale = isAnchor ? 2.7 : 1.35;
        const zoomScale = isAnchor ? 2.6 : 1.7;
        const r = zoomed ? baseR * zoomScale : baseR * overviewScale;
        const meta = ROLE_META[(n.primaryRole as Role) ?? "peripheral"] ?? ROLE_META.peripheral;
        const ringColor =
          n.flag === "always-peripheral"
            ? C.alert
            : n.flag === "frequency"
              ? C.warn
              : "transparent";
        const isSelected = n.studentId === selectedId;
        return (
          <g
            key={n.studentId}
            onClick={() => onSelectNode(n.studentId)}
            style={{ cursor: "pointer" }}
          >
            {ringColor !== "transparent" && (
              <circle
                cx={n.x}
                cy={n.y}
                r={r + 5}
                fill="none"
                stroke={ringColor}
                strokeWidth={2.5}
              />
            )}
            <circle
              cx={n.x}
              cy={n.y}
              r={r}
              fill={`url(#wl-sphere-${(n.primaryRole as Role) ?? "peripheral"})`}
              stroke={meta.color}
              strokeWidth={isSelected ? 3 : 1.5}
              filter="url(#wl-shadow)"
            />
            {/* Specular highlight — small, very soft white blob on the
                upper-left to sell the 3D illusion. */}
            <ellipse
              cx={n.x - r * 0.32}
              cy={n.y - r * 0.42}
              rx={r * 0.42}
              ry={r * 0.26}
              fill="#FFFFFF"
              opacity={0.55}
              style={{ pointerEvents: "none" }}
            />
            <text
              x={n.x}
              y={n.y + r * 0.18}
              fontSize={Math.max(11, r * 0.55)}
              fontWeight={800}
              fill={meta.color}
              textAnchor="middle"
            >
              {n.firstName.charAt(0)}
              {n.lastName.charAt(0)}
            </text>
            <text
              x={n.x}
              y={n.y + r + Math.max(14, r * 0.32)}
              fontSize={Math.max(12, r * 0.32)}
              fontWeight={isSelected || isAnchor ? 700 : 600}
              fill={C.ink}
              textAnchor="middle"
              style={{ paintOrder: "stroke", stroke: C.graphBg, strokeWidth: 3 }}
            >
              {n.lastName} · {n.grade ?? "?"}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
