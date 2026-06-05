// Admin-facing Comp Time queue. Three panels (Earn pre-approvals,
// Completion confirms, Use approvals) + a recently-decided tail.
// Mirror of AdminAstQueuePage, adapted for the comp-time data shape.

import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { authFetch } from "../../lib/authToken";
import {
  HowToUseHelp,
  HowToSection,
  RoleSection,
  howtoListStyle,
} from "../HowToUseHelp";

type CompRequest = {
  id: number;
  staffId: number;
  kind: "earn" | "use";
  state: string;
  weekStartDate: string | null;
  reason: string | null;
  hoursWorkedQh: number | null;
  computedCreditQh: number | null;
  quarterHoursRequested: number;
  quarterHoursActual: number | null;
  authFormObjectKey: string | null;
  useStartAt: string | null;
  useEndAt: string | null;
  createdAt: string;
  preapprovalNote: string | null;
  completionNote: string | null;
  confirmNote: string | null;
  denyNote: string | null;
};
type Row = {
  request: CompRequest;
  staffName: string | null;
  staffExemptStatus: string | null;
};
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

function summarize(r: CompRequest): string {
  if (r.kind === "earn") {
    const credit = r.quarterHoursActual ?? r.quarterHoursRequested;
    const worked = r.hoursWorkedQh;
    const wk = r.weekStartDate ? ` (week of ${r.weekStartDate})` : "";
    if (worked) {
      return `${formatHours(credit)} credit (1.5× on ${formatHours(worked)} worked)${r.reason ? ` — ${r.reason}` : ""}${wk}`;
    }
    return `${formatHours(credit)}${r.reason ? ` — ${r.reason}` : ""}${wk}`;
  }
  const startStr = r.useStartAt
    ? new Date(r.useStartAt).toLocaleString()
    : "?";
  const endStr = r.useEndAt ? new Date(r.useEndAt).toLocaleString() : "?";
  return `${formatHours(r.quarterHoursRequested)} — ${startStr} → ${endStr}`;
}

