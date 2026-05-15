// Admin-facing AST queue. Three panels (Earn pre-approvals, Completion
// confirms, Use approvals) + a recently-decided tail. Approve / Deny
// inline; deny requires a note (server enforces, client also enforces
// for snappy UX). Visible to anyone with `canApproveAst` (admin tier OR
// the per-staff flag granted to e.g. the confidential secretary).

import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { authFetch } from "../../lib/authToken";

// Mirror of lib/db/src/schema/staffAst.ts AST_CATEGORIES — kept in sync
// manually so this module doesn't pull in a server-side import. The
// server is the source of truth and rejects unknown values, so a drift
// here will surface as a 400 not a silent miscategorization.
const AST_CATEGORIES = [
  "Family-Facing",
  "Culture & Climate",
  "Athletics",
  "Academic Enrichment",
  "Operational/PD",
] as const;
type AstCategory = (typeof AST_CATEGORIES)[number];

type AstRequest = {
  id: number;
  staffId: number;
  kind: "earn" | "use";
  state: string;
  eventDate: string | null;
  reason: string | null;
  quarterHoursRequested: number;
  quarterHoursActual: number | null;
  useStartAt: string | null;
  useEndAt: string | null;
  createdAt: string;
  category: AstCategory | null;
  preapprovalNote: string | null;
  completionNote: string | null;
  confirmNote: string | null;
  denyNote: string | null;
};
type Row = { request: AstRequest; staffName: string | null };
type Queue = {
  counts: {
    earnPreapprovals: number;
    completionConfirms: number;
    useApprovals: number;
    total: number;
  };
  earnPreapprovals: Row[];
  completionConfirms: Row[];
  useApprovals: Row[];
  recent: Row[];
};

const card: CSSProperties = {
  background: "white",
  border: "1px solid #e2e8f0",
  borderRadius: 10,
  padding: 16,
  marginBottom: 14,
};
const btn: CSSProperties = {
  padding: "5px 10px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  background: "white",
  cursor: "pointer",
  fontSize: "0.82rem",
};
const btnApprove: CSSProperties = {
  ...btn,
  background: "#16a34a",
  borderColor: "#15803d",
  color: "white",
};
const btnDeny: CSSProperties = {
  ...btn,
  background: "white",
  borderColor: "#fecaca",
  color: "#b91c1c",
};
const input: CSSProperties = {
  padding: "5px 8px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: "0.85rem",
  flex: 1,
  minWidth: 200,
};

function formatHours(qh: number): string {
  return `${(qh / 4).toFixed(2)} hr`;
}

function summarize(r: AstRequest): string {
  if (r.kind === "earn") {
    const qh = r.quarterHoursActual ?? r.quarterHoursRequested;
    const verb = r.quarterHoursActual ? "actual" : "requested";
    return `${formatHours(qh)} ${verb}${r.reason ? ` — ${r.reason}` : ""}${r.eventDate ? ` (${r.eventDate})` : ""}`;
  }
  const startStr = r.useStartAt
    ? new Date(r.useStartAt).toLocaleString()
    : "?";
  const endStr = r.useEndAt ? new Date(r.useEndAt).toLocaleString() : "?";
  return `${formatHours(r.quarterHoursRequested)} — ${startStr} → ${endStr}`;
}

type DecisionEndpoint = {
  approveLabel: string;
  endpoint: (id: number) => string;
};

