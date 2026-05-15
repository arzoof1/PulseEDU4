// Staff-facing AST (Alternate Schedule Time) page.
//
// Shows the staff member's current bank balance, their request history
// (with state pills + next-action buttons), and two action buttons that
// open inline forms for "Request to earn" and "Request to use". Bank
// values are stored as integer quarter-hours on the server; this page is
// the single conversion point to the human-readable "X.YZ hr" display.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { authFetch } from "../../lib/authToken";

type AstRequest = {
  id: number;
  schoolId: number;
  staffId: number;
  kind: "earn" | "use";
  state:
    | "pending_preapproval"
    | "preapproved"
    | "denied"
    | "pending_completion"
    | "pending_confirm"
    | "confirmed"
    | "cancelled";
  eventDate: string | null;
  reason: string | null;
  quarterHoursRequested: number;
  quarterHoursActual: number | null;
  useStartAt: string | null;
  useEndAt: string | null;
  createdAt: string;
  preapprovalNote: string | null;
  completionNote: string | null;
  confirmNote: string | null;
  denyNote: string | null;
  cancelNote: string | null;
};

type Me = {
  balanceQuarterHours: number;
  canApproveAst: boolean;
  needsCompletion: number;
  requests: AstRequest[];
};

const card: CSSProperties = {
  background: "white",
  border: "1px solid #e2e8f0",
  borderRadius: 10,
  padding: 16,
  marginBottom: 14,
};
const btn: CSSProperties = {
  padding: "6px 12px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  background: "white",
  cursor: "pointer",
  fontSize: "0.85rem",
};
const btnPrimary: CSSProperties = {
  ...btn,
  background: "#0ea5e9",
  borderColor: "#0284c7",
  color: "white",
};
const btnDanger: CSSProperties = {
  ...btn,
  background: "white",
  borderColor: "#fecaca",
  color: "#b91c1c",
};
const labelRow: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: "0.85rem",
};
const input: CSSProperties = {
  padding: "6px 8px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: "0.9rem",
};

function formatHours(qh: number): string {
  return `${(qh / 4).toFixed(2)} hr`;
}

function statePill(s: AstRequest["state"]): CSSProperties {
  const base: CSSProperties = {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 999,
    fontSize: "0.72rem",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 0.3,
  };
  switch (s) {
    case "pending_preapproval":
      return { ...base, background: "#fef3c7", color: "#92400e" };
    case "preapproved":
      return { ...base, background: "#dbeafe", color: "#1e40af" };
    case "pending_confirm":
      return { ...base, background: "#fef3c7", color: "#92400e" };
    case "confirmed":
      return { ...base, background: "#dcfce7", color: "#166534" };
    case "denied":
      return { ...base, background: "#fee2e2", color: "#991b1b" };
    case "cancelled":
      return { ...base, background: "#e5e7eb", color: "#374151" };
    default:
      return { ...base, background: "#e5e7eb", color: "#374151" };
  }
}

function stateLabel(r: AstRequest): string {
  if (r.state === "pending_preapproval") {
    return r.kind === "earn"
      ? "Awaiting pre-approval"
      : "Awaiting admin approval";
  }
  if (r.state === "preapproved") {
    return r.kind === "earn"
      ? "Pre-approved — submit your hours when work is done"
      : "Approved — bank debited";
  }
  if (r.state === "pending_confirm") return "Awaiting admin confirmation";
  if (r.state === "confirmed") return "Confirmed — bank credited";
  if (r.state === "denied") return "Denied";
  if (r.state === "cancelled") return "Cancelled";
  return r.state;
}

function formatRequestSummary(r: AstRequest): string {
  if (r.kind === "earn") {
    const qh = r.quarterHoursActual ?? r.quarterHoursRequested;
    const verb = r.quarterHoursActual ? "actual" : "requested";
    return `Earn ${formatHours(qh)} ${verb}${r.reason ? ` — ${r.reason}` : ""}${r.eventDate ? ` (${r.eventDate})` : ""}`;
  }
  // use
  const startStr = r.useStartAt
    ? new Date(r.useStartAt).toLocaleString()
    : "?";
  const endStr = r.useEndAt ? new Date(r.useEndAt).toLocaleString() : "?";
  return `Use ${formatHours(r.quarterHoursRequested)} — ${startStr} → ${endStr}`;
}

