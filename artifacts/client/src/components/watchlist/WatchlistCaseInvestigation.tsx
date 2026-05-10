import { useEffect, useMemo, useState } from "react";
import { authFetch } from "../../lib/authToken";
import { WL_COLORS as C } from "./colors";

// Investigation Ring — per-incident witness graph. Anchor = the
// incident card in the centre. Three concentric rings around it:
//   - Principals (target/instigator) — red ring closest in.
//   - Witnesses (students with statements on this incident) — amber.
//   - Mentioned-but-silent (named in a statement but no statement of
//     their own) — slate-gray, dashed outline.
// Edges:
//   - Solid line: confirmed @-mention from a witness statement.
//   - Green line: AI consistency-check corroboration between two
//     statements on this incident.
//   - Red dashed: AI contradiction between two statements.

interface Incident {
  id: number;
  kind: string;
  severity: number;
  occurredAt: string;
  location: string;
  summary: string;
  detail: string;
}

interface PrincipalNode {
  studentId: string;
  firstName: string;
  lastName: string;
  initials: string;
  grade: number | string | null;
  roles: string[];
}

interface WitnessNode {
  statementId: number;
  studentId: string;
  displayName: string;
  initials: string;
  grade: number | string | null;
  status: string;
  body: string;
  requestedAt: string;
  completedAt: string | null;
  requestedByName: string | null;
}

interface MentionedNode {
  studentId: string;
  firstName: string;
  lastName: string;
  initials: string;
  grade: number | string | null;
  mentionedInStatementIds: number[];
}

interface MentionEdge {
  kind: "mention";
  fromStudentId: string;
  fromStatementId: number;
  toStudentId: string;
  weight: number;
}
interface ConsistencyEdge {
  kind: "corroborates" | "contradicts";
  aStatementId: number;
  bStatementId: number;
  findingId: number;
  severity: string;
}

interface Bundle {
  incident: Incident;
  principals: PrincipalNode[];
  witnesses: WitnessNode[];
  mentionedOnly: MentionedNode[];
  edges: { mentions: MentionEdge[]; consistency: ConsistencyEdge[] };
}

interface Props {
  caseId: number;
  incidents: Array<{ id: number; summary: string; occurredAt: string }>;
  onRequestStatement?: (studentId: string, incidentId: number) => void;
  // Opens the global Student Finder modal pre-populated with `q`.
  // Wired from App.tsx through WatchlistCaseDetail. Surfaces as the
  // "Open in Student Finder" button on the right-rail when a witness
  // or mentioned-only sphere is selected.
  onOpenStudentFinder?: (q: string) => void;
}

const W = 760;
const H = 560;
const CX = W / 2;
const CY = H / 2;
const R_PRINCIPAL = 110;
const R_WITNESS = 200;
const R_MENTIONED = 270;

function nodePos(idx: number, count: number, radius: number) {
  if (count === 0) return { x: CX, y: CY };
  const angle = (idx / count) * Math.PI * 2 - Math.PI / 2;
  return { x: CX + Math.cos(angle) * radius, y: CY + Math.sin(angle) * radius };
}

