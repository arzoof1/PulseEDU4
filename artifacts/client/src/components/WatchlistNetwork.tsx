import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  Video,
  X,
  Zap,
} from "lucide-react";
import { formatCaseNumber } from "../lib/caseNumber";
import { authFetch } from "../lib/authToken";
import LogInteractionModal from "./watchlist/LogInteractionModal";
import { ROLE_META, WL_COLORS as C, statusPillStyle, type Role } from "./watchlist/colors";
import DictateButton, { appendDictated } from "./DictateButton";
import CameraPicker from "./CameraPicker";
import {
  HowToUseHelp,
  HowToSection,
  howtoListStyle,
} from "./HowToUseHelp";

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
  schoolYearLabel?: string;
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

interface StudentStatement {
  id: number;
  interactionId: number;
  status: string;
  body: string;
  requestedByName: string | null;
  requestedAt: string;
  completedAt: string | null;
  remindCount: number;
  interactionSummary: string | null;
  interactionOccurredAt: string | null;
  interactionKind: string | null;
  caseId: number | null;
  caseNumber: number | null;
  caseTitle: string | null;
  caseStatus: string | null;
}

interface Props {
  onBack?: () => void;
  onOpenCase?: (caseId: number, anchor?: string) => void;
  // Opens the global Student Finder modal directly on the given
  // student's "today" view (skips the search step). Used by the
  // right-rail "Open in Student Finder" affordance so a user
  // investigating from the network view can jump to today's
  // schedule / live location for the focused student without losing
  // their place on the network surface.
  onOpenStudentFinder?: (studentId: string, displayName: string) => void;
  // True when the viewer is in the Case Investigator group (admin
  // tier + Behavior Specialist + MTSS Coordinator + Dean). Gates the
  // "+ Footage" quick-add button on the case-zoom toolbar; non-
  // investigators don't see the button at all and the camera badges
  // they get stay informational.
  isInvestigator?: boolean;
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
    // Ring radius. Sized to leave a gap above each ring for the
    // case-name pill (which we render at cy - r - 22) so the pill
    // doesn't collide with the bottom student labels of the row above.
    const radius = Math.min(cellW, cellH) * 0.36;
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

// Full-school web layout. Every student in the school window goes onto
// one canvas as a single force-directed-style web (no case grouping).
// We use a deterministic golden-angle phyllotaxis spiral sorted by
// degree (sum of edge weights touching the node) — this gives the
// most-connected students the visual focus near the center while the
// peripherals fan out, without needing a real physics simulation.
//
// Performance cap: above 500 nodes we drop students with zero edges
// from the render so the browser stays responsive. Their case-grid view
// still shows them.
function layoutFullWeb(
  nodes: NetNode[],
  edges: NetEdge[],
): { positioned: Positioned[]; rendered: number; suppressed: number; nodeScale: number } {
  const W = 1180;
  const H = 820;
  const cx = W / 2;
  const cy = H / 2;
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.a, (degree.get(e.a) ?? 0) + e.weight);
    degree.set(e.b, (degree.get(e.b) ?? 0) + e.weight);
  }
  const cap = 500;
  const filtered =
    nodes.length > cap ? nodes.filter((n) => (degree.get(n.studentId) ?? 0) > 0) : nodes;
  const sorted = [...filtered].sort(
    (a, b) =>
      (degree.get(b.studentId) ?? 0) - (degree.get(a.studentId) ?? 0) ||
      b.total - a.total ||
      a.lastName.localeCompare(b.lastName),
  );
  const golden = Math.PI * (3 - Math.sqrt(5));
  // sqrt(i)*spacing keeps the spiral evenly dense and the outer ring
  // sits at maxR. We let `spacing` grow without an upper cap so that
  // sparse graphs fill the canvas instead of huddling in the center.
  const maxR = Math.min(W, H) * 0.46;
  const spacing = sorted.length > 0 ? maxR / Math.sqrt(sorted.length) : 24;
  // Sphere scale derived from spacing so the largest sphere is just
  // under the inter-node spacing — spheres pop as large as possible
  // without overlap. Tuned against baseR's ceiling of ~26 so a 1.0
  // scale ≈ a 52px-diameter sphere; spacing/30 keeps a small breathing
  // gap. Floor at 0.45 so 500-node webs stay readable, ceiling at 1.6
  // so a 5-node web doesn't end up with absurd planet-spheres.
  const nodeScale = Math.max(0.45, Math.min(1.6, spacing / 30));
  const positioned: Positioned[] = sorted.map((n, i) => {
    const angle = i * golden;
    const r = Math.sqrt(i + 0.5) * spacing;
    return {
      ...n,
      cluster: -2, // synthetic — full-web has no case clusters
      x: cx + Math.cos(angle) * r,
      y: cy + Math.sin(angle) * r,
    };
  });
  return {
    positioned,
    rendered: positioned.length,
    suppressed: nodes.length - positioned.length,
    nodeScale,
  };
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

// Per-kind edge palette. Severity-coded: physical (fight) is loudest,
// then verbal/bullying, then social (rumor), then peripheral/other in
// muted gray. Picks the most severe kind on the edge so a fight that
// also has a rumor draws as a fight.
const EDGE_KIND_COLOR: Record<string, string> = {
  fight: C.alert, // #9B1C2E — deep red
  bullying: "#6B2D8C", // purple — distinct from fight + verbal
  verbal: C.brand, // #7A1F2B — burgundy
  rumor: C.warn, // #B8531A — orange
  peripheral_note: "#A89A85",
};
const EDGE_KIND_PRIORITY = [
  "fight",
  "bullying",
  "verbal",
  "rumor",
  "peripheral_note",
];

function edgeColor(kinds: string[]): string {
  for (const k of EDGE_KIND_PRIORITY) {
    if (kinds.includes(k)) return EDGE_KIND_COLOR[k]!;
  }
  return "#A89A85";
}

function edgeDashed(kinds: string[]): boolean {
  return kinds.every((k) => k === "peripheral_note");
}

// Map shared-incident `weight` to a stroke width with a steeper curve
// than the previous (max(1.8, weight*1.5)). Single-incident edges stay
// thin (1.5px), 5+ incident pairs render visibly heavy (~9px) so the
// network surfaces intensity even when every edge shares one color.
function edgeWidth(weight: number, selected: boolean): number {
  const w = Math.max(1, Math.min(8, weight));
  const base = 1 + Math.log2(w + 1) * 2.6; // 1→1, 2→3.1, 5→5.6, 8→8
  return selected ? base * 1.7 : base;
}

