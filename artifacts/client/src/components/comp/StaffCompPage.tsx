// Staff-facing Comp Time (FLSA compensatory time) page.
//
// Mirror of StaffAstPage.tsx with these material differences:
//   * Eligibility splash for exempt staff (server returns
//     `{ eligible: false, refer: 'AST' }`).
//   * Earn form collects WEEK_START_DATE + HOURS_WORKED in the week
//     (not event date + earn hours). The 1.5x credit is computed
//     server-side on overflow above 40h.
//   * Two required attestations: (1) hours are on timesheet, (2)
//     prior supervisor approval was secured. FLSA requirements,
//     enforced server-side too.
//   * Optional signed Authorization to Accrue Comp Time upload —
//     required when the school setting is on (default true).
//     Re-uses the standard /api/storage/uploads/request-url pipeline.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { authFetch } from "../../lib/authToken";

type CompRequest = {
  id: number;
  schoolId: number;
  staffId: number;
  kind: "earn" | "use";
  state:
    | "pending_preapproval"
    | "preapproved"
    | "denied"
    | "pending_confirm"
    | "confirmed"
    | "cancelled";
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
  cancelNote: string | null;
};

type Me =
  | {
      eligible: false;
      canApproveCompTime: boolean;
      balanceQuarterHours: 0;
      needsCompletion: 0;
      requests: [];
    }
  | {
      eligible: true;
      balanceQuarterHours: number;
      capQuarterHours: number;
      canApproveCompTime: boolean;
      needsCompletion: number;
      requests: CompRequest[];
      workweekStart: "sunday" | "monday";
      requireAuthForm: boolean;
      authFormTemplateObjectKey: string | null;
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

function statePill(s: CompRequest["state"]): CSSProperties {
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
    case "pending_confirm":
      return { ...base, background: "#fef3c7", color: "#92400e" };
    case "preapproved":
      return { ...base, background: "#dbeafe", color: "#1e40af" };
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

function stateLabel(r: CompRequest): string {
  if (r.state === "pending_preapproval") {
    return r.kind === "earn"
      ? "Awaiting pre-approval"
      : "Awaiting admin approval";
  }
  if (r.state === "preapproved") {
    return r.kind === "earn"
      ? "Pre-approved — submit your actual hours when the week is done"
      : "Approved — bank debited";
  }
  if (r.state === "pending_confirm") return "Awaiting admin confirmation";
  if (r.state === "confirmed") return "Confirmed — bank credited";
  if (r.state === "denied") return "Denied";
  if (r.state === "cancelled") return "Cancelled";
  return r.state;
}

function summarizeEarn(r: CompRequest): string {
  const credit = r.quarterHoursActual ?? r.quarterHoursRequested;
  const worked = r.hoursWorkedQh;
  const wk = r.weekStartDate ? ` (week of ${r.weekStartDate})` : "";
  if (worked) {
    return `Earn ${formatHours(credit)} (1.5× on ${formatHours(worked)} worked)${r.reason ? ` — ${r.reason}` : ""}${wk}`;
  }
  return `Earn ${formatHours(credit)}${r.reason ? ` — ${r.reason}` : ""}${wk}`;
}

function summarizeUse(r: CompRequest): string {
  const startStr = r.useStartAt
    ? new Date(r.useStartAt).toLocaleString()
    : "?";
  const endStr = r.useEndAt ? new Date(r.useEndAt).toLocaleString() : "?";
  return `Use ${formatHours(r.quarterHoursRequested)} — ${startStr} → ${endStr}`;
}

// Compute the Sunday or Monday on or before the given local date.
function weekStartOnOrBefore(date: Date, anchor: "sunday" | "monday"): string {
  const target = anchor === "monday" ? 1 : 0;
  const d = new Date(date);
  while (d.getDay() !== target) d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ¼-hour stepper that defaults to integer hours but allows quarter
// increments via the "+ ¼" / "− ¼" toggle. Stores integer quarter-hours.
function HoursStepper({
  value,
  onChange,
  min = 1,
  max,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
}) {
  const dec = (n: number) => onChange(Math.max(min, value - n));
  const inc = (n: number) =>
    onChange(typeof max === "number" ? Math.min(max, value + n) : value + n);
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <button type="button" style={btn} onClick={() => dec(4)} title="− 1 h">
        − 1h
      </button>
      <button type="button" style={btn} onClick={() => dec(1)} title="− ¼ h">
        − ¼
      </button>
      <span style={{ minWidth: 72, textAlign: "center", fontWeight: 600 }}>
        {formatHours(value)}
      </span>
      <button type="button" style={btn} onClick={() => inc(1)} title="+ ¼ h">
        + ¼
      </button>
      <button type="button" style={btn} onClick={() => inc(4)} title="+ 1 h">
        + 1h
      </button>
    </div>
  );
}

async function uploadSignedForm(file: File): Promise<string> {
  const reqRes = await authFetch("/api/storage/uploads/request-url", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contentType: file.type || "application/octet-stream",
    }),
  });
  if (!reqRes.ok) {
    throw new Error(`Could not request upload URL (${reqRes.status})`);
  }
  const { uploadURL, objectPath } = (await reqRes.json()) as {
    uploadURL: string;
    objectPath: string;
  };
  const putRes = await fetch(uploadURL, {
    method: "PUT",
    body: file,
    headers: { "content-type": file.type || "application/octet-stream" },
  });
  if (!putRes.ok) {
    throw new Error(`Upload failed (${putRes.status})`);
  }
  return objectPath;
}