function QueueRow({
  row,
  endpoint,
  approveLabel,
  busy,
  showOverride,
  onAction,
}: {
  row: Row;
  endpoint: (id: number) => string;
  approveLabel: string;
  busy: boolean;
  showOverride: boolean;
  onAction: () => void;
}) {
  const [note, setNote] = useState("");
  const [overrideHours, setOverrideHours] = useState<string>("");
  const [localBusy, setLocalBusy] = useState(false);

  const r = row.request;

  const submit = async (decision: "approve" | "deny") => {
    if (decision === "deny" && !note.trim()) {
      window.alert("Denial note is required.");
      return;
    }
    setLocalBusy(true);
    try {
      const body: Record<string, unknown> = { decision };
      if (note.trim()) body.note = note.trim();
      if (decision === "approve" && showOverride && overrideHours.trim()) {
        const n = Number(overrideHours);
        if (!Number.isFinite(n) || n <= 0) {
          window.alert("Override must be a positive number of quarter-hours.");
          setLocalBusy(false);
          return;
        }
        body.quarterHours = Math.round(n);
      }
      const res = await authFetch(endpoint(r.id), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.message ?? j?.error ?? `Failed (${res.status})`);
      onAction();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    } finally {
      setLocalBusy(false);
    }
  };

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
      <div style={{ fontSize: "0.9rem" }}>
        <strong>{row.staffName ?? `Staff #${r.staffId}`}</strong>{" "}
        {row.staffExemptStatus &&
          row.staffExemptStatus !== "non_exempt" && (
            <span style={{ color: "#b91c1c", fontWeight: 600 }}>
              ({row.staffExemptStatus})
            </span>
          )}
        — {summarize(r)}
        {r.authFormObjectKey && (
          <>
            {" — "}
            <a
              href={`/api/storage${r.authFormObjectKey}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "#0369a1" }}
            >
              signed form
            </a>
          </>
        )}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <input
          type="text"
          placeholder="Note (required on deny, optional on approve)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          style={input}
        />
        {showOverride && (
          <input
            type="number"
            placeholder="Override credit (¼ h units)"
            value={overrideHours}
            onChange={(e) => setOverrideHours(e.target.value)}
            style={{ ...input, maxWidth: 220 }}
            step={1}
            min={1}
          />
        )}
        <button
          type="button"
          style={btnApprove}
          disabled={busy || localBusy}
          onClick={() => submit("approve")}
        >
          {approveLabel}
        </button>
        <button
          type="button"
          style={btnDeny}
          disabled={busy || localBusy}
          onClick={() => submit("deny")}
        >
          Deny
        </button>
      </div>
    </div>
  );
}

export default function AdminCompQueuePage() {
  const [queue, setQueue] = useState<Queue | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy] = useState(false);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const r = await authFetch("/api/comp/admin-queue", { cache: "no-store" });
      if (!r.ok) throw new Error(`Failed to load (${r.status})`);
      setQueue((await r.json()) as Queue);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!queue) {
    return (
      <div style={{ padding: 16 }}>
        {err ? (
          <div style={{ color: "#991b1b" }}>{err}</div>
        ) : (
          <div style={{ color: "#64748b" }}>Loading…</div>
        )}
      </div>
    );
  }

  return (
    <div style={{ padding: 16, maxWidth: 1100, margin: "0 auto" }}>
      <h1 style={{ marginTop: 0, fontSize: "1.5rem" }}>
        Comp Time Approvals
      </h1>
      <HowToUseHelp title="How to use Comp Time Approvals">
        <HowToSection title="What this page is">
          The approval inbox for FLSA compensatory time — earn credits and use
          requests from non-exempt staff.
        </HowToSection>
        <HowToSection title="The two request types">
          <ul style={howtoListStyle}>
            <li>
              <strong>Earn</strong> — verify the overtime week before crediting
              the bank.
            </li>
            <li>
              <strong>Use</strong> — approve drawing a balance down as time off.
            </li>
          </ul>
        </HowToSection>
        <RoleSection for={["admin", "coreTeam"]} title="240-hour cap">
          Credits that would push a bank over 240 hours are rejected — pay the
          excess via payroll. Non-exempt staff only.
        </RoleSection>
      </HowToUseHelp>
      <p style={{ color: "#475569", marginTop: -8, fontSize: "0.9rem" }}>
        FLSA-non-exempt staff only. The bank caps at 240 h — credits that
        would push it over are rejected (pay the excess via payroll).
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

      <div style={card}>
        <h3 style={{ marginTop: 0 }}>
          Earn pre-approvals ({queue.counts.earnPreapprovals})
        </h3>
        <p style={{ fontSize: "0.82rem", color: "#475569", marginTop: -6 }}>
          Approving here authorizes the staff member to do the work and submit
          actual hours afterwards. The bank is NOT credited yet.
        </p>
        {queue.earnPreapprovals.length === 0 ? (
          <div style={{ color: "#64748b", fontSize: "0.9rem" }}>
            Nothing waiting.
          </div>
        ) : (
          queue.earnPreapprovals.map((row) => (
            <QueueRow
              key={row.request.id}
              row={row}
              endpoint={(id) => `/api/comp/earn/${id}/preapprove`}
              approveLabel="Pre-approve"
              busy={busy}
              showOverride={false}
              onAction={load}
            />
          ))
        )}
      </div>

      <div style={card}>
        <h3 style={{ marginTop: 0 }}>
          Completion confirmations ({queue.counts.completionConfirms})
        </h3>
        <p style={{ fontSize: "0.82rem", color: "#475569", marginTop: -6 }}>
          Approving credits the bank. Use the override field to adjust the
          credit (¼-hour units) before approving if actual hours don't match
          the timesheet.
        </p>
        {queue.completionConfirms.length === 0 ? (
          <div style={{ color: "#64748b", fontSize: "0.9rem" }}>
            Nothing waiting.
          </div>
        ) : (
          queue.completionConfirms.map((row) => (
            <QueueRow
              key={row.request.id}
              row={row}
              endpoint={(id) => `/api/comp/earn/${id}/confirm`}
              approveLabel="Confirm & credit"
              busy={busy}
              showOverride
              onAction={load}
            />
          ))
        )}
      </div>

      <div style={card}>
        <h3 style={{ marginTop: 0 }}>
          Use approvals ({queue.counts.useApprovals})
        </h3>
        <p style={{ fontSize: "0.82rem", color: "#475569", marginTop: -6 }}>
          Approving debits the bank. Cannot overdraw — server returns 409 if
          balance is too low.
        </p>
        {queue.useApprovals.length === 0 ? (
          <div style={{ color: "#64748b", fontSize: "0.9rem" }}>
            Nothing waiting.
          </div>
        ) : (
          queue.useApprovals.map((row) => (
            <QueueRow
              key={row.request.id}
              row={row}
              endpoint={(id) => `/api/comp/use/${id}/decide`}
              approveLabel="Approve & debit"
              busy={busy}
              showOverride={false}
              onAction={load}
            />
          ))
        )}
      </div>

      <div style={card}>
        <h3 style={{ marginTop: 0 }}>Recent decisions</h3>
        {queue.recent.length === 0 ? (
          <div style={{ color: "#64748b", fontSize: "0.9rem" }}>
            Nothing yet.
          </div>
        ) : (
          queue.recent.map((row) => (
            <div
              key={row.request.id}
              style={{
                borderTop: "1px solid #f1f5f9",
                padding: "6px 0",
                fontSize: "0.85rem",
              }}
            >
              <strong>{row.staffName ?? `Staff #${row.request.staffId}`}</strong>{" "}
              · {row.request.state} · {summarize(row.request)}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
