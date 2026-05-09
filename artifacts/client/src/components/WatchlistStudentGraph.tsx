import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Search, X, ChevronRight, Users } from "lucide-react";
import { authFetch } from "../lib/authToken";
import {
  ROLE_META,
  WL_COLORS as C,
  severityChipStyle,
  statusPillStyle,
  type Role,
} from "./watchlist/colors";

interface SearchHit {
  studentId: string;
  firstName: string;
  lastName: string;
  grade: string | null;
}

interface EgoStudent {
  studentId: string;
  firstName: string;
  lastName: string;
  grade: string | null;
}

interface EgoPlayer extends EgoStudent {
  primaryRole: string;
  isCenter: boolean;
}

interface EgoIncidentParticipant {
  studentId: string;
  firstName: string;
  lastName: string;
  role: string;
  notes: string | null;
}

interface EgoIncident {
  id: number;
  occurredAt: string;
  occurredDate: string;
  kind: string;
  severity: number;
  location: string;
  summary: string;
  detail: string;
  loggedByName: string;
  participants: EgoIncidentParticipant[];
}

interface EgoNote {
  id: number;
  body: string;
  authorName: string;
  createdAt: string;
}

interface EgoCase {
  id: number;
  caseNumber: number;
  title: string;
  status: string;
  leadStaffName: string | null;
  summary: string;
  openedAt: string;
  players: EgoPlayer[];
  incidents: EgoIncident[];
  notes: EgoNote[];
}

interface EgoResp {
  center: EgoStudent;
  cases: EgoCase[];
  truncated?: boolean;
  maxCases?: number;
}

// Per-case visible-player cap to keep the SVG readable. Players beyond
// this are summarized as a "+N" overflow chip in the side panel.
const MAX_PLAYERS_PER_CASE = 6;

interface Props {
  initialStudentId?: string | null;
  onBack?: () => void;
  onOpenCase?: (caseId: number) => void;
}

// Layout constants. Center sphere lives at (CX, CY). Cases are placed on
// a ring of radius CASE_R, evenly spaced. Each case has its own little
// sub-ring of player spheres around it.
const SVG_W = 1100;
const SVG_H = 720;
const CX = SVG_W / 2;
const CY = SVG_H / 2 + 10;
const CASE_R = 250;
const PLAYER_R = 88;
const CENTER_RADIUS = 64;
const CASE_RADIUS = 40;
const PLAYER_RADIUS = 24;

function initials(first: string, last: string): string {
  return `${(first[0] ?? "").toUpperCase()}${(last[0] ?? "").toUpperCase()}`;
}

function roleColor(role: string): string {
  const meta = ROLE_META[role as Role];
  return meta?.color ?? C.inkSoft;
}

function roleSoft(role: string): string {
  const meta = ROLE_META[role as Role];
  return meta?.soft ?? C.brandSoft;
}

// Darken a #RRGGBB hex by `amt` (0..1). Used for the rim of the radial
// gradient so each sphere reads as a lit 3D ball, not a flat disc.
function darken(hex: string, amt = 0.4): string {
  const m = (hex || "").replace("#", "");
  if (m.length !== 3 && m.length !== 6) return hex;
  const full = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  const f = (n: number) => Math.max(0, Math.min(255, Math.round(n * (1 - amt))));
  return `#${[f(r), f(g), f(b)]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("")}`;
}

// Render a "3D" sphere: drop shadow + radial gradient (highlight → base
// → darkened rim) + a small specular highlight ellipse near the top.
interface SphereProps {
  cx: number;
  cy: number;
  r: number;
  base: string;
  gradId: string;
  selected?: boolean;
  selectedRing?: string;
}
function Sphere({ cx, cy, r, base, gradId, selected, selectedRing }: SphereProps) {
  return (
    <g filter="url(#sphereShadow)">
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill={`url(#${gradId})`}
        stroke={selected ? selectedRing ?? "#FFFFFF" : "rgba(255,255,255,0.85)"}
        strokeWidth={selected ? 3.5 : 1.5}
      />
      <ellipse
        cx={cx - r * 0.32}
        cy={cy - r * 0.42}
        rx={r * 0.48}
        ry={r * 0.22}
        fill="#FFFFFF"
        opacity={0.55}
        pointerEvents="none"
      />
    </g>
  );
}