export default function StaffCompPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [openForm, setOpenForm] = useState<"none" | "earn" | "use">("none");

  // Earn form state
  const [weekStartDate, setWeekStartDate] = useState<string>(() =>
    weekStartOnOrBefore(new Date(), "sunday"),
  );
  const [reason, setReason] = useState("");
  const [hoursWorkedQh, setHoursWorkedQh] = useState(164); // 41 h default
  const [timesheetConfirmed, setTimesheetConfirmed] = useState(false);
  const [priorApprovalConfirmed, setPriorApprovalConfirmed] = useState(false);
  const [authFormFile, setAuthFormFile] = useState<File | null>(null);
  const [authFormObjectKey, setAuthFormObjectKey] = useState<string | null>(
    null,
  );

  // Use form state
  const today = new Date().toISOString().slice(0, 10);
  const [useDate, setUseDate] = useState(today);
  const [useStart, setUseStart] = useState("15:30");
  const [useEnd, setUseEnd] = useState("16:30");

  // Completion form
  const [completionDraft, setCompletionDraft] = useState<{
    [id: number]: { hoursWorkedQh: number; note: string };
  }>({});
  const [openCompletionId, setOpenCompletionId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const r = await authFetch("/api/comp/me", { cache: "no-store" });
      if (!r.ok) throw new Error(`Failed to load (${r.status})`);
      const data = (await r.json()) as Me;
      setMe(data);
      if (data.eligible) {
        setWeekStartDate(weekStartOnOrBefore(new Date(), data.workweekStart));
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    void authFetch("/api/comp/acknowledge", {
      method: "POST",
      cache: "no-store",
    }).catch(() => {});
  }, [load]);

  // ---------- not eligible splash ----------
  if (me && !me.eligible) {
    return (
      <div style={{ padding: 16, maxWidth: 720, margin: "0 auto" }}>
        <h1 style={{ marginTop: 0, fontSize: "1.5rem" }}>Comp Time</h1>
        <div
          style={{
            ...card,
            background: "#fef9c3",
            borderColor: "#fde68a",
          }}
        >
          <h3 style={{ marginTop: 0 }}>You are not eligible for Comp Time</h3>
          <p style={{ marginBottom: 6 }}>
            Comp Time is the FLSA-required bank for non-exempt staff who work
            over 40 hours in a workweek. Your role is classified as exempt
            (salaried) — overtime accrual does not apply.
          </p>
          <p style={{ marginBottom: 0 }}>
            If you work outside your contracted day, use{" "}
            <strong>Alternate Schedule Time (AST)</strong> instead. If you
            believe your exempt status is recorded incorrectly, contact your
            administrator.
          </p>
        </div>
      </div>
    );
  }

  if (!me) {
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

  const balanceQh = me.balanceQuarterHours;
  const capQh = me.capQuarterHours;
  const headroomQh = Math.max(0, capQh - balanceQh);

  const computedCreditPreview = (() => {
    const overflow = Math.max(0, hoursWorkedQh - 160);
    if (overflow === 0) return 0;
    return Math.ceil((overflow * 3) / 2);
  })();

  const submitEarn = async () => {
    setBusy(true);
    setErr(null);
    try {
      let key = authFormObjectKey;
      if (me.requireAuthForm && !key && authFormFile) {
        key = await uploadSignedForm(authFormFile);
        setAuthFormObjectKey(key);
      }
      const r = await authFetch("/api/comp/earn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          weekStartDate,
          reason: reason.trim(),
          hoursWorkedQh,
          authFormObjectKey: key,
          timesheetConfirmed,
          priorSupervisorApprovalConfirmed: priorApprovalConfirmed,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.message ?? j?.error ?? `Failed (${r.status})`);
      setOpenForm("none");
      setReason("");
      setHoursWorkedQh(164);
      setTimesheetConfirmed(false);
      setPriorApprovalConfirmed(false);
      setAuthFormFile(null);
      setAuthFormObjectKey(null);
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
      const r = await authFetch("/api/comp/use", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          startAt: start.toISOString(),
          endAt: end.toISOString(),
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.message ?? j?.error ?? `Failed (${r.status})`);
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
      const r = await authFetch(`/api/comp/earn/${id}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          hoursWorkedQh: draft.hoursWorkedQh,
          note: draft.note.trim() || undefined,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.message ?? j?.error ?? `Failed (${r.status})`);
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
      const r = await authFetch(`/api/comp/${id}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.message ?? j?.error ?? `Failed (${r.status})`);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const grouped = useMemo(() => {
    const list = me.requests;
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
  }, [me.requests]);

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

  return (
    <div style={{ padding: 16, maxWidth: 980, margin: "0 auto" }}>
      <h1 style={{ marginTop: 0, fontSize: "1.5rem" }}>Comp Time</h1>
      <p style={{ color: "#475569", marginTop: -8, fontSize: "0.9rem" }}>
        FLSA compensatory time for non-exempt staff. Hours worked OVER 40 in
        a single workweek accrue at <strong>1.5×</strong>. Workweek starts{" "}
        <strong>{me.workweekStart === "monday" ? "Monday" : "Sunday"}</strong>.
        Bank capped at 240 h (FLSA). Prior supervisor approval is required
        before working overflow hours.
      </p>

      <div
        style={{
          ...card,
          background: "#f0fdf4",
          borderColor: "#bbf7d0",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <div>
          <div style={{ fontSize: "0.75rem", color: "#15803d" }}>
            COMP TIME BANK
          </div>
          <div style={{ fontSize: "2rem", fontWeight: 700, color: "#14532d" }}>
            {formatHours(balanceQh)}
          </div>
          <div style={{ fontSize: "0.78rem", color: "#15803d" }}>
            {formatHours(headroomQh)} headroom under 240 h cap
          </div>
          {me.needsCompletion > 0 && (
            <div style={{ color: "#92400e", fontSize: "0.85rem", marginTop: 4 }}>
              {me.needsCompletion} pre-approved week
              {me.needsCompletion === 1 ? "" : "s"} waiting for you to submit
              actual hours.
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            style={btnPrimary}
            onClick={() => setOpenForm(openForm === "earn" ? "none" : "earn")}
          >
            {openForm === "earn" ? "Close" : "Request to earn Comp Time"}
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
            {openForm === "use" ? "Close" : "Request to use Comp Time"}
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
          <h3 style={{ marginTop: 0 }}>Request to earn Comp Time</h3>
          <p style={{ fontSize: "0.85rem", color: "#475569", marginTop: -6 }}>
            Submit AFTER the workweek ends. Enter total hours WORKED in the
            week (regular + overtime). Credit is calculated at 1.5× on
            anything over 40 h.
          </p>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 12,
              maxWidth: 620,
            }}
          >
            <label style={labelRow}>
              <span>
                Workweek start ({me.workweekStart === "monday" ? "Mon" : "Sun"})
              </span>
              <input
                type="date"
                value={weekStartDate}
                onChange={(e) => setWeekStartDate(e.target.value)}
                style={input}
              />
            </label>
            <label style={labelRow}>
              <span>Total hours worked in the week</span>
              <HoursStepper
                value={hoursWorkedQh}
                onChange={setHoursWorkedQh}
                min={161}
              />
            </label>
            <label style={{ ...labelRow, gridColumn: "1 / -1" }}>
              <span>
                Reason (e.g. hurricane prep, after-hours custodial, summer
                project)
              </span>
              <input
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                style={input}
                placeholder="Why did the overflow happen?"
              />
            </label>
          </div>

          <div
            style={{
              marginTop: 10,
              padding: 10,
              background: "#ecfdf5",
              borderRadius: 8,
              borderLeft: "4px solid #10b981",
              fontSize: "0.88rem",
            }}
          >
            Estimated credit:{" "}
            <strong>{formatHours(computedCreditPreview)}</strong> (1.5× on{" "}
            {formatHours(Math.max(0, hoursWorkedQh - 160))} over 40 h)
          </div>

          {me.requireAuthForm && (
            <div
              style={{
                marginTop: 10,
                padding: 10,
                background: "#fffbeb",
                borderRadius: 8,
                borderLeft: "4px solid #f59e0b",
                fontSize: "0.85rem",
              }}
            >
              <div style={{ marginBottom: 6 }}>
                <strong>Signed Authorization to Accrue Comp Time</strong>{" "}
                (required by your district).
              </div>
              {me.authFormTemplateObjectKey ? (
                <div style={{ marginBottom: 6 }}>
                  <a
                    href={`/api/storage${me.authFormTemplateObjectKey}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: "#0369a1" }}
                  >
                    Download blank form →
                  </a>
                </div>
              ) : (
                <div style={{ marginBottom: 6, color: "#92400e" }}>
                  No template uploaded yet — ask your admin to upload one
                  under Settings → Time Tracking.
                </div>
              )}
              <input
                type="file"
                accept="application/pdf,image/*"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  setAuthFormFile(f);
                  setAuthFormObjectKey(null);
                }}
              />
              {authFormObjectKey && (
                <div style={{ color: "#166534", marginTop: 4 }}>
                  Uploaded ✓
                </div>
              )}
            </div>
          )}

          <div
            style={{
              marginTop: 10,
              display: "flex",
              flexDirection: "column",
              gap: 6,
              fontSize: "0.85rem",
            }}
          >
            <label>
              <input
                type="checkbox"
                checked={priorApprovalConfirmed}
                onChange={(e) => setPriorApprovalConfirmed(e.target.checked)}
              />{" "}
              I had prior supervisor approval BEFORE working these overflow
              hours.
            </label>
            <label>
              <input
                type="checkbox"
                checked={timesheetConfirmed}
                onChange={(e) => setTimesheetConfirmed(e.target.checked)}
              />{" "}
              These hours are recorded on my timesheet for the same workweek.
            </label>
          </div>

          <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
            <button
              type="button"
              style={btnPrimary}
              disabled={
                busy ||
                !reason.trim() ||
                computedCreditPreview <= 0 ||
                !timesheetConfirmed ||
                !priorApprovalConfirmed ||
                (me.requireAuthForm && !authFormFile && !authFormObjectKey)
              }
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
          <h3 style={{ marginTop: 0 }}>Request to use Comp Time</h3>
          <p style={{ fontSize: "0.85rem", color: "#475569", marginTop: -6 }}>
            Pick the date and start/end time you want to be off. Admin
            approval debits your bank.
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
        {grouped.open.length === 0 ? (
          <div style={{ color: "#64748b", fontSize: "0.9rem" }}>
            No open requests.
          </div>
        ) : (
          grouped.open.map((r) => {
            const draft = completionDraft[r.id] ?? {
              hoursWorkedQh: r.hoursWorkedQh ?? 164,
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
                    {r.kind === "earn" ? summarizeEarn(r) : summarizeUse(r)}
                  </span>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {r.kind === "earn" && r.state === "preapproved" && (
                    <button
                      type="button"
                      style={btnPrimary}
                      onClick={() => {
                        setCompletionDraft((d) => ({ ...d, [r.id]: draft }));
                        setOpenCompletionId(
                          openCompletionId === r.id ? null : r.id,
                        );
                      }}
                    >
                      {openCompletionId === r.id
                        ? "Cancel"
                        : "Submit actual hours"}
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
                        Actual hours worked in the week:
                      </span>
                      <HoursStepper
                        value={draft.hoursWorkedQh}
                        onChange={(v) =>
                          setCompletionDraft((d) => ({
                            ...d,
                            [r.id]: { ...draft, hoursWorkedQh: v },
                          }))
                        }
                        min={1}
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
                        disabled={busy}
                        onClick={() => submitCompletion(r.id)}
                      >
                        Submit for confirmation
                      </button>
                    </div>
                  </div>
                )}
                {(r.preapprovalNote ||
                  r.confirmNote ||
                  r.denyNote ||
                  r.cancelNote ||
                  r.completionNote) && (
                  <div style={{ fontSize: "0.8rem", color: "#475569" }}>
                    {r.preapprovalNote && <div>Admin: {r.preapprovalNote}</div>}
                    {r.completionNote && <div>You: {r.completionNote}</div>}
                    {r.confirmNote && <div>Admin: {r.confirmNote}</div>}
                    {r.denyNote && <div>Admin (denied): {r.denyNote}</div>}
                    {r.cancelNote && <div>Cancelled: {r.cancelNote}</div>}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <SectionBand color="slate" label="History" />
      <div style={card}>
        {grouped.closed.length === 0 ? (
          <div style={{ color: "#64748b", fontSize: "0.9rem" }}>
            No history yet.
          </div>
        ) : (
          grouped.closed.slice(0, 30).map((r) => (
            <div
              key={r.id}
              style={{
                borderTop: "1px solid #f1f5f9",
                padding: "8px 0",
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <span style={statePill(r.state)}>
                {r.kind === "earn" ? "EARN" : "USE"} · {stateLabel(r)}
              </span>
              <span style={{ fontSize: "0.85rem" }}>
                {r.kind === "earn" ? summarizeEarn(r) : summarizeUse(r)}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