export default function WatchlistCaseInvestigation({
  caseId,
  incidents,
  onRequestStatement,
  onOpenStudentFinder,
}: Props) {
  const [incidentId, setIncidentId] = useState<number | null>(
    incidents[0]?.id ?? null,
  );
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedStatementId, setSelectedStatementId] = useState<number | null>(
    null,
  );
  const [selectedMentionedId, setSelectedMentionedId] = useState<string | null>(
    null,
  );

  useEffect(() => {
    if (!incidentId) {
      setBundle(null);
      return;
    }
    setLoading(true);
    void (async () => {
      try {
        const r = await authFetch(
          `/api/watchlist/cases/${caseId}/investigation/${incidentId}`,
        );
        if (!r.ok) {
          setBundle(null);
          return;
        }
        const j = (await r.json()) as Bundle;
        setBundle(j);
        setSelectedStatementId(null);
        setSelectedMentionedId(null);
      } finally {
        setLoading(false);
      }
    })();
  }, [caseId, incidentId]);

  // Position lookup: studentId or witnessStatementId → (x, y).
  const layout = useMemo(() => {
    if (!bundle) return null;
    const pos = new Map<string, { x: number; y: number }>();
    bundle.principals.forEach((p, i) => {
      pos.set(`student:${p.studentId}`, nodePos(i, bundle.principals.length, R_PRINCIPAL));
    });
    bundle.witnesses.forEach((w, i) => {
      const p = nodePos(i, bundle.witnesses.length, R_WITNESS);
      pos.set(`student:${w.studentId}`, p);
      pos.set(`statement:${w.statementId}`, p);
    });
    bundle.mentionedOnly.forEach((m, i) => {
      pos.set(`student:${m.studentId}`, nodePos(i, bundle.mentionedOnly.length, R_MENTIONED));
    });
    return pos;
  }, [bundle]);

  const selectedStatement = bundle?.witnesses.find(
    (w) => w.statementId === selectedStatementId,
  );
  const selectedMentioned = bundle?.mentionedOnly.find(
    (m) => m.studentId === selectedMentionedId,
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <label
          className="text-[11px] font-semibold uppercase tracking-wider"
          style={{ color: C.inkSoft }}
        >
          Incident
        </label>
        <select
          value={incidentId ?? ""}
          onChange={(e) => setIncidentId(Number(e.target.value) || null)}
          className="rounded-md border px-2.5 py-1 text-xs"
          style={{ borderColor: C.line, background: C.panel, color: C.ink }}
        >
          {incidents.length === 0 && <option>(no incidents on case)</option>}
          {incidents.map((i) => (
            <option key={i.id} value={i.id}>
              {new Date(i.occurredAt).toLocaleDateString()} —{" "}
              {i.summary.slice(0, 60)}
            </option>
          ))}
        </select>
      </div>

      {loading && <div>Loading investigation…</div>}

      {bundle && layout && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
          <div
            className="rounded-xl border"
            style={{ borderColor: C.line, background: C.panel }}
          >
            <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H}>
              {/* Concentric ring guides */}
              {[R_PRINCIPAL, R_WITNESS, R_MENTIONED].map((r) => (
                <circle
                  key={r}
                  cx={CX}
                  cy={CY}
                  r={r}
                  fill="none"
                  stroke={C.line}
                  strokeDasharray="2 4"
                  opacity={0.4}
                />
              ))}

              {/* Edges from confirmed @-mentions */}
              {bundle.edges.mentions.map((e, i) => {
                const a = layout.get(`student:${e.fromStudentId}`);
                const b = layout.get(`student:${e.toStudentId}`);
                if (!a || !b) return null;
                return (
                  <line
                    key={`m${i}`}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke="#5C7CFA"
                    strokeWidth={Math.min(5, 1 + e.weight)}
                    opacity={0.7}
                  />
                );
              })}

              {/* AI consistency edges */}
              {bundle.edges.consistency.map((e, i) => {
                const a = layout.get(`statement:${e.aStatementId}`);
                const b = layout.get(`statement:${e.bStatementId}`);
                if (!a || !b) return null;
                const isContra = e.kind === "contradicts";
                return (
                  <line
                    key={`c${i}`}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke={isContra ? "#9F1D1D" : "#1E6E3A"}
                    strokeWidth={isContra && e.severity === "high" ? 3 : 2}
                    strokeDasharray={isContra ? "6 4" : undefined}
                    opacity={0.85}
                  />
                );
              })}

              {/* Anchor — the incident itself */}
              <g>
                <rect
                  x={CX - 80}
                  y={CY - 36}
                  width={160}
                  height={72}
                  rx={10}
                  fill={C.brand}
                  opacity={0.92}
                />
                <text
                  x={CX}
                  y={CY - 10}
                  textAnchor="middle"
                  fill="#fff"
                  fontSize={11}
                  fontWeight={700}
                >
                  {new Date(bundle.incident.occurredAt).toLocaleDateString()}
                </text>
                <text
                  x={CX}
                  y={CY + 6}
                  textAnchor="middle"
                  fill="#fff"
                  fontSize={11}
                >
                  {bundle.incident.kind} · sev {bundle.incident.severity}
                </text>
                <text
                  x={CX}
                  y={CY + 22}
                  textAnchor="middle"
                  fill="#fff"
                  fontSize={10}
                  opacity={0.85}
                >
                  {bundle.incident.location || "—"}
                </text>
              </g>

              {/* Principals */}
              {bundle.principals.map((p, i) => {
                const { x, y } = nodePos(i, bundle.principals.length, R_PRINCIPAL);
                return (
                  <g key={p.studentId}>
                    <circle cx={x} cy={y} r={26} fill="#9F1D1D" />
                    <text
                      x={x}
                      y={y + 4}
                      textAnchor="middle"
                      fill="#fff"
                      fontSize={12}
                      fontWeight={700}
                    >
                      {p.initials}
                    </text>
                    <text
                      x={x}
                      y={y + 44}
                      textAnchor="middle"
                      fill={C.ink}
                      fontSize={10}
                    >
                      {p.firstName} {p.lastName}
                    </text>
                    <text
                      x={x}
                      y={y + 56}
                      textAnchor="middle"
                      fill={C.inkSoft}
                      fontSize={9}
                    >
                      {p.roles.join(" · ")}
                    </text>
                  </g>
                );
              })}

              {/* Witnesses */}
              {bundle.witnesses.map((w, i) => {
                const { x, y } = nodePos(i, bundle.witnesses.length, R_WITNESS);
                const stale =
                  w.status !== "completed" &&
                  Date.now() - new Date(w.requestedAt).getTime() >
                    7 * 24 * 3600 * 1000;
                const fill =
                  w.status === "completed"
                    ? "#1E6E3A"
                    : stale
                      ? "#A1390B"
                      : "#8A5A00";
                const isSel = selectedStatementId === w.statementId;
                return (
                  <g
                    key={w.statementId}
                    style={{ cursor: "pointer" }}
                    onClick={() => {
                      setSelectedStatementId(w.statementId);
                      setSelectedMentionedId(null);
                    }}
                  >
                    <circle
                      cx={x}
                      cy={y}
                      r={isSel ? 24 : 20}
                      fill={fill}
                      stroke={isSel ? "#fff" : "none"}
                      strokeWidth={isSel ? 3 : 0}
                    />
                    <text
                      x={x}
                      y={y + 4}
                      textAnchor="middle"
                      fill="#fff"
                      fontSize={11}
                      fontWeight={700}
                    >
                      {w.initials}
                    </text>
                    <text
                      x={x}
                      y={y + 38}
                      textAnchor="middle"
                      fill={C.ink}
                      fontSize={10}
                    >
                      {w.displayName}
                    </text>
                  </g>
                );
              })}

              {/* Mentioned-but-silent */}
              {bundle.mentionedOnly.map((m, i) => {
                const { x, y } = nodePos(
                  i,
                  bundle.mentionedOnly.length,
                  R_MENTIONED,
                );
                const isSel = selectedMentionedId === m.studentId;
                return (
                  <g
                    key={m.studentId}
                    style={{ cursor: "pointer" }}
                    onClick={() => {
                      setSelectedMentionedId(m.studentId);
                      setSelectedStatementId(null);
                    }}
                  >
                    <circle
                      cx={x}
                      cy={y}
                      r={isSel ? 20 : 16}
                      fill="#475569"
                      stroke="#94A3B8"
                      strokeDasharray="3 2"
                      strokeWidth={2}
                    />
                    <text
                      x={x}
                      y={y + 4}
                      textAnchor="middle"
                      fill="#fff"
                      fontSize={10}
                      fontWeight={700}
                    >
                      {m.initials}
                    </text>
                    <text
                      x={x}
                      y={y + 32}
                      textAnchor="middle"
                      fill={C.inkSoft}
                      fontSize={9}
                    >
                      {m.firstName} {m.lastName}
                    </text>
                  </g>
                );
              })}
            </svg>
            <div
              className="flex flex-wrap items-center gap-3 border-t px-4 py-2 text-[11px]"
              style={{ borderColor: C.line, color: C.inkSoft }}
            >
              <span>
                <span
                  style={{
                    display: "inline-block",
                    width: 10,
                    height: 10,
                    background: "#9F1D1D",
                    borderRadius: "50%",
                    marginRight: 4,
                  }}
                />
                Principal
              </span>
              <span>
                <span
                  style={{
                    display: "inline-block",
                    width: 10,
                    height: 10,
                    background: "#1E6E3A",
                    borderRadius: "50%",
                    marginRight: 4,
                  }}
                />
                Witness statement
              </span>
              <span>
                <span
                  style={{
                    display: "inline-block",
                    width: 10,
                    height: 10,
                    background: "#475569",
                    borderRadius: "50%",
                    marginRight: 4,
                  }}
                />
                Mentioned-only
              </span>
              <span>
                <span
                  style={{
                    display: "inline-block",
                    width: 18,
                    height: 2,
                    background: "#5C7CFA",
                    marginRight: 4,
                  }}
                />
                @-mention
              </span>
              <span>
                <span
                  style={{
                    display: "inline-block",
                    width: 18,
                    height: 2,
                    background: "#1E6E3A",
                    marginRight: 4,
                  }}
                />
                AI corroborates
              </span>
              <span>
                <span
                  style={{
                    display: "inline-block",
                    width: 18,
                    borderTop: "2px dashed #9F1D1D",
                    marginRight: 4,
                  }}
                />
                AI contradicts
              </span>
            </div>
          </div>

          <div
            className="rounded-xl border p-4"
            style={{ borderColor: C.line, background: C.panel }}
          >
            {selectedStatement ? (
              <>
                <h3 className="text-sm font-bold">
                  Statement — {selectedStatement.displayName}
                </h3>
                <div
                  className="mt-1 text-[11px]"
                  style={{ color: C.inkSoft }}
                >
                  {selectedStatement.status}
                  {selectedStatement.completedAt
                    ? ` · ${new Date(selectedStatement.completedAt).toLocaleDateString()}`
                    : ""}
                </div>
                {onOpenStudentFinder && (
                  <button
                    type="button"
                    onClick={() =>
                      onOpenStudentFinder(selectedStatement.displayName)
                    }
                    className="mt-2 inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-bold"
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
                <pre
                  className="mt-3 whitespace-pre-wrap text-xs"
                  style={{ color: C.ink, fontFamily: "inherit" }}
                >
                  {selectedStatement.body || "(no body yet)"}
                </pre>
              </>
            ) : selectedMentioned ? (
              <>
                <h3 className="text-sm font-bold">
                  {selectedMentioned.firstName} {selectedMentioned.lastName}
                </h3>
                <div
                  className="mt-1 text-[11px]"
                  style={{ color: C.inkSoft }}
                >
                  Named in {selectedMentioned.mentionedInStatementIds.length}{" "}
                  statement(s) but hasn't given one.
                </div>
                {onOpenStudentFinder && (
                  <button
                    type="button"
                    onClick={() =>
                      onOpenStudentFinder(
                        `${selectedMentioned.firstName} ${selectedMentioned.lastName}`,
                      )
                    }
                    className="mt-2 mr-2 inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-bold"
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
                {onRequestStatement && incidentId && (
                  <button
                    type="button"
                    className="mt-3 rounded-md px-3 py-1.5 text-xs font-bold text-white"
                    style={{ background: C.brand }}
                    onClick={() =>
                      onRequestStatement(
                        selectedMentioned.studentId,
                        incidentId,
                      )
                    }
                  >
                    Request statement
                  </button>
                )}
              </>
            ) : (
              <div className="text-xs" style={{ color: C.inkSoft }}>
                Click a witness to read their statement, or a
                mentioned-but-silent sphere to request one.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