interface SphereDefsProps {
  id: string;
  base: string;
}
function SphereGradient({ id, base }: SphereDefsProps) {
  return (
    <radialGradient id={id} cx="35%" cy="30%" r="75%">
      <stop offset="0%" stopColor="#FFFFFF" stopOpacity={0.55} />
      <stop offset="35%" stopColor={base} stopOpacity={1} />
      <stop offset="100%" stopColor={darken(base, 0.45)} stopOpacity={1} />
    </radialGradient>
  );
}

export default function WatchlistStudentGraph({
  initialStudentId,
  onBack,
  onOpenCase,
}: Props) {
  // ----------------- typeahead search -----------------
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [showHits, setShowHits] = useState(false);
  const debounceRef = useRef<number | null>(null);

  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    if (query.trim().length < 2) {
      setHits([]);
      return;
    }
    const ac = new AbortController();
    debounceRef.current = window.setTimeout(async () => {
      setSearching(true);
      try {
        const r = await authFetch(
          `/api/student-finder/search?q=${encodeURIComponent(query.trim())}`,
          { signal: ac.signal },
        );
        if (r.ok) {
          const j = (await r.json()) as { students: SearchHit[] };
          if (!ac.signal.aborted) {
            setHits(j.students ?? []);
            setShowHits(true);
          }
        }
      } catch {
        // aborted or transient — ignore
      } finally {
        if (!ac.signal.aborted) setSearching(false);
      }
    }, 220);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
      ac.abort();
    };
  }, [query]);

  // ----------------- ego graph fetch -----------------
  const [centerStudentId, setCenterStudentId] = useState<string | null>(
    initialStudentId ?? null,
  );
  const [data, setData] = useState<EgoResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selectedCaseId, setSelectedCaseId] = useState<number | null>(null);
  const [openIncidentIds, setOpenIncidentIds] = useState<Set<number>>(
    new Set(),
  );
  // Peek state: clicking a peripheral student sphere opens a small modal
  // with their role + the specific incidents in this case where they
  // appeared. Closing the modal returns the user to the same web with
  // the same center — drill-down, not navigation.
  const [peek, setPeek] = useState<{
    caseId: number;
    studentId: string;
  } | null>(null);

  // Close peek on Escape.
  useEffect(() => {
    if (!peek) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPeek(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [peek]);

  // AbortController for the in-flight ego fetch — prevents a slow earlier
  // request from clobbering the UI after the user re-centers on someone
  // else.
  const egoAbortRef = useRef<AbortController | null>(null);

  const loadEgo = useCallback(async (studentId: string) => {
    egoAbortRef.current?.abort();
    const ac = new AbortController();
    egoAbortRef.current = ac;
    setLoading(true);
    setErr(null);
    try {
      const r = await authFetch(
        `/api/watchlist/network/student/${encodeURIComponent(studentId)}`,
        { signal: ac.signal },
      );
      if (ac.signal.aborted) return;
      if (!r.ok) {
        setErr(`Failed to load (${r.status})`);
        setData(null);
        return;
      }
      const j = (await r.json()) as EgoResp;
      if (ac.signal.aborted) return;
      setData(j);
      setSelectedCaseId(j.cases[0]?.id ?? null);
      setOpenIncidentIds(new Set());
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return;
      setErr("Network error");
      setData(null);
    } finally {
      if (!ac.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (centerStudentId) void loadEgo(centerStudentId);
    return () => egoAbortRef.current?.abort();
  }, [centerStudentId, loadEgo]);

  const pickStudent = (s: SearchHit) => {
    setCenterStudentId(s.studentId);
    setQuery(`${s.firstName} ${s.lastName}`);
    setShowHits(false);
  };

  // ----------------- layout -----------------
  const positioned = useMemo(() => {
    if (!data) return [];
    const n = data.cases.length;
    return data.cases.map((c, i) => {
      const angle = (i / Math.max(1, n)) * Math.PI * 2 - Math.PI / 2;
      const cx = CX + Math.cos(angle) * CASE_R;
      const cy = CY + Math.sin(angle) * CASE_R;
      // peripheral players around this case (exclude the center student).
      // Cap visible nodes so dense cases stay readable; overflow count is
      // shown in the side panel.
      const allOthers = c.players.filter((p) => !p.isCenter);
      const others = allOthers.slice(0, MAX_PLAYERS_PER_CASE);
      const overflow = allOthers.length - others.length;
      const m = others.length;
      const players = others.map((p, j) => {
        // Spread player nodes only on the outer half of each case node so
        // they don't crash into the center.
        const baseAngle = angle;
        const spread = Math.PI; // 180° fan facing away from center
        const t = m === 1 ? 0 : j / (m - 1);
        const pa = baseAngle - spread / 2 + spread * t;
        return {
          ...p,
          x: cx + Math.cos(pa) * PLAYER_R,
          y: cy + Math.sin(pa) * PLAYER_R,
          angle: pa,
        };
      });
      return { ...c, x: cx, y: cy, players, overflow };
    });
  }, [data]);

  const selectedCase = data?.cases.find((c) => c.id === selectedCaseId) ?? null;

  // ----------------- render -----------------
  return (
    <div className="min-h-screen" style={{ background: C.bg, color: C.ink }}>
      <div className="mx-auto max-w-[1320px] px-8 py-8">
        {/* Header */}
        <div className="flex flex-wrap items-end justify-between gap-4 pb-6">
          <div className="min-w-0 flex-1">
            {onBack && (
              <button
                type="button"
                onClick={onBack}
                className="inline-flex items-center gap-1 text-[11px] font-semibold"
                style={{ color: C.brand }}
              >
                <ArrowLeft className="h-3 w-3" />
                Back to Hub
              </button>
            )}
            <h1 className="mt-2 text-3xl font-bold tracking-tight">
              Student Spider
            </h1>
            <p className="mt-1 max-w-2xl text-sm" style={{ color: C.inkSoft }}>
              Search a name to see every case that student is tied to. Click a
              case sphere to drill into the incidents and notes; click a
              connected student to re-center the web on them.
            </p>
          </div>
        </div>

        {/* Search bar */}
        <div className="relative mb-6 max-w-xl">
          <div
            className="flex items-center gap-2 rounded-md border px-3 py-2"
            style={{ borderColor: C.line, background: C.panel }}
          >
            <Search className="h-4 w-4" style={{ color: C.inkSoft }} />
            <input
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setShowHits(true);
              }}
              onFocus={() => setShowHits(true)}
              placeholder="Type a name or student ID…"
              className="flex-1 bg-transparent text-sm outline-none"
              style={{ color: C.ink }}
            />
            {query && (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  setHits([]);
                  setShowHits(false);
                }}
                className="rounded p-0.5"
                style={{ color: C.inkSoft }}
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          {showHits && hits.length > 0 && (
            <div
              className="absolute left-0 right-0 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-md border shadow-lg"
              style={{ borderColor: C.line, background: C.panel }}
            >
              {hits.map((h) => (
                <button
                  key={h.studentId}
                  type="button"
                  onClick={() => pickStudent(h)}
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-gray-50"
                >
                  <span className="font-semibold">
                    {h.firstName} {h.lastName}
                  </span>
                  <span
                    className="text-[11px]"
                    style={{ color: C.inkSoft }}
                  >
                    {h.grade ? `Gr ${h.grade} · ` : ""}
                    {h.studentId}
                  </span>
                </button>
              ))}
            </div>
          )}
          {showHits && query.trim().length >= 2 && !searching && hits.length === 0 && (
            <div
              className="absolute left-0 right-0 top-full z-20 mt-1 rounded-md border px-3 py-2 text-sm shadow-lg"
              style={{ borderColor: C.line, background: C.panel, color: C.inkSoft }}
            >
              No students match "{query.trim()}".
            </div>
          )}
        </div>

        {/* Body */}
        {!centerStudentId && (
          <div
            className="rounded-md border p-12 text-center"
            style={{ borderColor: C.line, background: C.panel }}
          >
            <Users
              className="mx-auto h-10 w-10"
              style={{ color: C.inkSoft }}
            />
            <p className="mt-3 text-sm font-semibold">
              Search a student to spin up their case web.
            </p>
            <p className="mt-1 text-xs" style={{ color: C.inkSoft }}>
              Each case the student touches becomes its own sphere with the
              other involved players orbiting it.
            </p>
          </div>
        )}

        {centerStudentId && loading && (
          <div
            className="rounded-md border p-8 text-center text-sm"
            style={{ borderColor: C.line, background: C.panel, color: C.inkSoft }}
          >
            Loading…
          </div>
        )}

        {centerStudentId && err && (
          <div
            className="rounded-md border p-4 text-sm"
            style={{
              borderColor: "#FCA5A5",
              background: "#FEF2F2",
              color: "#991B1B",
            }}
          >
            {err}
          </div>
        )}

        {centerStudentId && !loading && data && data.cases.length === 0 && (
          <div
            className="rounded-md border p-8 text-center"
            style={{ borderColor: C.line, background: C.panel }}
          >
            <p className="text-sm font-semibold">
              {data.center.firstName} {data.center.lastName} isn't tied to any
              cases yet.
            </p>
            <p className="mt-1 text-xs" style={{ color: C.inkSoft }}>
              Once they appear on an interaction that's linked to a case, the
              web will populate.
            </p>
          </div>
        )}

        {centerStudentId && !loading && data && data.cases.length > 0 && (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr,360px]">
            {/* SVG graph */}
            <div
              className="rounded-md border"
              style={{ borderColor: C.line, background: C.panel }}
            >
              {data.truncated && (
                <div
                  className="border-b px-3 py-2 text-xs"
                  style={{
                    borderColor: C.line,
                    background: C.brandSoft,
                    color: C.brand,
                  }}
                >
                  Showing the {data.cases.length} most recent cases for this
                  student. There are more — open the full case to see them.
                </div>
              )}
              <svg
                viewBox={`0 0 ${SVG_W} ${SVG_H}`}
                className="h-auto w-full"
                preserveAspectRatio="xMidYMid meet"
              >
                <defs>
                  <filter
                    id="sphereShadow"
                    x="-30%"
                    y="-30%"
                    width="160%"
                    height="160%"
                  >
                    <feDropShadow
                      dx="0"
                      dy="3"
                      stdDeviation="3"
                      floodColor="#000000"
                      floodOpacity="0.28"
                    />
                  </filter>
                  <SphereGradient id="grad-center" base={C.brand} />
                  {positioned.map((c) => (
                    <SphereGradient
                      key={`gc-${c.id}`}
                      id={`grad-case-${c.id}`}
                      base={statusPillStyle(c.status).bg}
                    />
                  ))}
                  {positioned.flatMap((c) =>
                    c.players.map((p) => (
                      <SphereGradient
                        key={`gp-${c.id}-${p.studentId}`}
                        id={`grad-player-${c.id}-${p.studentId}`}
                        base={roleSoft(p.primaryRole)}
                      />
                    )),
                  )}
                </defs>
                {/* edges: center -> each case */}
                {positioned.map((c) => {
                  const isSel = c.id === selectedCaseId;
                  return (
                    <line
                      key={`e-c-${c.id}`}
                      x1={CX}
                      y1={CY}
                      x2={c.x}
                      y2={c.y}
                      stroke={isSel ? C.brand : C.line}
                      strokeWidth={isSel ? 2.5 : 1.5}
                    />
                  );
                })}
                {/* edges: case -> each peripheral player */}
                {positioned.map((c) =>
                  c.players.map((p) => (
                    <line
                      key={`e-p-${c.id}-${p.studentId}`}
                      x1={c.x}
                      y1={c.y}
                      x2={p.x}
                      y2={p.y}
                      stroke={C.line}
                      strokeWidth={1}
                    />
                  )),
                )}

                {/* center student sphere */}
                <g>
                  <Sphere
                    cx={CX}
                    cy={CY}
                    r={CENTER_RADIUS}
                    base={C.brand}
                    gradId="grad-center"
                  />
                  <text
                    x={CX}
                    y={CY - 4}
                    textAnchor="middle"
                    fontSize={20}
                    fontWeight={800}
                    fill="#FFFFFF"
                  >
                    {initials(data.center.firstName, data.center.lastName)}
                  </text>
                  <text
                    x={CX}
                    y={CY + 16}
                    textAnchor="middle"
                    fontSize={10}
                    fontWeight={600}
                    fill="#FFFFFF"
                    opacity={0.85}
                  >
                    {data.center.grade ? `Grade ${data.center.grade}` : ""}
                  </text>
                  <text
                    x={CX}
                    y={CY + CENTER_RADIUS + 18}
                    textAnchor="middle"
                    fontSize={13}
                    fontWeight={700}
                    fill={C.ink}
                  >
                    {data.center.firstName} {data.center.lastName}
                  </text>
                </g>

                {/* case spheres */}
                {positioned.map((c) => {
                  const sp = statusPillStyle(c.status);
                  const isSel = c.id === selectedCaseId;
                  return (
                    <g
                      key={`case-${c.id}`}
                      style={{ cursor: "pointer" }}
                      onClick={() => onOpenCase?.(c.id)}
                      onMouseEnter={() => setSelectedCaseId(c.id)}
                    >
                      <title>
                        Open Case #{c.caseNumber} — {c.title}
                      </title>
                      <Sphere
                        cx={c.x}
                        cy={c.y}
                        r={CASE_RADIUS}
                        base={sp.bg}
                        gradId={`grad-case-${c.id}`}
                        selected={isSel}
                        selectedRing={C.brand}
                      />
                      <text
                        x={c.x}
                        y={c.y - 2}
                        textAnchor="middle"
                        fontSize={11}
                        fontWeight={700}
                        fill={sp.fg}
                        opacity={0.85}
                        pointerEvents="none"
                      >
                        CASE
                      </text>
                      <text
                        x={c.x}
                        y={c.y + 14}
                        textAnchor="middle"
                        fontSize={18}
                        fontWeight={800}
                        fill={sp.fg}
                      >
                        #{c.caseNumber}
                      </text>
                    </g>
                  );
                })}

                {/* peripheral player spheres */}
                {positioned.map((c) =>
                  c.players.map((p) => {
                    const ring = roleColor(p.primaryRole);
                    return (
                      <g
                        key={`p-${c.id}-${p.studentId}`}
                        style={{ cursor: "pointer" }}
                        onClick={(e) => {
                          e.stopPropagation();
                          // Drill-down: peek this player's incidents on
                          // this case without losing the current center.
                          setSelectedCaseId(c.id);
                          setPeek({ caseId: c.id, studentId: p.studentId });
                        }}
                      >
                        <title>
                          Read {p.firstName} {p.lastName}'s incidents on Case #{c.caseNumber}
                        </title>
                        <Sphere
                          cx={p.x}
                          cy={p.y}
                          r={PLAYER_RADIUS}
                          base={roleSoft(p.primaryRole)}
                          gradId={`grad-player-${c.id}-${p.studentId}`}
                        />
                        <text
                          x={p.x}
                          y={p.y + 4}
                          textAnchor="middle"
                          fontSize={11}
                          fontWeight={700}
                          fill={ring}
                          pointerEvents="none"
                        >
                          {initials(p.firstName, p.lastName)}
                        </text>
                        <text
                          x={p.x}
                          y={p.y + PLAYER_RADIUS + 12}
                          textAnchor="middle"
                          fontSize={10}
                          fontWeight={600}
                          fill={C.ink}
                          pointerEvents="none"
                        >
                          {p.firstName} {p.lastName[0]}.
                        </text>
                      </g>
                    );
                  }),
                )}
              </svg>
            </div>

            {/* Side panel for selected case */}
            <div
              className="rounded-md border p-4"
              style={{ borderColor: C.line, background: C.panel }}
            >
              {!selectedCase && (
                <p className="text-sm" style={{ color: C.inkSoft }}>
                  Click a case sphere to see its incidents and notes.
                </p>
              )}
              {selectedCase && (
                <CasePanel
                  caseRow={selectedCase}
                  openIncidentIds={openIncidentIds}
                  toggleIncident={(id) => {
                    setOpenIncidentIds((prev) => {
                      const next = new Set(prev);
                      if (next.has(id)) next.delete(id);
                      else next.add(id);
                      return next;
                    });
                  }}
                  onOpenCase={onOpenCase}
                />
              )}
            </div>
          </div>
        )}
      </div>

      {/* Peripheral-player peek modal */}
      {peek && data && (() => {
        const peekCase = data.cases.find((c) => c.id === peek.caseId);
        const peekPlayer = peekCase?.players.find(
          (p) => p.studentId === peek.studentId,
        );
        if (!peekCase || !peekPlayer) return null;
        const peekIncidents = peekCase.incidents.filter((i) =>
          i.participants.some((pp) => pp.studentId === peek.studentId),
        );
        const ring = roleColor(peekPlayer.primaryRole);
        const soft = roleSoft(peekPlayer.primaryRole);
        return (
          <div
            className="fixed inset-0 z-30 flex items-center justify-center px-4"
            style={{ background: "rgba(0,0,0,0.45)" }}
            onClick={() => setPeek(null)}
          >
            <div
              className="max-h-[80vh] w-full max-w-lg overflow-hidden rounded-lg shadow-xl"
              style={{ background: C.panel }}
              onClick={(e) => e.stopPropagation()}
            >
              <div
                className="flex items-start justify-between gap-3 border-b px-4 py-3"
                style={{ borderColor: C.line }}
              >
                <div className="min-w-0 flex-1">
                  <div
                    className="text-[11px] font-semibold uppercase tracking-wider"
                    style={{ color: C.inkSoft }}
                  >
                    Peek · Case #{peekCase.caseNumber}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2">
                    <span className="text-base font-bold">
                      {peekPlayer.firstName} {peekPlayer.lastName}
                    </span>
                    <span
                      className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                      style={{ background: soft, color: ring }}
                    >
                      {peekPlayer.primaryRole}
                    </span>
                    {peekPlayer.grade && (
                      <span
                        className="text-[11px]"
                        style={{ color: C.inkSoft }}
                      >
                        Gr {peekPlayer.grade}
                      </span>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setPeek(null)}
                  className="rounded p-1"
                  style={{ color: C.inkSoft }}
                  aria-label="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="max-h-[55vh] overflow-y-auto px-4 py-3">
                <div
                  className="text-[11px] font-semibold uppercase tracking-wider"
                  style={{ color: C.inkSoft }}
                >
                  Incidents on this case ({peekIncidents.length})
                </div>
                {peekIncidents.length === 0 && (
                  <p
                    className="mt-2 text-xs"
                    style={{ color: C.inkSoft }}
                  >
                    No specific incidents found for this player on this case.
                  </p>
                )}
                <div className="mt-2 space-y-2">
                  {peekIncidents.map((i) => {
                    const sev = severityChipStyle(i.severity);
                    const myPart = i.participants.find(
                      (pp) => pp.studentId === peek.studentId,
                    );
                    return (
                      <div
                        key={i.id}
                        className="rounded-md border p-2"
                        style={{ borderColor: C.line, background: C.bg }}
                      >
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span
                            className="text-[10px] font-semibold uppercase tracking-wider"
                            style={{ color: C.inkSoft }}
                          >
                            {new Date(i.occurredAt).toLocaleDateString()}
                          </span>
                          <span className="text-xs font-semibold">
                            {i.kind}
                          </span>
                          <span
                            className="rounded-full px-1.5 py-0.5 text-[10px] font-bold"
                            style={{ background: sev.bg, color: sev.fg }}
                          >
                            {sev.label}
                          </span>
                          {myPart && (
                            <span
                              className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                              style={{
                                background: roleSoft(myPart.role),
                                color: roleColor(myPart.role),
                              }}
                            >
                              role: {myPart.role}
                            </span>
                          )}
                        </div>
                        <p className="mt-1 text-xs">{i.summary}</p>
                        {i.location && (
                          <div
                            className="mt-1 text-[11px]"
                            style={{ color: C.inkSoft }}
                          >
                            Location: {i.location}
                          </div>
                        )}
                        {i.detail && (
                          <p className="mt-1 whitespace-pre-wrap text-[11px]">
                            {i.detail}
                          </p>
                        )}
                        {myPart?.notes && (
                          <div
                            className="mt-1 rounded px-2 py-1 text-[11px] italic"
                            style={{ background: soft, color: ring }}
                          >
                            “{myPart.notes}”
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div
                className="flex items-center justify-between gap-2 border-t px-4 py-3"
                style={{ borderColor: C.line, background: C.bg }}
              >
                <button
                  type="button"
                  onClick={() => {
                    const sid = peek.studentId;
                    const fn = peekPlayer.firstName;
                    const ln = peekPlayer.lastName;
                    setPeek(null);
                    setCenterStudentId(sid);
                    setQuery(`${fn} ${ln}`);
                    setShowHits(false);
                  }}
                  className="rounded-md border px-2.5 py-1 text-[11px] font-semibold"
                  style={{ borderColor: C.line, color: C.ink }}
                >
                  Re-center spider on this student
                </button>
                <button
                  type="button"
                  onClick={() => setPeek(null)}
                  className="rounded-md px-2.5 py-1 text-[11px] font-bold"
                  style={{ background: C.ink, color: "#FFFFFF" }}
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

function CasePanel({
  caseRow,
  openIncidentIds,
  toggleIncident,
  onOpenCase,
}: {
  caseRow: EgoCase;
  openIncidentIds: Set<number>;
  toggleIncident: (id: number) => void;
  onOpenCase?: (caseId: number) => void;
}) {
  const sp = statusPillStyle(caseRow.status);
  return (
    <div>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div
            className="text-[11px] font-semibold uppercase tracking-wider"
            style={{ color: C.inkSoft }}
          >
            Case #{caseRow.caseNumber}
          </div>
          <div className="mt-0.5 text-base font-bold">{caseRow.title}</div>
          {caseRow.leadStaffName && (
            <div className="mt-0.5 text-[11px]" style={{ color: C.inkSoft }}>
              Lead: {caseRow.leadStaffName}
            </div>
          )}
        </div>
        <span
          className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold"
          style={{ background: sp.bg, color: sp.fg }}
        >
          {sp.label}
        </span>
      </div>

      {caseRow.summary && (
        <p
          className="mt-2 text-xs"
          style={{ color: C.inkSoft }}
        >
          {caseRow.summary}
        </p>
      )}

      {onOpenCase && (
        <button
          type="button"
          onClick={() => onOpenCase(caseRow.id)}
          className="mt-3 inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-bold"
          style={{ background: C.brand, color: "#FFFFFF" }}
        >
          Open full case
          <ChevronRight className="h-3 w-3" />
        </button>
      )}

      {/* Players */}
      <div
        className="mt-4 border-t pt-3"
        style={{ borderColor: C.line }}
      >
        <div
          className="text-[11px] font-semibold uppercase tracking-wider"
          style={{ color: C.inkSoft }}
        >
          Players ({caseRow.players.length})
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {caseRow.players.map((p) => {
            const ring = roleColor(p.primaryRole);
            const soft = roleSoft(p.primaryRole);
            return (
              <span
                key={p.studentId}
                className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold"
                style={{
                  background: soft,
                  color: ring,
                  border: p.isCenter ? `1.5px solid ${C.brand}` : "none",
                }}
                title={p.primaryRole}
              >
                {p.firstName} {p.lastName}
                {p.isCenter && (
                  <span
                    className="rounded-full px-1 text-[9px] font-bold"
                    style={{ background: C.brand, color: "#FFFFFF" }}
                  >
                    YOU
                  </span>
                )}
              </span>
            );
          })}
        </div>
      </div>

      {/* Incidents */}
      <div
        className="mt-4 border-t pt-3"
        style={{ borderColor: C.line }}
      >
        <div
          className="text-[11px] font-semibold uppercase tracking-wider"
          style={{ color: C.inkSoft }}
        >
          Incidents ({caseRow.incidents.length})
        </div>
        <div className="mt-2 space-y-1.5">
          {caseRow.incidents.length === 0 && (
            <p className="text-xs" style={{ color: C.inkSoft }}>
              No incidents linked yet.
            </p>
          )}
          {caseRow.incidents.map((i) => {
            const sev = severityChipStyle(i.severity);
            const open = openIncidentIds.has(i.id);
            return (
              <div
                key={i.id}
                className="rounded-md border"
                style={{ borderColor: C.line, background: C.bg }}
              >
                <button
                  type="button"
                  onClick={() => toggleIncident(i.id)}
                  className="flex w-full items-start justify-between gap-2 px-2.5 py-2 text-left"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        className="text-[10px] font-semibold uppercase tracking-wider"
                        style={{ color: C.inkSoft }}
                      >
                        {new Date(i.occurredAt).toLocaleDateString()}
                      </span>
                      <span className="text-xs font-semibold">{i.kind}</span>
                      <span
                        className="rounded-full px-1.5 py-0.5 text-[10px] font-bold"
                        style={{ background: sev.bg, color: sev.fg }}
                      >
                        {sev.label}
                      </span>
                    </div>
                    <p className="mt-1 text-xs">{i.summary}</p>
                  </div>
                  <ChevronRight
                    className="h-4 w-4 shrink-0 transition-transform"
                    style={{
                      color: C.inkSoft,
                      transform: open ? "rotate(90deg)" : "none",
                    }}
                  />
                </button>
                {open && (
                  <div
                    className="border-t px-2.5 py-2 text-xs"
                    style={{ borderColor: C.line }}
                  >
                    {i.location && (
                      <div className="mb-1">
                        <span
                          className="font-semibold"
                          style={{ color: C.inkSoft }}
                        >
                          Location:{" "}
                        </span>
                        {i.location}
                      </div>
                    )}
                    {i.detail && (
                      <p className="mb-2 whitespace-pre-wrap">{i.detail}</p>
                    )}
                    {i.participants.length > 0 && (
                      <div className="mb-1">
                        <span
                          className="font-semibold"
                          style={{ color: C.inkSoft }}
                        >
                          Players:{" "}
                        </span>
                        {i.participants.map((p, idx) => (
                          <span key={p.studentId}>
                            {idx > 0 ? ", " : ""}
                            {p.firstName} {p.lastName}{" "}
                            <span
                              className="text-[10px]"
                              style={{ color: roleColor(p.role) }}
                            >
                              ({p.role})
                            </span>
                          </span>
                        ))}
                      </div>
                    )}
                    {i.loggedByName && (
                      <div
                        className="mt-1 text-[10px]"
                        style={{ color: C.inkSoft }}
                      >
                        Logged by {i.loggedByName}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Notes */}
      <div
        className="mt-4 border-t pt-3"
        style={{ borderColor: C.line }}
      >
        <div
          className="text-[11px] font-semibold uppercase tracking-wider"
          style={{ color: C.inkSoft }}
        >
          Case notes ({caseRow.notes.length})
        </div>
        <div className="mt-2 space-y-2">
          {caseRow.notes.length === 0 && (
            <p className="text-xs" style={{ color: C.inkSoft }}>
              No notes yet.
            </p>
          )}
          {caseRow.notes.map((n) => (
            <div
              key={n.id}
              className="rounded-md border p-2"
              style={{ borderColor: C.line, background: C.bg }}
            >
              <div
                className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider"
                style={{ color: C.inkSoft }}
              >
                <span>{n.authorName || "Staff"}</span>
                <span>{new Date(n.createdAt).toLocaleDateString()}</span>
              </div>
              <p className="mt-1 whitespace-pre-wrap text-xs">{n.body}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