export default function WatchlistNetwork({
  onBack,
  onOpenCase,
  onOpenStudentFinder,
  isInvestigator = false,
}: Props) {
  const [data, setData] = useState<Resp | null>(null);
  const [windowDays, setWindowDays] = useState(30);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  // null = overview (all clusters); a number = zoom into one cluster
  // (case id, or -1 for the loose / no-case ring).
  const [zoomedClusterId, setZoomedClusterId] = useState<number | null>(null);
  // Toggles the canvas between the default per-case grid view and a
  // single zoomed-out force-directed web showing every student node +
  // every confirmed edge in one unified canvas. Not persisted — resets
  // to "case-grid" on every visit (intentional: avoids surprising the
  // next user on a shared workstation).
  const [viewMode, setViewMode] = useState<"case-grid" | "full-web">("case-grid");
  // Status filter for the case-grid view. Mirrors the Active-cases
  // panel: by default we show working cases (open + monitoring +
  // escalated) and hide closed; the user can flip to "All open" or
  // "Include closed" if they're investigating something historical.
  // "active" is the inclusive default — it matches what the right-rail
  // Active cases list shows, so the count of rings on the canvas
  // never disagrees with the count in the panel.
  type StatusPick = "active" | "open-only" | "all";
  const [statusPick, setStatusPick] = useState<StatusPick>("active");
  // Phase 2.1 — per-student rollup of video evidence on the currently
  // zoomed case. Empty map when not zoomed or when the viewer is not
  // an admin (the endpoint 403s for non-admins, which we silently treat
  // as "no badges to paint" so the network surface itself stays
  // available to core-team viewers).
  const [evidenceSummary, setEvidenceSummary] = useState<
    Map<
      string,
      { count: number; topTier: "confirmed" | "inferred" | "possible"; hasCleared: boolean }
    >
  >(new Map());
  // Bumped after a successful "+ Footage" quick-add so the rollup
  // re-fetches and the player-sphere badges update without a page
  // reload. Cleared when the user zooms out.
  const [evidenceReloadKey, setEvidenceReloadKey] = useState(0);
  // Total clip count on the zoomed case (independent of player tags) so
  // the toolbar can show "this case has footage" even before anyone is
  // tagged. Reset to 0 when zoomed out.
  const [zoomedCaseClipCount, setZoomedCaseClipCount] = useState(0);
  const [showFootageModal, setShowFootageModal] = useState(false);
  // Witness statements authored by the currently selected student. Loaded
  // on demand when a node is picked so investigators can read the
  // student's own words inline without leaving the network view.
  const [selectedStatements, setSelectedStatements] = useState<
    StudentStatement[] | null
  >(null);
  const [statementsLoading, setStatementsLoading] = useState(false);
  const [expandedStatements, setExpandedStatements] = useState<Set<number>>(
    new Set(),
  );

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

  // Refresh the per-case evidence rollup whenever we zoom into (or
  // out of) a case. Loose-cluster zoom (id < 0) has no case, so skip.
  useEffect(() => {
    if (zoomedClusterId === null || zoomedClusterId < 0) {
      setEvidenceSummary(new Map());
      setZoomedCaseClipCount(0);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const r = await authFetch(
          `/api/watchlist/cases/${zoomedClusterId}/player-clip-summary`,
        );
        if (cancelled) return;
        if (r.status === 403 || !r.ok) {
          setEvidenceSummary(new Map());
          setZoomedCaseClipCount(0);
          return;
        }
        const j = (await r.json()) as {
          summary: Array<{
            studentId: string;
            count: number;
            topTier: "confirmed" | "inferred" | "possible";
            hasCleared: boolean;
          }>;
          totalClips?: number;
        };
        const m = new Map<
          string,
          { count: number; topTier: "confirmed" | "inferred" | "possible"; hasCleared: boolean }
        >();
        for (const row of j.summary)
          m.set(row.studentId, {
            count: row.count,
            topTier: row.topTier,
            hasCleared: row.hasCleared,
          });
        setEvidenceSummary(m);
        setZoomedCaseClipCount(j.totalClips ?? 0);
      } catch {
        if (!cancelled) {
          setEvidenceSummary(new Map());
          setZoomedCaseClipCount(0);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [zoomedClusterId, evidenceReloadKey]);

  // When zoomed, restrict to nodes that belong to that cluster and run a
  // single-cluster layout so the bubbles fill the viewport. Edges are
  // filtered to those whose endpoints are both in the zoomed cluster so
  // we don't render dangling lines off-canvas.
  // Apply the status filter chips to derive the data we actually
  // render in case-grid view. We rebuild a Resp here so every downstream
  // memo (layout, stats, the right-rail Active cases list, ring caption
  // lookup, zoomedData) reads from the same source of truth and they
  // can never disagree about how many cases are on screen. Loose nodes
  // (caseIds.length === 0) always pass through — the loose ring is its
  // own bucket and is not a "case". Nodes whose only case is filtered
  // out are removed (otherwise they'd silently fall into the loose
  // ring, which would be misleading).
  // Declared before zoomedData so the zoom memo can read from it.
  const gridData = useMemo<Resp | null>(() => {
    if (!data) return null;
    const passes = (s: string): boolean => {
      if (statusPick === "all") return true;
      if (statusPick === "open-only") return s === "open";
      // "active" — the default; matches the right-rail panel
      return s !== "closed";
    };
    const visibleCaseIds = new Set(
      data.cases.filter((c) => passes(c.status)).map((c) => c.id),
    );
    const cases = data.cases.filter((c) => visibleCaseIds.has(c.id));
    // Rewrite each node's caseIds so layout()'s caseIds[0] cluster
    // keying picks a *visible* primary case. Without this, a node
    // whose first case ID was filtered out would either fall into the
    // wrong cluster or be mis-keyed to a cid the renderer can't
    // resolve (causing it to read as loose). Nodes with no remaining
    // visible case become true loose nodes (caseIds = []).
    const nodes = data.nodes
      .filter((n) => {
        if (n.caseIds.length === 0) return true;
        return n.caseIds.some((id) => visibleCaseIds.has(id));
      })
      .map((n) =>
        n.caseIds.length === 0
          ? n
          : { ...n, caseIds: n.caseIds.filter((id) => visibleCaseIds.has(id)) },
      );
    const nodeIdSet = new Set(nodes.map((n) => n.studentId));
    const edges = data.edges.filter(
      (e) =>
        nodeIdSet.has(e.a) &&
        nodeIdSet.has(e.b) &&
        (e.caseIds.length === 0 ||
          e.caseIds.some((id) => visibleCaseIds.has(id))),
    );
    return { nodes, edges, cases, windowDays: data.windowDays };
  }, [data, statusPick]);

  const zoomedData = useMemo(() => {
    if (!data || zoomedClusterId === null) return null;
    // Use the same source as the overview render so cluster membership
    // is consistent under the status filter. In case-grid, gridData
    // has each node's caseIds rewritten to only contain visible cases,
    // so caseIds[0] correctly identifies the ring the node was placed
    // in. Falling back to raw data keeps full-web zoom behavior intact.
    const src = viewMode === "case-grid" ? (gridData ?? data) : data;
    const inCluster = src.nodes.filter(
      (n) => (n.caseIds[0] ?? -1) === zoomedClusterId,
    );
    const ids = new Set(inCluster.map((n) => n.studentId));
    const edges = src.edges.filter((e) => ids.has(e.a) && ids.has(e.b));
    const cases = src.cases.filter((c) => c.id === zoomedClusterId);
    return { nodes: inCluster, edges, cases, windowDays: src.windowDays } as Resp;
  }, [data, gridData, viewMode, zoomedClusterId]);

  const layoutResult = useMemo(() => {
    if (!data) return null;
    if (zoomedClusterId !== null && zoomedData) {
      const z = layoutZoomed(zoomedData.nodes, zoomedClusterId);
      return {
        positioned: z.positioned,
        clusters: z.clusters,
        anchorIds: z.anchorId ? new Set([z.anchorId]) : new Set<string>(),
        suppressed: 0,
        nodeScale: 1,
      };
    }
    if (viewMode === "full-web") {
      const f = layoutFullWeb(data.nodes, data.edges);
      return {
        positioned: f.positioned,
        clusters: new Map<number, { cx: number; cy: number; r: number; size: number }>(),
        anchorIds: new Set<string>(),
        suppressed: f.suppressed,
        nodeScale: f.nodeScale,
      };
    }
    const o = layout((gridData ?? data).nodes);
    return {
      positioned: o.positioned,
      clusters: o.clusters,
      anchorIds: o.anchorIds,
      suppressed: 0,
      nodeScale: 1,
    };
  }, [data, gridData, zoomedClusterId, zoomedData, viewMode]);

  // Source of truth for the canvas. Zoomed-into-case wins (its own
  // single-cluster bundle). Otherwise: case-grid uses the status-
  // filtered grid so ring count == right-rail count; full-web is a
  // single force-directed web of *every* student/edge regardless of
  // case status — filtering rings would silently drop nodes from the
  // web view, which is the wrong mental model. So full-web stays on
  // raw `data`.
  const activeData: Resp | null =
    zoomedData ?? (viewMode === "case-grid" ? (gridData ?? data) : data);

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

  // If the user flips the status filter to one that excludes the
  // currently-zoomed case, drop the zoom so we don't render a phantom
  // ring whose case isn't in the filtered set.
  useEffect(() => {
    if (zoomedClusterId === null || zoomedClusterId < 0 || !gridData) return;
    const stillVisible = gridData.cases.some((c) => c.id === zoomedClusterId);
    if (!stillVisible) {
      setZoomedClusterId(null);
      setSelectedId(null);
    }
  }, [gridData, zoomedClusterId]);

  // Pull this student's witness statements when they're picked. Reset
  // expanded set so a previously-opened statement doesn't carry over to
  // a new student. Cleared on deselect to keep memory tidy.
  useEffect(() => {
    if (!selectedId) {
      setSelectedStatements(null);
      setExpandedStatements(new Set());
      return;
    }
    let alive = true;
    setStatementsLoading(true);
    setExpandedStatements(new Set());
    void (async () => {
      try {
        const r = await authFetch(
          `/api/watchlist/students/${encodeURIComponent(selectedId)}/statements`,
        );
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = (await r.json()) as { statements: StudentStatement[] };
        if (alive) setSelectedStatements(d.statements);
      } catch {
        if (alive) setSelectedStatements([]);
      } finally {
        if (alive) setStatementsLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [selectedId]);

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
    // Mirror activeData's source choice so the stat strip matches the
    // canvas: full-web counts everything; case-grid counts only
    // what's actually rendered after the status filter.
    const src = viewMode === "case-grid" ? (gridData ?? data) : data;
    if (!src) return null;
    const flagged = src.nodes.filter((n) => n.flag !== null).length;
    const crossCluster = src.edges.filter((e) => {
      const a = src.nodes.find((n) => n.studentId === e.a);
      const b = src.nodes.find((n) => n.studentId === e.b);
      if (!a || !b) return false;
      const ac = a.caseIds[0] ?? -1;
      const bc = b.caseIds[0] ?? -1;
      return ac !== bc;
    }).length;
    return {
      students: src.nodes.length,
      edges: src.edges.length,
      flagged,
      crossCluster,
    };
  }, [data, gridData, viewMode]);

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
              Schoolwide Behavior Network
            </h1>
            <p className="mt-1 max-w-2xl text-sm" style={{ color: C.inkSoft }}>
              School-wide map of who keeps showing up together. Click a student to focus their
              connections. Click a case label to open the case file.
            </p>

            <HowToUseHelp title="How to use Network view">
              <HowToSection title="What this is">
                The school's full incident graph for the selected
                window. Every active case is its own ring; every
                student tied to a case is a sphere on that ring.
                Students who appear in incidents but aren't (yet)
                attached to a case sit on the loose ring at the top.
                It's the fastest way to see clusters forming, repeat
                actors across cases, and which cases share players.
              </HowToSection>
              <HowToSection title="Reading the graph">
                <ul style={howtoListStyle}>
                  <li>
                    <strong>Case ring</strong> — one case. The student
                    in the center is the anchor (highest involvement);
                    the rest orbit around them.
                  </li>
                  <li>
                    <strong>Sphere size</strong> — bigger = more
                    appearances across this window. The center anchor
                    is enlarged on purpose to highlight the focal
                    student.
                  </li>
                  <li>
                    <strong>Sphere color</strong> — primary role
                    (Direct, Target, Witness, Peripheral, Rumor
                    spreader, De-escalator, Instigator).
                  </li>
                  <li>
                    <strong>Edges</strong> — two students co-appearing
                    in incidents. Thicker = more co-appearances.
                  </li>
                  <li>
                    <strong>Loose ring</strong> (top) — students with
                    interactions but no case attached. Watch this for
                    patterns that should become a case.
                  </li>
                </ul>
              </HowToSection>
              <HowToSection title="Drilling in">
                <ul style={howtoListStyle}>
                  <li>
                    <strong>Click a case ring</strong> (the halo
                    body) to zoom into just that case — the anchor
                    sits in the middle and the players spread out.
                    Use <strong>Back</strong> to return to the
                    overview.
                  </li>
                  <li>
                    <strong>Click the case title pill</strong> at the
                    top of any ring (or "Open case file" in zoom) to
                    leave the network and open the full Case Detail
                    page.
                  </li>
                  <li>
                    <strong>Click a student sphere</strong> to open
                    the side rail with their role breakdown across
                    every interaction in this window, plus quick
                    actions (Schedule check-in, Open case).
                  </li>
                </ul>
              </HowToSection>
              <HowToSection title="Window & filters">
                The <strong>Last N days</strong> chip (top left) shows
                the active window. Change it on the Hub before opening
                this view; the network re-computes for that range.
                Smaller windows surface fresh activity; larger windows
                surface chronic patterns.
              </HowToSection>
              <HowToSection title="When to use this vs. Spider">
                Use Network when you want the whole school at a glance
                — finding new clusters, seeing who bridges multiple
                cases, spotting an emerging hotspot. Use Student
                Spider when you already have a name in mind and want
                that one student's complete footprint.
              </HowToSection>
            </HowToUseHelp>
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
          <span
            className="ml-3 text-[11px] font-semibold uppercase tracking-wider"
            style={{ color: C.inkSoft }}
          >
            Cases
          </span>
          {(
            [
              { v: "active", label: "Active" },
              { v: "open-only", label: "Open only" },
              { v: "all", label: "Include closed" },
            ] as const
          ).map((opt) => (
            <button
              key={opt.v}
              type="button"
              onClick={() => setStatusPick(opt.v)}
              className="rounded-md px-2.5 py-1 text-xs font-semibold"
              title={
                opt.v === "active"
                  ? "Open + Monitoring + Escalated (matches the right-rail Active cases panel)"
                  : opt.v === "open-only"
                    ? "Open status only — hides Monitoring and Escalated"
                    : "Show every case in this window, including Closed"
              }
              style={{
                background: opt.v === statusPick ? C.ink : "transparent",
                color: opt.v === statusPick ? "#fff" : C.ink,
                border: `1px solid ${opt.v === statusPick ? C.ink : C.line}`,
              }}
            >
              {opt.label}
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
              { label: "Students in network", value: stats.students, sub: `across ${(viewMode === "case-grid" ? (gridData ?? data) : data)?.cases.length ?? 0} cases`, icon: Users, tone: C.ink },
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
                        {zoomedCase ? `Case ${formatCaseNumber(zoomedCase)}` : "Loose / no case"}
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
                        {zoomedCaseClipCount > 0 && (
                          <button
                            type="button"
                            onClick={() =>
                              onOpenCase?.(zoomedCase.id, "video-evidence")
                            }
                            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] font-bold hover:bg-red-50"
                            style={{ color: "#9F1D1D" }}
                            title={
                              isInvestigator
                                ? `${zoomedCaseClipCount} clip${zoomedCaseClipCount === 1 ? "" : "s"} on file. Click to review and tag players.`
                                : `${zoomedCaseClipCount} clip${zoomedCaseClipCount === 1 ? "" : "s"} on file. Click to review.`
                            }
                            aria-label={`Review ${zoomedCaseClipCount} video clip${zoomedCaseClipCount === 1 ? "" : "s"} on this case`}
                          >
                            <Video className="h-4 w-4" strokeWidth={2.5} />
                            <span className="tabular-nums">
                              {zoomedCaseClipCount}
                            </span>
                          </button>
                        )}
                        {isInvestigator && (
                          <button
                            type="button"
                            onClick={() => setShowFootageModal(true)}
                            className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11px] font-semibold"
                            style={{
                              borderColor: C.line,
                              color: C.brand,
                              background: C.panel,
                            }}
                            title="Log a video clip on this case"
                          >
                            <Video className="h-3 w-3" /> + Footage
                          </button>
                        )}
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
                <div className="flex w-full items-center gap-3">
                  <Zap className="h-4 w-4" style={{ color: C.brand }} />
                  <span className="text-sm font-semibold">
                    {viewMode === "full-web"
                      ? "Full school web"
                      : "School-wide interaction graph"}
                  </span>
                  <span className="text-[11px]" style={{ color: C.inkSoft }}>
                    {viewMode === "full-web"
                      ? "· every confirmed edge in one canvas · hover a node to read its name"
                      : "· click any case ring to zoom in · click a node to focus"}
                  </span>
                  {viewMode === "full-web" && layoutResult && layoutResult.suppressed > 0 && (
                    <span
                      className="rounded-full px-2 py-0.5 text-[10px] font-semibold"
                      style={{ background: "#FBE9D8", color: "#7A4A12" }}
                      title={`${layoutResult.suppressed} student${layoutResult.suppressed === 1 ? "" : "s"} with no edges in this window were hidden to keep the canvas readable. They still appear in the case-grid view.`}
                    >
                      {layoutResult.suppressed} isolated hidden
                    </span>
                  )}
                  <div
                    className="ml-auto inline-flex overflow-hidden rounded-md border"
                    style={{ borderColor: C.line }}
                    role="tablist"
                    aria-label="Network view mode"
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={viewMode === "case-grid"}
                      onClick={() => {
                        setViewMode("case-grid");
                        setSelectedId(null);
                      }}
                      className="px-3 py-1 text-[11px] font-bold"
                      style={{
                        background: viewMode === "case-grid" ? C.brand : C.panel,
                        color: viewMode === "case-grid" ? "#FFFFFF" : C.ink,
                      }}
                      title="Group nodes by case (default)"
                    >
                      Case grid
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={viewMode === "full-web"}
                      onClick={() => {
                        setViewMode("full-web");
                        setSelectedId(null);
                      }}
                      className="px-3 py-1 text-[11px] font-bold"
                      style={{
                        background: viewMode === "full-web" ? C.brand : C.panel,
                        color: viewMode === "full-web" ? "#FFFFFF" : C.ink,
                      }}
                      title="One zoomed-out web of every student + every confirmed edge"
                    >
                      Full school web
                    </button>
                  </div>
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
                mode={zoomedClusterId !== null ? "case-grid" : viewMode}
                anchorIds={layoutResult!.anchorIds}
                nodeScale={layoutResult!.nodeScale}
                evidenceSummary={evidenceSummary}
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
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                {/* Edge kind palette — most severe wins when an edge has
                    multiple kinds. Width is independent (count of shared
                    incidents), so a thick orange edge means many rumor
                    interactions between the same pair. */}
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-block h-[3px] w-6" style={{ background: EDGE_KIND_COLOR.fight }} /> Fight
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-block h-[3px] w-6" style={{ background: EDGE_KIND_COLOR.bullying }} /> Bullying
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-block h-[3px] w-6" style={{ background: EDGE_KIND_COLOR.verbal }} /> Verbal
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-block h-[3px] w-6" style={{ background: EDGE_KIND_COLOR.rumor }} /> Rumor
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-block h-[3px] w-6" style={{ background: EDGE_KIND_COLOR.peripheral_note }} /> Other
                </span>
                {/* Width legend — thin = 1 incident, thick = 5+. */}
                <span
                  className="inline-flex items-center gap-1.5 border-l pl-3"
                  style={{ borderColor: C.line }}
                  title="Line thickness = number of shared incidents between the pair"
                >
                  <span className="inline-block h-[1.5px] w-4" style={{ background: C.inkSoft }} />
                  <span className="inline-block h-[5px] w-5" style={{ background: C.inkSoft }} />
                  Thicker = more shared incidents
                </span>
                <span
                  className="inline-flex items-center gap-1.5 border-l pl-3"
                  style={{ borderColor: C.line }}
                >
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
                {onOpenStudentFinder && (
                  <button
                    type="button"
                    onClick={() =>
                      onOpenStudentFinder(
                        selected.studentId,
                        `${selected.firstName} ${selected.lastName}`,
                      )
                    }
                    className="mt-3 inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] font-bold"
                    style={{
                      borderColor: C.line,
                      background: C.panel,
                      color: C.brand,
                    }}
                    title="Look up this student in the Student Finder (today's schedule + live location). Opens with the name pre-filled."
                  >
                    🔎 Open in Student Finder
                  </button>
                )}
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

            {/* Witness statements — read-inline so the investigator
                doesn't have to leave the network view to skim what this
                student actually said. Most-recent first, collapsed by
                default. */}
            {selected && (
              <div
                className="rounded-xl border p-5"
                style={{ borderColor: C.line, background: C.panel }}
              >
                <div className="flex items-center justify-between">
                  <div
                    className="text-[11px] font-semibold uppercase tracking-wider"
                    style={{ color: C.inkSoft }}
                  >
                    Witness statements
                  </div>
                  {selectedStatements && selectedStatements.length > 0 && (
                    <span
                      className="text-[11px] tabular-nums"
                      style={{ color: C.inkSoft }}
                    >
                      {selectedStatements.length}
                    </span>
                  )}
                </div>
                <div className="mt-2">
                  {statementsLoading ? (
                    <div className="text-[12px]" style={{ color: C.inkSoft }}>
                      Loading…
                    </div>
                  ) : !selectedStatements || selectedStatements.length === 0 ? (
                    <div className="text-[12px]" style={{ color: C.inkSoft }}>
                      No witness statements on record for this student.
                    </div>
                  ) : (
                    <div className="flex flex-col">
                      {selectedStatements.map((s) => {
                        const isOpen = expandedStatements.has(s.id);
                        const completed = s.status === "completed";
                        const waived = s.status === "waived";
                        const hasBody = (s.body ?? "").trim().length > 0;
                        const statusBg = completed
                          ? "#DCFCE7"
                          : waived
                            ? C.bg
                            : C.warnSoft;
                        const statusFg = completed
                          ? "#166534"
                          : waived
                            ? C.inkSoft
                            : C.warn;
                        const dt = new Date(s.requestedAt);
                        const dateLabel = Number.isNaN(dt.getTime())
                          ? ""
                          : dt.toLocaleDateString(undefined, {
                              month: "short",
                              day: "numeric",
                              year: "numeric",
                            });
                        return (
                          <div
                            key={s.id}
                            className="border-b py-2 last:border-b-0"
                            style={{ borderColor: C.line }}
                          >
                            <button
                              type="button"
                              onClick={() => {
                                setExpandedStatements((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(s.id)) next.delete(s.id);
                                  else next.add(s.id);
                                  return next;
                                });
                              }}
                              className="flex w-full items-start gap-2 text-left"
                            >
                              <ChevronRight
                                className="mt-0.5 h-3.5 w-3.5 shrink-0 transition-transform"
                                style={{
                                  color: C.inkSoft,
                                  transform: isOpen
                                    ? "rotate(90deg)"
                                    : undefined,
                                }}
                              />
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <span
                                    className="rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase"
                                    style={{
                                      background: statusBg,
                                      color: statusFg,
                                    }}
                                  >
                                    {s.status}
                                  </span>
                                  {s.caseId != null && (
                                    <span
                                      className="text-[11px] font-semibold"
                                      style={{ color: C.ink }}
                                    >
                                      Case{" "}
                                      {s.caseNumber != null
                                        ? formatCaseNumber({
                                            caseNumber: s.caseNumber,
                                          } as NetCase)
                                        : `#${s.caseId}`}
                                    </span>
                                  )}
                                  <span
                                    className="text-[11px]"
                                    style={{ color: C.inkSoft }}
                                  >
                                    {dateLabel}
                                  </span>
                                </div>
                                <div
                                  className="mt-0.5 truncate text-[12px]"
                                  style={{ color: C.inkSoft }}
                                >
                                  {s.interactionSummary || s.caseTitle || "—"}
                                </div>
                              </div>
                            </button>
                            {isOpen && (
                              <div className="mt-2 pl-5">
                                {hasBody ? (
                                  <div
                                    className="whitespace-pre-wrap rounded-md border p-2.5 text-[12px] leading-relaxed"
                                    style={{
                                      borderColor: C.line,
                                      background: C.bg,
                                      color: C.ink,
                                    }}
                                  >
                                    {s.body}
                                  </div>
                                ) : (
                                  <div
                                    className="text-[12px] italic"
                                    style={{ color: C.inkSoft }}
                                  >
                                    No body recorded yet
                                    {s.status !== "completed" &&
                                      s.status !== "waived"
                                      ? " — request still outstanding."
                                      : "."}
                                  </div>
                                )}
                                <div
                                  className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]"
                                  style={{ color: C.inkSoft }}
                                >
                                  {s.requestedByName && (
                                    <span>
                                      Requested by {s.requestedByName}
                                    </span>
                                  )}
                                  {s.completedAt && (
                                    <span>
                                      · Completed{" "}
                                      {new Date(
                                        s.completedAt,
                                      ).toLocaleDateString()}
                                    </span>
                                  )}
                                  {s.caseId != null && (
                                    <button
                                      type="button"
                                      onClick={() => onOpenCase?.(s.caseId!)}
                                      className="ml-auto underline"
                                      style={{ color: C.brand }}
                                    >
                                      Open case →
                                    </button>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
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
                  {statusPick === "all"
                    ? "Cases (incl. closed)"
                    : statusPick === "open-only"
                      ? "Open cases"
                      : "Active cases"}
                </div>
                <div className="mt-2 flex flex-col gap-1.5">
                  {/* Use the same filtered set as the canvas so the
                      panel and the rings can never disagree on count
                      under any chip selection. */}
                  {(gridData ?? data).cases.map((c) => {
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
                              Case {formatCaseNumber(c)}
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

      {showFootageModal && zoomedClusterId !== null && zoomedClusterId >= 0 && (
        <FootageQuickAddModal
          caseId={zoomedClusterId}
          caseLabel={
            zoomedCase
              ? `Case ${formatCaseNumber(zoomedCase)} · ${zoomedCase.title}`
              : "Selected case"
          }
          onClose={() => setShowFootageModal(false)}
          onCreated={() => {
            setShowFootageModal(false);
            setEvidenceReloadKey((k) => k + 1);
          }}
        />
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
  evidenceSummary,
  onSelectNode,
  onOpenCase,
  onZoomCluster,
  mode,
  nodeScale = 1,
}: {
  data: Resp;
  positioned: Positioned[];
  clusters: Map<number, { cx: number; cy: number; r: number; size: number }>;
  selectedId: string | null;
  zoomed: boolean;
  anchorIds: Set<string>;
  // Full-web only — sphere-radius multiplier derived from spiral
  // spacing so nodes pop as large as possible without overlap.
  // Ignored in case-grid / zoomed modes (they have their own sizing).
  nodeScale?: number;
  // Per-student rollup of video clip evidence on the currently zoomed
  // case. Empty in overview mode (we only paint badges on the per-case
  // zoom — overview rings are too dense for the glyph to read).
  evidenceSummary: Map<
    string,
    { count: number; topTier: "confirmed" | "inferred" | "possible"; hasCleared: boolean }
  >;
  onSelectNode: (id: string) => void;
  onOpenCase: (id: number) => void;
  onZoomCluster: (id: number) => void;
  // "case-grid" — default, halos + always-on labels, click-to-zoom rings.
  // "full-web" — single zoomed-out web; no halos, no zoom rings, labels
  // appear only on hover or for the selected node.
  mode?: "case-grid" | "full-web";
}) {
  const W = 1180;
  const H = 820;
  const nodeMap = new Map(positioned.map((n) => [n.studentId, n] as const));
  const caseById = new Map(data.cases.map((c) => [c.id, c] as const));
  const isSelectedEdge = (e: NetEdge) => e.a === selectedId || e.b === selectedId;
  const clusterIdsSorted = [...clusters.keys()];
  const isFullWeb = mode === "full-web";
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  // Mode/data flips don't always emit an onMouseLeave (the hovered
  // node's group can unmount mid-hover when we toggle to case-grid).
  // Clear hover state explicitly so a stale label can't re-appear when
  // the user toggles back to full-web later.
  useEffect(() => {
    setHoveredId(null);
  }, [mode, positioned]);

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
      {!isFullWeb && clusterIdsSorted.map((cid, idx) => {
        const cl = clusters.get(cid)!;
        const c = cid >= 0 ? caseById.get(cid) : null;
        // Distinct visual treatment for the loose / no-case ring so it
        // can never be mistaken for a 4th case (this used to read as a
        // case ring with a missing label, which was a real source of
        // confusion).
        const isLoose = !c;
        const label = c
          ? `Case ${formatCaseNumber(c)} · ${c.title}`
          : `Loose statements · ${cl.size} student${cl.size === 1 ? "" : "s"} · no case yet`;
        // Bigger, higher-contrast pill — readable from across the room
        // and far less likely to collide with student name labels of the
        // row above. Cap at ~42 chars instead of 30.
        const PILL_W = 320;
        const PILL_H = 28;
        // Keep the pill inside the SVG (H=820). For top-row rings the
        // ideal "above the ring" spot can fall above y=0 once you add
        // the cluster halo padding, which clipped the pill against the
        // SVG top edge. Clamp so we never render above 8px from the
        // top — in that case the pill sits just inside the ring halo
        // instead, still readable, never cropped.
        const PILL_Y = Math.max(8, cl.cy - cl.r - 22);
        const MAX_LABEL = 42;
        const display =
          label.length > MAX_LABEL ? label.slice(0, MAX_LABEL - 1) + "…" : label;
        // Loose ring uses an amber fill with dark text; case rings use
        // the brand color with white text. Both clearly distinguishable
        // at a glance.
        const pillFill = isLoose ? C.warn : C.brand;
        const pillStroke = isLoose ? C.warn : C.brand;
        const pillText = "#FFFFFF";
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
            {!zoomed ? (
              <g
                onClick={c ? () => onOpenCase(c.id) : undefined}
                style={{ cursor: c ? "pointer" : "default" }}
              >
                <rect
                  x={cl.cx - PILL_W / 2}
                  y={PILL_Y}
                  width={PILL_W}
                  height={PILL_H}
                  rx={14}
                  fill={pillFill}
                  stroke={pillStroke}
                  strokeWidth={1}
                  filter="url(#wl-shadow-soft)"
                />
                <text
                  x={cl.cx}
                  y={PILL_Y + PILL_H / 2 + 4}
                  fontSize={13}
                  fontWeight={700}
                  fill={pillText}
                  textAnchor="middle"
                  style={{ letterSpacing: 0.3 }}
                >
                  {display}
                </text>
                {c ? <title>Open Case {formatCaseNumber(c)}</title> : null}
              </g>
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
            strokeOpacity={0.35}
            strokeWidth={edgeWidth(e.weight, false)}
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
                strokeWidth={edgeWidth(e.weight, true)}
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
        // Logarithmic scaling so high-volume students are visibly larger
        // without crowding out the rest of the ring or covering name
        // labels. Tuned to keep the largest sphere ~1.8× the smallest.
        const baseR = 12 + Math.min(14, Math.log2(Math.max(1, n.total) + 1) * 4);
        const overviewScale = isAnchor ? 2.0 : 1.0;
        const zoomScale = isAnchor ? 2.2 : 1.35;
        // Full-web sphere size adapts to the spiral spacing computed
        // by layoutFullWeb so spheres pop as large as possible without
        // overlap. Sparse webs get bigger nodes; dense webs (~500
        // nodes) shrink toward the legibility floor.
        const r = isFullWeb
          ? baseR * nodeScale
          : zoomed
            ? baseR * zoomScale
            : baseR * overviewScale;
        const meta = ROLE_META[(n.primaryRole as Role) ?? "peripheral"] ?? ROLE_META.peripheral;
        const ringColor =
          n.flag === "always-peripheral"
            ? C.alert
            : n.flag === "frequency"
              ? C.warn
              : "transparent";
        const isSelected = n.studentId === selectedId;
        const isHovered = isFullWeb && n.studentId === hoveredId;
        // Hover-only labels in full-web (every-student canvas would
        // otherwise drown in overlapping name text). Selected node
        // always shows a label so the right-rail focus is obvious.
        const showLabel = !isFullWeb || isSelected || isHovered;
        // Skip drawing initials on the tiny full-web spheres — they
        // become illegible smudges. The hover label still shows the name.
        const showInitials = !isFullWeb || r >= 11;
        return (
          <g
            key={n.studentId}
            onClick={() => onSelectNode(n.studentId)}
            onMouseEnter={isFullWeb ? () => setHoveredId(n.studentId) : undefined}
            onMouseLeave={isFullWeb ? () => setHoveredId(null) : undefined}
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
            {/* Cross-case dashed outline — sits outside the sphere so
                it's safe to draw under (the sphere never overlaps it). */}
            {n.caseIds.length > 1 && (
              <circle
                cx={n.x}
                cy={n.y}
                r={r + (ringColor !== "transparent" ? 9 : 5)}
                fill="none"
                stroke={C.warn}
                strokeWidth={2}
                strokeDasharray="4 3"
                style={{ pointerEvents: "none" }}
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
            {showInitials && (
              <text
                x={n.x}
                y={n.y + r * 0.18}
                fontSize={Math.max(11, r * 0.55)}
                fontWeight={800}
                fill={meta.color}
                textAnchor="middle"
                style={{ pointerEvents: "none" }}
              >
                {n.firstName.charAt(0)}
                {n.lastName.charAt(0)}
              </text>
            )}
            {showLabel && (
              <text
                x={n.x}
                y={n.y + r + Math.max(isFullWeb ? 12 : 16, r * 0.34)}
                fontSize={isFullWeb ? (isHovered || isSelected ? 13 : 11) : Math.max(14, r * 0.38)}
                fontWeight={isSelected || isAnchor || isHovered ? 700 : 600}
                fill={C.ink}
                textAnchor="middle"
                style={{
                  paintOrder: "stroke",
                  stroke: C.graphBg,
                  strokeWidth: 3,
                  pointerEvents: "none",
                }}
              >
                {isFullWeb
                  ? `${n.firstName} ${n.lastName} · ${n.grade ?? "?"}`
                  : `${n.lastName} · ${n.grade ?? "?"}`}
              </text>
            )}
            {/* Phase 2.1 video-evidence badge. Sits in a fixed corner
                (upper-right) of every player sphere with ≥1 linked
                clip so admins can scan "who's actually on tape" at a
                glance. Style by topTier; small green check overlay
                when any clip has Cleared-by-footage; numeric chip
                when count > 1. Drops out gracefully at small radii
                so the overview ring isn't littered with tiny glyphs. */}
            {(() => {
              const ev = evidenceSummary.get(n.studentId);
              if (!ev) return null;
              if (r < 18) return null;
              const cx = n.x + r * 0.7;
              const cy = n.y - r * 0.7;
              const bs = Math.max(8, r * 0.34); // badge half-size
              const tier = ev.topTier;
              const fill =
                tier === "confirmed" ? "#9F1D1D" : tier === "inferred" ? "#FFFFFF" : "#FFFFFF";
              const stroke =
                tier === "confirmed" ? "#9F1D1D" : tier === "inferred" ? "#9F1D1D" : "#B58A8A";
              const opacity = tier === "possible" ? 0.85 : 1;
              const iconStroke = tier === "confirmed" ? "#FFFFFF" : "#9F1D1D";
              return (
                <g style={{ pointerEvents: "none" }} opacity={opacity}>
                  <title>
                    Video evidence: {ev.count} clip{ev.count === 1 ? "" : "s"} ({tier}
                    {ev.hasCleared ? ", cleared by footage" : ""})
                  </title>
                  {/* Halo so the badge reads on top of the sphere */}
                  <circle
                    cx={cx}
                    cy={cy}
                    r={bs + 1.5}
                    fill={C.graphBg}
                    stroke={stroke}
                    strokeWidth={1.2}
                  />
                  <circle
                    cx={cx}
                    cy={cy}
                    r={bs}
                    fill={fill}
                    stroke={stroke}
                    strokeWidth={1.4}
                  />
                  {/* Camera glyph: small body rect + lens circle. Hand-
                      rolled so we don't need lucide inside <svg>. */}
                  <rect
                    x={cx - bs * 0.55}
                    y={cy - bs * 0.35}
                    width={bs * 1.1}
                    height={bs * 0.7}
                    rx={bs * 0.12}
                    fill="none"
                    stroke={iconStroke}
                    strokeWidth={Math.max(1, bs * 0.18)}
                  />
                  <rect
                    x={cx - bs * 0.18}
                    y={cy - bs * 0.55}
                    width={bs * 0.36}
                    height={bs * 0.22}
                    fill={iconStroke}
                  />
                  <circle
                    cx={cx}
                    cy={cy}
                    r={bs * 0.22}
                    fill="none"
                    stroke={iconStroke}
                    strokeWidth={Math.max(1, bs * 0.16)}
                  />
                  {ev.hasCleared && (
                    <g>
                      <circle
                        cx={cx + bs * 0.85}
                        cy={cy - bs * 0.85}
                        r={bs * 0.55}
                        fill="#1E6E3A"
                        stroke="#FFFFFF"
                        strokeWidth={1}
                      />
                      <path
                        d={`M ${cx + bs * 0.6},${cy - bs * 0.85} l ${bs * 0.18},${bs * 0.18} l ${bs * 0.32},${-bs * 0.32}`}
                        fill="none"
                        stroke="#FFFFFF"
                        strokeWidth={Math.max(1.2, bs * 0.18)}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </g>
                  )}
                  {ev.count > 1 && (
                    <g>
                      <circle
                        cx={cx - bs * 0.85}
                        cy={cy + bs * 0.7}
                        r={bs * 0.55}
                        fill="#1F2937"
                        stroke="#FFFFFF"
                        strokeWidth={1}
                      />
                      <text
                        x={cx - bs * 0.85}
                        y={cy + bs * 0.7 + bs * 0.22}
                        fontSize={bs * 0.75}
                        fontWeight={800}
                        fill="#FFFFFF"
                        textAnchor="middle"
                      >
                        {ev.count}
                      </text>
                    </g>
                  )}
                </g>
              );
            })()}
            {/* Cross-case count badge — rendered LAST so it sits on top
                of the sphere, specular highlight, initials, and any
                other corner badges. */}
            {n.caseIds.length > 1 && r >= 14 && (
              <g style={{ pointerEvents: "none" }}>
                <title>
                  Active on {n.caseIds.length} cases at once
                </title>
                <circle
                  cx={n.x - r * 0.78}
                  cy={n.y - r * 0.78}
                  r={Math.max(8, r * 0.34)}
                  fill={C.warn}
                  stroke="#FFFFFF"
                  strokeWidth={1.5}
                />
                <text
                  x={n.x - r * 0.78}
                  y={n.y - r * 0.78 + Math.max(8, r * 0.34) * 0.36}
                  fontSize={Math.max(10, r * 0.4)}
                  fontWeight={800}
                  fill="#FFFFFF"
                  textAnchor="middle"
                >
                  {n.caseIds.length}
                </text>
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// Quick "+ Footage" modal anchored to the case-zoom toolbar. Mirrors
// the add-clip form in VideoEvidencePanel (camera label, start/end,
// source URL, notes) so admins can register the *existence* of a
// clip without leaving the network view. Player tagging + confidence
// rating still happens inside the full case file — this surface
// intentionally only logs that the clip exists, then the badges on
// the player spheres update via evidenceReloadKey.
function FootageQuickAddModal({
  caseId,
  caseLabel,
  onClose,
  onCreated,
}: {
  caseId: number;
  caseLabel: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [label, setLabel] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!label.trim() || !start) return;
    setSaving(true);
    setError(null);
    try {
      // The server expects ISO8601; <input type="datetime-local"> gives
      // us a naive local string, which the Date constructor reads as
      // local time. Re-emit as ISO so the timestamp survives the trip.
      const startIso = new Date(start).toISOString();
      const endIso = end ? new Date(end).toISOString() : "";
      const r = await authFetch(
        `/api/watchlist/cases/${caseId}/video-evidence`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cameraLabel: label.trim(),
            timestampStart: startIso,
            timestampEnd: endIso,
            sourceUrl: "",
            notes: notes.trim(),
          }),
        },
      );
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(15, 23, 42, 0.55)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border shadow-2xl"
        style={{ borderColor: C.line, background: C.panel }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-start justify-between border-b px-4 py-3"
          style={{ borderColor: C.line }}
        >
          <div className="min-w-0">
            <div
              className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider"
              style={{ color: C.inkSoft }}
            >
              <Video className="h-3.5 w-3.5" /> Log video evidence
            </div>
            <div className="truncate text-sm font-bold" style={{ color: C.ink }}>
              {caseLabel}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 hover:bg-black/5"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 px-4 py-3 text-sm">
          <div className="block">
            <div className="mb-1 text-[11px] font-semibold" style={{ color: C.inkSoft }}>
              Camera <span style={{ color: C.alert }}>*</span>
            </div>
            <CameraPicker
              value={label}
              onChange={setLabel}
              borderColor={C.line}
              bg={C.bg}
              inkSoft={C.inkSoft}
              required
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <div className="mb-1 text-[11px] font-semibold" style={{ color: C.inkSoft }}>
                Start <span style={{ color: C.alert }}>*</span>
              </div>
              <input
                type="datetime-local"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                className="w-full rounded-md border px-2.5 py-1.5"
                style={{ borderColor: C.line, background: C.bg }}
              />
            </label>
            <label className="block">
              <div className="mb-1 text-[11px] font-semibold" style={{ color: C.inkSoft }}>
                End (optional)
              </div>
              <input
                type="datetime-local"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                className="w-full rounded-md border px-2.5 py-1.5"
                style={{ borderColor: C.line, background: C.bg }}
              />
            </label>
          </div>
          <div className="block">
            <div className="mb-1 flex items-center justify-between">
              <div className="text-[11px] font-semibold" style={{ color: C.inkSoft }}>
                Notes (optional)
              </div>
              <DictateButton
                size="md"
                borderColor={C.line}
                inkSoft={C.inkSoft}
                panelBg={C.panel}
                alertColor={C.alert}
                onAppend={(chunk) =>
                  setNotes((prev) => appendDictated(prev, chunk))
                }
              />
            </div>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className="w-full rounded-md border px-2.5 py-1.5"
              style={{ borderColor: C.line, background: C.bg }}
              maxLength={4000}
            />
          </div>
          <div className="text-[11px]" style={{ color: C.inkSoft }}>
            Tag specific players and rate confidence inside the case file.
          </div>
          {error && (
            <div
              className="rounded-md border px-2.5 py-1.5 text-[12px]"
              style={{ borderColor: C.alert, color: C.alert, background: "#FEF2F2" }}
            >
              {error}
            </div>
          )}
        </div>

        <div
          className="flex items-center justify-end gap-2 border-t px-4 py-3"
          style={{ borderColor: C.line, background: C.bg }}
        >
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border px-3 py-1.5 text-[12px] font-semibold"
            style={{ borderColor: C.line, color: C.ink, background: C.panel }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || !label.trim() || !start}
            className="rounded-md px-3 py-1.5 text-[12px] font-bold disabled:opacity-50"
            style={{ background: C.brand, color: "#FFFFFF" }}
          >
            {saving ? "Saving…" : "Log clip"}
          </button>
        </div>
      </div>
    </div>
  );
}