function QueueRow({
  row,
  endpoint,
  approveLabel,
  busy,
  showCategory,
  onAction,
}: {
  row: Row;
  endpoint: (id: number) => string;
  approveLabel: string;
  busy: boolean;
  // Show the category dropdown — only for the two queues where the
  // admin's "approve" action is the *first* approval on the request
  // (earn pre-approval, use approval). Completion-confirm rows already
  // had their category set at pre-approval time, so showing it again
  // would imply it can be edited (it cannot, by design).
  showCategory: boolean;
  onAction: (
    id: number,
    decision: "approve" | "deny",
    note: string,
    url: string,
    category: AstCategory | "",
  ) => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [showNote, setShowNote] = useState(false);
  const [category, setCategory] = useState<AstCategory | "">("");
  const r = row.request;
  return (
    <div
      style={{
        borderTop: "1px solid #f1f5f9",
        padding: "10px 0",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <strong style={{ fontSize: "0.9rem" }}>
          {row.staffName ?? `Staff #${r.staffId}`}
        </strong>
        <span style={{ fontSize: "0.85rem", color: "#475569" }}>
          {summarize(r)}
        </span>
      </div>
      {(r.preapprovalNote || r.completionNote) && (
        <div style={{ fontSize: "0.78rem", color: "#475569" }}>
          {r.preapprovalNote && <>Pre-approval note: {r.preapprovalNote}. </>}
          {r.completionNote && <>Completion note: {r.completionNote}.</>}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {showCategory && (
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as AstCategory | "")}
            style={{ ...input, flex: "0 0 auto", minWidth: 180 }}
            title="Admin-only AST category — staff never see this"
          >
            <option value="">— Category (optional) —</option>
            {AST_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        )}
        <input
          type="text"
          placeholder="Optional note (REQUIRED for deny)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onFocus={() => setShowNote(true)}
          style={input}
        />
        <button
          type="button"
          style={btnApprove}
          disabled={busy}
          onClick={() => onAction(r.id, "approve", note, endpoint(r.id), category)}
        >
          {approveLabel}
        </button>
        <button
          type="button"
          style={btnDeny}
          disabled={busy || !note.trim()}
          title={!note.trim() ? "Type a note explaining why" : "Deny"}
          onClick={() => onAction(r.id, "deny", note, endpoint(r.id), category)}
        >
          Deny
        </button>
      </div>
      {showNote && !note.trim() && (
        <div style={{ fontSize: "0.72rem", color: "#92400e" }}>
          Denial requires a note so the staff member knows why and can
          re-request with the correction.
        </div>
      )}
    </div>
  );
}

export default function AdminAstQueuePage() {
  const [queue, setQueue] = useState<Queue | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const r = await authFetch("/api/ast/admin-queue", {
        cache: "no-store",
      });
      if (!r.ok) {
        if (r.status === 403) {
          setErr("You don't have permission to approve AST requests.");
          return;
        }
        throw new Error(`Failed to load (${r.status})`);
      }
      setQueue((await r.json()) as Queue);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleAction = useCallback(
    async (
      _id: number,
      decision: "approve" | "deny",
      note: string,
      url: string,
      category: AstCategory | "",
    ) => {
      setBusy(true);
      setErr(null);
      try {
        const method = url.endsWith("/cancel") ? "POST" : "PATCH";
        const r = await authFetch(url, {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            decision,
            note: note.trim() || undefined,
            // Server only stores category on approval, but sending it
            // on deny is harmless — server ignores it for that branch.
            category: category || undefined,
          }),
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j?.error ?? `Failed (${r.status})`);
        await load();
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const earnPreEndpoint: DecisionEndpoint = {
    approveLabel: "Pre-approve",
    endpoint: (id) => `/api/ast/earn/${id}/preapprove`,
  };
  const earnConfirmEndpoint: DecisionEndpoint = {
    approveLabel: "Confirm & credit",
    endpoint: (id) => `/api/ast/earn/${id}/confirm`,
  };
  const useDecideEndpoint: DecisionEndpoint = {
    approveLabel: "Approve & debit",
    endpoint: (id) => `/api/ast/use/${id}/decide`,
  };

  return (
    <div style={{ padding: 16, maxWidth: 1100, margin: "0 auto" }}>
      <h1 style={{ marginTop: 0, fontSize: "1.5rem" }}>AST Approval Queue</h1>
      <p style={{ color: "#475569", marginTop: -8, fontSize: "0.9rem" }}>
        Alternate Schedule Time per HCTA contract. Approve / deny earn
        pre-approvals, completion confirmations, and use requests. Denials
        require a note so the staff member can correct and re-request.
      </p>

      {err && (
        <div
          style={{
            ...card,
            background: "#fef2f2",
            borderColor: "#fecaca",
            color: "#991b1b",
          }}
        >
          {err}
        </div>
      )}

      {queue && (
        <>
          <div
            style={{
              display: "flex",
              gap: 12,
              flexWrap: "wrap",
              marginBottom: 14,
            }}
          >
            <CountTile
              label="Earn pre-approvals"
              n={queue.counts.earnPreapprovals}
            />
            <CountTile
              label="Completion confirms"
              n={queue.counts.completionConfirms}
            />
            <CountTile
              label="Use approvals"
              n={queue.counts.useApprovals}
            />
          </div>

          <SectionBand color="blue" label="Open queue" />

          <div style={card}>
            <h3 style={{ marginTop: 0 }}>
              Earn pre-approvals ({queue.counts.earnPreapprovals})
            </h3>
            <p style={{ fontSize: "0.82rem", color: "#475569", marginTop: -6 }}>
              Staff are asking permission BEFORE doing extra work. Approve
              up-front so the time can be banked when they submit completion.
            </p>
            {queue.earnPreapprovals.length === 0 ? (
              <div style={{ color: "#64748b", fontSize: "0.9rem" }}>None.</div>
            ) : (
              queue.earnPreapprovals.map((row) => (
                <QueueRow
                  key={row.request.id}
                  row={row}
                  endpoint={earnPreEndpoint.endpoint}
                  approveLabel={earnPreEndpoint.approveLabel}
                  busy={busy}
                  showCategory
                  onAction={handleAction}
                />
              ))
            )}
          </div>

          <div style={card}>
            <h3 style={{ marginTop: 0 }}>
              Completion confirms ({queue.counts.completionConfirms})
            </h3>
            <p style={{ fontSize: "0.82rem", color: "#475569", marginTop: -6 }}>
              Staff have done the (pre-approved) work and submitted their
              actual hours. Confirming credits their AST bank.
            </p>
            {queue.completionConfirms.length === 0 ? (
              <div style={{ color: "#64748b", fontSize: "0.9rem" }}>None.</div>
            ) : (
              queue.completionConfirms.map((row) => (
                <QueueRow
                  key={row.request.id}
                  row={row}
                  endpoint={earnConfirmEndpoint.endpoint}
                  approveLabel={earnConfirmEndpoint.approveLabel}
                  busy={busy}
                  showCategory={false}
                  onAction={handleAction}
                />
              ))
            )}
          </div>

          <div style={card}>
            <h3 style={{ marginTop: 0 }}>
              Use approvals ({queue.counts.useApprovals})
            </h3>
            <p style={{ fontSize: "0.82rem", color: "#475569", marginTop: -6 }}>
              Staff are asking to use earned time. Approving immediately
              debits their bank. Deny with a note if the requested
              start/end time isn't right — staff can re-request.
            </p>
            {queue.useApprovals.length === 0 ? (
              <div style={{ color: "#64748b", fontSize: "0.9rem" }}>None.</div>
            ) : (
              queue.useApprovals.map((row) => (
                <QueueRow
                  key={row.request.id}
                  row={row}
                  endpoint={useDecideEndpoint.endpoint}
                  approveLabel={useDecideEndpoint.approveLabel}
                  busy={busy}
                  showCategory
                  onAction={handleAction}
                />
              ))
            )}
          </div>

          <SectionBand color="slate" label="History" />

          <div style={card}>
            <h3 style={{ marginTop: 0 }}>Recently decided</h3>
            {queue.recent.length === 0 ? (
              <div style={{ color: "#64748b", fontSize: "0.9rem" }}>None.</div>
            ) : (
              queue.recent.map((row) => {
                const r = row.request;
                return (
                  <div
                    key={r.id}
                    style={{
                      borderTop: "1px solid #f1f5f9",
                      padding: "6px 0",
                      fontSize: "0.85rem",
                      display: "flex",
                      gap: 8,
                      flexWrap: "wrap",
                    }}
                  >
                    <strong>{row.staffName ?? `Staff #${r.staffId}`}</strong>
                    <span>
                      {r.kind === "earn" ? "EARN" : "USE"} → {r.state}
                    </span>
                    <span style={{ color: "#475569" }}>{summarize(r)}</span>
                  </div>
                );
              })
            )}
          </div>
        </>
      )}
    </div>
  );
}

// Colored band that visually separates the "open queue" panels from
// the "history" panel below. Blue = work to do, slate = done.
function SectionBand({
  color,
  label,
}: {
  color: "blue" | "slate";
  label: string;
}) {
  const palette =
    color === "blue"
      ? { bg: "#dbeafe", fg: "#1e40af", bar: "#0ea5e9" }
      : { bg: "#e2e8f0", fg: "#334155", bar: "#64748b" };
  return (
    <div
      style={{
        background: palette.bg,
        color: palette.fg,
        borderLeft: `4px solid ${palette.bar}`,
        borderRadius: 8,
        padding: "8px 14px",
        marginBottom: 10,
        fontSize: "0.78rem",
        fontWeight: 700,
        letterSpacing: 0.4,
        textTransform: "uppercase",
      }}
    >
      {label}
    </div>
  );
}

function CountTile({ label, n }: { label: string; n: number }) {
  return (
    <div
      style={{
        flex: 1,
        minWidth: 180,
        background: n > 0 ? "#fff7ed" : "#f8fafc",
        border: "1px solid",
        borderColor: n > 0 ? "#fed7aa" : "#e2e8f0",
        borderRadius: 8,
        padding: 12,
      }}
    >
      <div style={{ fontSize: "0.72rem", color: "#475569" }}>{label}</div>
      <div style={{ fontSize: "1.6rem", fontWeight: 700 }}>{n}</div>
    </div>
  );
}