// ¼-hour stepper. Stores integer quarter-hours; displays human hours.
function HoursStepper({
  value,
  onChange,
  max,
}: {
  value: number;
  onChange: (v: number) => void;
  max?: number;
}) {
  const dec = () => onChange(Math.max(1, value - 1));
  const inc = () =>
    onChange(typeof max === "number" ? Math.min(max, value + 1) : value + 1);
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <button type="button" style={btn} onClick={dec}>
        −
      </button>
      <span style={{ minWidth: 64, textAlign: "center", fontWeight: 600 }}>
        {formatHours(value)}
      </span>
      <button type="button" style={btn} onClick={inc}>
        +
      </button>
    </div>
  );
}

export default function StaffAstPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Form panel toggles. Only one open at a time so the page stays calm.
  const [openForm, setOpenForm] = useState<"none" | "earn" | "use">("none");

  // Earn form
  const [eventDate, setEventDate] = useState<string>(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [reason, setReason] = useState("");
  const [earnQh, setEarnQh] = useState(4); // 1.0 hr default

  // Use form
  const today = new Date().toISOString().slice(0, 10);
  const [useDate, setUseDate] = useState(today);
  const [useStart, setUseStart] = useState("15:30");
  const [useEnd, setUseEnd] = useState("16:30");

  // Per-request inline state
  const [completionDraft, setCompletionDraft] = useState<{
    [id: number]: { qh: number; note: string };
  }>({});
  const [openCompletionId, setOpenCompletionId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const r = await authFetch("/api/ast/me", { cache: "no-store" });
      if (!r.ok) throw new Error(`Failed to load (${r.status})`);
      const data = (await r.json()) as Me;
      setMe(data);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    // Mark all admin replies as read for this user. Drives the sidebar
    // bell to zero on visit. Fire-and-forget — failure is silent because
    // the next visit will retry.
    void authFetch("/api/ast/acknowledge", {
      method: "POST",
      cache: "no-store",
    }).catch(() => {
      /* swallow */
    });
  }, [load]);

  const balanceQh = me?.balanceQuarterHours ?? 0;

  const submitEarn = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await authFetch("/api/ast/earn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          eventDate,
          reason: reason.trim(),
          quarterHours: earnQh,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error ?? `Failed (${r.status})`);
      setOpenForm("none");
      setReason("");
      setEarnQh(4);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const submitUse = async () => {
    setBusy(true);
    setErr(null);
    try {
      const start = new Date(`${useDate}T${useStart}:00`);
      const end = new Date(`${useDate}T${useEnd}:00`);
      const r = await authFetch("/api/ast/use", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          startAt: start.toISOString(),
          endAt: end.toISOString(),
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error ?? `Failed (${r.status})`);
      setOpenForm("none");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const submitCompletion = async (id: number) => {
    const draft = completionDraft[id];
    if (!draft) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await authFetch(`/api/ast/earn/${id}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          quarterHoursActual: draft.qh,
          note: draft.note.trim() || undefined,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error ?? `Failed (${r.status})`);
      setOpenCompletionId(null);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (id: number) => {
    if (!window.confirm("Cancel this request?")) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await authFetch(`/api/ast/${id}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error ?? `Failed (${r.status})`);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Small colored band that visually separates "Open requests" (blue,
   // still in flight with admin) from "History" (slate, done) so a
   // staff member can scan their list at a glance without parsing
   // every state pill.
  const SectionBand = ({
    color,
    label,
  }: {
    color: "blue" | "slate";
    label: string;
  }) => {
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
          marginTop: 6,
          fontSize: "0.78rem",
          fontWeight: 700,
          letterSpacing: 0.4,
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>
    );
  };

  const groupedRequests = useMemo(() => {
    const list = me?.requests ?? [];
    const open = list.filter(
      (r) =>
        r.state === "pending_preapproval" ||
        r.state === "preapproved" ||
        r.state === "pending_confirm",
    );
    const closed = list.filter(
      (r) =>
        r.state === "confirmed" ||
        r.state === "denied" ||
        r.state === "cancelled",
    );
    return { open, closed };
  }, [me?.requests]);

  return (
    <div style={{ padding: 16, maxWidth: 980, margin: "0 auto" }}>
      <h1 style={{ marginTop: 0, fontSize: "1.5rem" }}>
        Alternate Schedule Time (AST)
      </h1>
      <p style={{ color: "#475569", marginTop: -8, fontSize: "0.9rem" }}>
        Per HCTA contract. Earn AST for approved work performed beyond your
        contracted day, then use it during non-student-contact time. ¼-hour
        increments. Unused balance lapses on June 30.
      </p>

      <div
        style={{
          ...card,
          background: "#f0f9ff",
          borderColor: "#bae6fd",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <div>
          <div style={{ fontSize: "0.75rem", color: "#0369a1" }}>
            CURRENT BANK
          </div>
          <div style={{ fontSize: "2rem", fontWeight: 700, color: "#0c4a6e" }}>
            {formatHours(balanceQh)}
          </div>
          {me && me.needsCompletion > 0 && (
            <div style={{ color: "#92400e", fontSize: "0.85rem" }}>
              You have {me.needsCompletion} pre-approved request
              {me.needsCompletion === 1 ? "" : "s"} waiting for you to submit
              completion.
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            style={btnPrimary}
            onClick={() => setOpenForm(openForm === "earn" ? "none" : "earn")}
          >
            {openForm === "earn" ? "Close" : "Request to earn AST"}
          </button>
          <button
            type="button"
            style={btnPrimary}
            disabled={balanceQh <= 0}
            title={
              balanceQh <= 0
                ? "Bank is empty — earn time first"
                : "Request to use earned time"
            }
            onClick={() => setOpenForm(openForm === "use" ? "none" : "use")}
          >
            {openForm === "use" ? "Close" : "Request to use AST"}
          </button>
        </div>
      </div>

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

      {openForm === "earn" && (
        <div style={card}>
          <h3 style={{ marginTop: 0 }}>Request to earn AST</h3>
          <p style={{ fontSize: "0.85rem", color: "#475569", marginTop: -6 }}>
            Submit BEFORE the work happens. Per the contract, work performed
            without prior administrative approval is voluntary.
          </p>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 12,
              maxWidth: 520,
            }}
          >
            <label style={labelRow}>
              <span>Date of work</span>
              <input
                type="date"
                value={eventDate}
                onChange={(e) => setEventDate(e.target.value)}
                style={input}
              />
            </label>
            <label style={labelRow}>
              <span>Expected hours</span>
              <HoursStepper value={earnQh} onChange={setEarnQh} />
            </label>
            <label style={{ ...labelRow, gridColumn: "1 / -1" }}>
              <span>
                Reason (e.g. Open House, parent conference, extended faculty
                meeting)
              </span>
              <input
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                style={input}
                placeholder="What's the event?"
              />
            </label>
          </div>
          <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
            <button
              type="button"
              style={btnPrimary}
              disabled={busy || !reason.trim()}
              onClick={submitEarn}
            >
              Submit
            </button>
            <button
              type="button"
              style={btn}
              onClick={() => setOpenForm("none")}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {openForm === "use" && (
        <div style={card}>
          <h3 style={{ marginTop: 0 }}>Request to use AST</h3>
          <p style={{ fontSize: "0.85rem", color: "#475569", marginTop: -6 }}>
            Pick the date and start/end time you want to be off. No reason is
            required. Admin will approve or deny with notes.
          </p>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr",
              gap: 12,
              maxWidth: 520,
            }}
          >
            <label style={labelRow}>
              <span>Date</span>
              <input
                type="date"
                value={useDate}
                onChange={(e) => setUseDate(e.target.value)}
                style={input}
              />
            </label>
            <label style={labelRow}>
              <span>Start</span>
              <input
                type="time"
                value={useStart}
                onChange={(e) => setUseStart(e.target.value)}
                style={input}
                step={900}
              />
            </label>
            <label style={labelRow}>
              <span>End</span>
              <input
                type="time"
                value={useEnd}
                onChange={(e) => setUseEnd(e.target.value)}
                style={input}
                step={900}
              />
            </label>
          </div>
          <div
            style={{
              marginTop: 8,
              fontSize: "0.85rem",
              color: "#475569",
            }}
          >
            Bank: <strong>{formatHours(balanceQh)}</strong> available.
          </div>
          <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
            <button
              type="button"
              style={btnPrimary}
              disabled={busy}
              onClick={submitUse}
            >
              Submit
            </button>
            <button
              type="button"
              style={btn}
              onClick={() => setOpenForm("none")}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <SectionBand color="blue" label="Open requests" />
      <div style={card}>
        <h3 style={{ marginTop: 0 }}>Open requests</h3>
        {groupedRequests.open.length === 0 ? (
          <div style={{ color: "#64748b", fontSize: "0.9rem" }}>
            No open requests.
          </div>
        ) : (
          groupedRequests.open.map((r) => {
            const draft = completionDraft[r.id] ?? {
              qh: r.quarterHoursRequested,
              note: "",
            };
            return (
              <div
                key={r.id}
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
                  <span style={statePill(r.state)}>
                    {r.kind === "earn" ? "EARN" : "USE"} · {stateLabel(r)}
                  </span>
                  <span style={{ fontSize: "0.9rem" }}>
                    {formatRequestSummary(r)}
                  </span>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {r.kind === "earn" && r.state === "preapproved" && (
                    <button
                      type="button"
                      style={btnPrimary}
                      onClick={() => {
                        setCompletionDraft((d) => ({
                          ...d,
                          [r.id]: draft,
                        }));
                        setOpenCompletionId(
                          openCompletionId === r.id ? null : r.id,
                        );
                      }}
                    >
                      {openCompletionId === r.id
                        ? "Cancel"
                        : "Submit completion hours"}
                    </button>
                  )}
                  {(r.state === "pending_preapproval" ||
                    r.state === "preapproved" ||
                    r.state === "pending_confirm") && (
                    <button
                      type="button"
                      style={btnDanger}
                      onClick={() => cancel(r.id)}
                    >
                      Cancel request
                    </button>
                  )}
                </div>
                {openCompletionId === r.id && (
                  <div
                    style={{
                      marginTop: 6,
                      padding: 10,
                      background: "#f8fafc",
                      borderRadius: 6,
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        gap: 12,
                        alignItems: "center",
                        flexWrap: "wrap",
                      }}
                    >
                      <span style={{ fontSize: "0.85rem" }}>
                        Actual hours worked:
                      </span>
                      <HoursStepper
                        value={draft.qh}
                        onChange={(v) =>
                          setCompletionDraft((d) => ({
                            ...d,
                            [r.id]: { ...draft, qh: v },
                          }))
                        }
                      />
                    </div>
                    <input
                      type="text"
                      placeholder="Note (optional)"
                      value={draft.note}
                      onChange={(e) =>
                        setCompletionDraft((d) => ({
                          ...d,
                          [r.id]: { ...draft, note: e.target.value },
                        }))
                      }
                      style={input}
                    />
                    <div>
                      <button
                        type="button"
                        style={btnPrimary}
                        disabled={busy || draft.qh <= 0}
                        onClick={() => submitCompletion(r.id)}
                      >
                        Submit completion
                      </button>
                    </div>
                  </div>
                )}
                {r.preapprovalNote && (
                  <div style={{ fontSize: "0.78rem", color: "#475569" }}>
                    Admin note: {r.preapprovalNote}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <SectionBand color="slate" label="History" />
      <div style={card}>
        <h3 style={{ marginTop: 0 }}>History</h3>
        {groupedRequests.closed.length === 0 ? (
          <div style={{ color: "#64748b", fontSize: "0.9rem" }}>No history.</div>
        ) : (
          groupedRequests.closed.slice(0, 50).map((r) => (
            <div
              key={r.id}
              style={{
                borderTop: "1px solid #f1f5f9",
                padding: "8px 0",
                display: "flex",
                flexDirection: "column",
                gap: 4,
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
                <span style={statePill(r.state)}>
                  {r.kind === "earn" ? "EARN" : "USE"} · {stateLabel(r)}
                </span>
                <span style={{ fontSize: "0.9rem" }}>
                  {formatRequestSummary(r)}
                </span>
              </div>
              {r.denyNote && (
                <div style={{ fontSize: "0.78rem", color: "#991b1b" }}>
                  Denial reason: {r.denyNote}
                </div>
              )}
              {r.confirmNote && (
                <div style={{ fontSize: "0.78rem", color: "#475569" }}>
                  Confirm note: {r.confirmNote}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
