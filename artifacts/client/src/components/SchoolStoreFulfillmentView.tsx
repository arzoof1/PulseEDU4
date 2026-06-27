// Core Team / PBIS-coordinator School Store fulfillment dashboard.
//
// Two surfaces:
//  - Distribution: pending (approved, points-held) redemptions grouped by the
//    teacher+period combos the redeeming students are ACTUALLY enrolled in
//    (server validates against real schedules). Pick a combo, see who gets
//    what, mark each "Prepared", and print a pick-sheet PDF for bagging.
//  - Log: the full redemption history, filterable by item and status, with
//    inline approve (pending_approval) and fulfill (pending) actions.
//
// FLEID boundary: every student row renders `localSisId` only — never the
// canonical studentId. The PDF download goes through authFetch → blob →
// a.download (never opened in a tab — the preview-iframe blob gotcha).
import { useCallback, useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/authToken";

interface CatalogItem {
  id: number;
  name: string;
}

interface RedemptionRow {
  id: number;
  itemId: number;
  itemName: string;
  localSisId: string | null;
  studentName: string;
  grade: number | null;
  pointsSpent: number;
  status: string;
  requestedByType: string;
  createdAt: string;
  approvedAt: string | null;
  fulfilledAt: string | null;
  deliverTeacherName: string | null;
  deliverPeriod: string | null;
  cancelReason: string | null;
  pointsRefunded: boolean;
}

interface FulfillmentRow {
  redemptionId: number;
  localSisId: string | null;
  studentName: string;
  grade: number | null;
  itemId: number;
  itemName: string;
  pointsSpent: number;
}

interface FulfillmentCombo {
  teacherStaffId: number;
  teacherName: string;
  period: number;
  periodLabel: string;
  rows: FulfillmentRow[];
}

interface Distribution {
  combos: FulfillmentCombo[];
  unscheduled: FulfillmentRow[];
}

const card: React.CSSProperties = {
  background: "var(--card, #ffffff)",
  border: "1px solid var(--border, #e2e8f0)",
  borderRadius: 12,
  padding: "1rem 1.25rem",
};

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  pending_approval: { label: "Needs approval", color: "#b45309" },
  pending: { label: "Ready to prep", color: "#7c3aed" },
  fulfilled: { label: "Fulfilled", color: "#15803d" },
  cancelled: { label: "Cancelled", color: "#6b7280" },
};

function StatusPill({ status }: { status: string }) {
  const s = STATUS_LABELS[status] ?? { label: status, color: "#475569" };
  return (
    <span
      style={{
        display: "inline-block",
        fontSize: "0.72rem",
        fontWeight: 700,
        padding: "2px 8px",
        borderRadius: 999,
        color: "#fff",
        background: s.color,
        whiteSpace: "nowrap",
      }}
    >
      {s.label}
    </span>
  );
}

function idLabel(localSisId: string | null): string {
  return localSisId ?? "—";
}

function fmtDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function SchoolStoreFulfillmentView() {
  const [tab, setTab] = useState<"distribution" | "log">("distribution");

  // Shared catalog (item filter + labels).
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await authFetch("/api/school-store", { cache: "no-store" });
        if (!r.ok) return;
        const rows = (await r.json()) as { id: number; name: string }[];
        if (cancelled) return;
        setCatalog(rows.map((x) => ({ id: x.id, name: x.name })));
      } catch {
        /* swallow */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <div>
        <h2 style={{ margin: 0 }}>School Store Fulfillment</h2>
        <p style={{ margin: "0.25rem 0 0", color: "var(--muted, #64748b)" }}>
          Approve requests, prep orders by class, and print pick-sheets for
          delivery.
        </p>
      </div>

      <div style={{ display: "flex", gap: "0.5rem" }}>
        {(["distribution", "log"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            style={{
              padding: "0.45rem 1rem",
              borderRadius: 999,
              border: "1px solid var(--border, #e2e8f0)",
              cursor: "pointer",
              fontWeight: 600,
              background: tab === t ? "#7c3aed" : "transparent",
              color: tab === t ? "#fff" : "var(--text, #0f172a)",
            }}
          >
            {t === "distribution" ? "Distribution by class" : "Redemption log"}
          </button>
        ))}
      </div>

      {tab === "distribution" ? (
        <DistributionPanel />
      ) : (
        <LogPanel catalog={catalog} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Distribution by class
// ---------------------------------------------------------------------------
function DistributionPanel() {
  const [data, setData] = useState<Distribution | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [downloading, setDownloading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await authFetch("/api/school-store/distribution", {
        cache: "no-store",
      });
      if (!r.ok) {
        setError("Could not load distribution.");
        return;
      }
      const d = (await r.json()) as Distribution;
      setData(d);
    } catch {
      setError("Could not load distribution.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const comboKey = (c: FulfillmentCombo) => `${c.teacherStaffId}|${c.period}`;
  const selected = useMemo(() => {
    if (!data) return null;
    if (selectedKey === "__unscheduled__") return null;
    return data.combos.find((c) => comboKey(c) === selectedKey) ?? null;
  }, [data, selectedKey]);

  // Default the selection to the first combo once data arrives.
  useEffect(() => {
    if (!data || selectedKey) return;
    if (data.combos.length > 0) setSelectedKey(comboKey(data.combos[0]));
    else if (data.unscheduled.length > 0) setSelectedKey("__unscheduled__");
  }, [data, selectedKey]);

  async function fulfill(
    redemptionId: number,
    deliverTeacherName: string | null,
    deliverPeriod: string | null,
  ) {
    setBusyId(redemptionId);
    try {
      const r = await authFetch(
        `/api/school-store/redemptions/${redemptionId}/fulfill`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deliverTeacherName, deliverPeriod }),
        },
      );
      if (r.ok) await load();
    } finally {
      setBusyId(null);
    }
  }

  async function downloadPickSheet(c: FulfillmentCombo) {
    setDownloading(true);
    try {
      const r = await authFetch(
        `/api/school-store/pick-sheet.pdf?teacherStaffId=${c.teacherStaffId}&period=${c.period}`,
      );
      if (!r.ok) return;
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const safe = c.teacherName.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
      a.download = `pick-sheet-${safe}-period-${c.period}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } finally {
      setDownloading(false);
    }
  }

  if (loading) return <p style={{ color: "var(--muted, #64748b)" }}>Loading…</p>;
  if (error)
    return (
      <div style={card}>
        <p style={{ margin: 0, color: "#b91c1c" }}>{error}</p>
        <button type="button" onClick={() => void load()} style={{ marginTop: 8 }}>
          Retry
        </button>
      </div>
    );
  if (!data) return null;

  const nothing = data.combos.length === 0 && data.unscheduled.length === 0;
  if (nothing)
    return (
      <div style={card}>
        <p style={{ margin: 0 }}>
          🎉 Nothing to prep right now — every approved order has been
          fulfilled.
        </p>
      </div>
    );

  const showUnscheduled = selectedKey === "__unscheduled__";
  const rows = showUnscheduled ? data.unscheduled : (selected?.rows ?? []);

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(220px, 280px) 1fr",
        gap: "1rem",
        alignItems: "start",
      }}
    >
      {/* Combo list */}
      <div style={{ ...card, padding: "0.5rem" }}>
        {data.combos.map((c) => {
          const key = comboKey(c);
          const active = key === selectedKey;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setSelectedKey(key)}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 8,
                width: "100%",
                textAlign: "left",
                padding: "0.6rem 0.7rem",
                border: "none",
                borderRadius: 8,
                cursor: "pointer",
                background: active ? "rgba(147,51,234,0.12)" : "transparent",
                color: "var(--text, #0f172a)",
                fontWeight: active ? 700 : 500,
              }}
            >
              <span>
                {c.teacherName}
                <br />
                <span style={{ fontSize: "0.8rem", color: "var(--muted, #64748b)" }}>
                  {c.periodLabel}
                </span>
              </span>
              <span
                style={{
                  background: "#7c3aed",
                  color: "#fff",
                  borderRadius: 999,
                  fontSize: "0.72rem",
                  fontWeight: 700,
                  padding: "1px 7px",
                }}
              >
                {c.rows.length}
              </span>
            </button>
          );
        })}
        {data.unscheduled.length > 0 && (
          <button
            type="button"
            onClick={() => setSelectedKey("__unscheduled__")}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              width: "100%",
              textAlign: "left",
              padding: "0.6rem 0.7rem",
              border: "none",
              borderTop: "1px solid var(--border, #e2e8f0)",
              borderRadius: 8,
              cursor: "pointer",
              background:
                selectedKey === "__unscheduled__"
                  ? "rgba(100,116,139,0.12)"
                  : "transparent",
              color: "var(--text, #0f172a)",
              fontWeight: selectedKey === "__unscheduled__" ? 700 : 500,
            }}
          >
            <span>No scheduled class</span>
            <span
              style={{
                background: "#64748b",
                color: "#fff",
                borderRadius: 999,
                fontSize: "0.72rem",
                fontWeight: 700,
                padding: "1px 7px",
              }}
            >
              {data.unscheduled.length}
            </span>
          </button>
        )}
      </div>

      {/* Selected combo rows */}
      <div style={card}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
            marginBottom: "0.75rem",
            flexWrap: "wrap",
          }}
        >
          <h3 style={{ margin: 0 }}>
            {showUnscheduled
              ? "No scheduled class"
              : selected
                ? `${selected.teacherName} · ${selected.periodLabel}`
                : "Select a class"}
          </h3>
          {!showUnscheduled && selected && (
            <button
              type="button"
              disabled={downloading}
              onClick={() => void downloadPickSheet(selected)}
              style={{
                padding: "0.4rem 0.85rem",
                borderRadius: 8,
                border: "1px solid var(--border, #e2e8f0)",
                background: "transparent",
                cursor: downloading ? "wait" : "pointer",
                fontWeight: 600,
              }}
            >
              {downloading ? "Preparing…" : "⬇ Pick-sheet PDF"}
            </button>
          )}
        </div>

        {showUnscheduled && (
          <p
            style={{
              margin: "0 0 0.75rem",
              fontSize: "0.85rem",
              color: "var(--muted, #64748b)",
            }}
          >
            These students have an approved order but no scheduled class to
            deliver to. Mark them prepared once handed off directly.
          </p>
        )}

        {rows.length === 0 ? (
          <p style={{ color: "var(--muted, #64748b)" }}>Nothing here.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--muted, #64748b)" }}>
                <th style={{ padding: "6px 8px" }}>Student</th>
                <th style={{ padding: "6px 8px" }}>SIS ID</th>
                <th style={{ padding: "6px 8px" }}>Item</th>
                <th style={{ padding: "6px 8px", textAlign: "right" }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.redemptionId}
                  style={{ borderTop: "1px solid var(--border, #e2e8f0)" }}
                >
                  <td style={{ padding: "8px" }}>
                    {r.studentName}
                    {r.grade !== null && (
                      <span style={{ color: "var(--muted, #64748b)" }}>
                        {" "}
                        (Gr {r.grade})
                      </span>
                    )}
                  </td>
                  <td style={{ padding: "8px" }}>{idLabel(r.localSisId)}</td>
                  <td style={{ padding: "8px" }}>{r.itemName}</td>
                  <td style={{ padding: "8px", textAlign: "right" }}>
                    <button
                      type="button"
                      disabled={busyId === r.redemptionId}
                      onClick={() =>
                        void fulfill(
                          r.redemptionId,
                          showUnscheduled ? null : (selected?.teacherName ?? null),
                          showUnscheduled ? null : (selected?.periodLabel ?? null),
                        )
                      }
                      style={{
                        padding: "0.35rem 0.8rem",
                        borderRadius: 8,
                        border: "none",
                        background: "#15803d",
                        color: "#fff",
                        fontWeight: 600,
                        cursor:
                          busyId === r.redemptionId ? "wait" : "pointer",
                      }}
                    >
                      {busyId === r.redemptionId ? "…" : "Prepared"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Redemption log
// ---------------------------------------------------------------------------
function LogPanel({ catalog }: { catalog: CatalogItem[] }) {
  const [rows, setRows] = useState<RedemptionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [itemId, setItemId] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [busyId, setBusyId] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [confirming, setConfirming] = useState<null | "approve" | "fulfill">(
    null,
  );
  const [bulkBusy, setBulkBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (itemId) params.set("itemId", itemId);
      if (status) params.set("status", status);
      const qs = params.toString();
      const r = await authFetch(
        `/api/school-store/redemptions${qs ? `?${qs}` : ""}`,
        { cache: "no-store" },
      );
      if (!r.ok) {
        setError("Could not load redemptions.");
        return;
      }
      setRows((await r.json()) as RedemptionRow[]);
    } catch {
      setError("Could not load redemptions.");
    } finally {
      setLoading(false);
    }
  }, [itemId, status]);

  useEffect(() => {
    void load();
  }, [load]);

  // A row is "actionable" only while it can still advance (needs approval, or
  // ready to prep). Fulfilled/cancelled rows are never selectable.
  const isActionable = (s: string) =>
    s === "pending_approval" || s === "pending";

  // Keep the selection in sync with the current rows — drop ids that scrolled
  // out of the filter or already changed status, so a stale selection can
  // never act on a row the dean can no longer see.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set<number>();
      for (const r of rows) {
        if (isActionable(r.status) && prev.has(r.id)) next.add(r.id);
      }
      return next.size === prev.size ? prev : next;
    });
    setConfirming(null);
  }, [rows]);

  const approvableSelected = useMemo(
    () =>
      rows.filter((r) => selected.has(r.id) && r.status === "pending_approval"),
    [rows, selected],
  );
  const fulfillableSelected = useMemo(
    () => rows.filter((r) => selected.has(r.id) && r.status === "pending"),
    [rows, selected],
  );
  const actionableRows = useMemo(
    () => rows.filter((r) => isActionable(r.status)),
    [rows],
  );
  const allActionableSelected =
    actionableRows.length > 0 &&
    actionableRows.every((r) => selected.has(r.id));
  const someActionableSelected = actionableRows.some((r) =>
    selected.has(r.id),
  );

  const toggleRow = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setConfirming(null);
  };
  const toggleAll = () => {
    setConfirming(null);
    setSelected(
      allActionableSelected
        ? new Set()
        : new Set(actionableRows.map((r) => r.id)),
    );
  };

  async function runBulk(action: "approve" | "fulfill") {
    const targets = action === "approve" ? approvableSelected : fulfillableSelected;
    const ids = targets.map((r) => r.id);
    if (ids.length === 0) {
      setConfirming(null);
      return;
    }
    setBulkBusy(true);
    setNotice(null);
    // Optimistic: flip the affected rows immediately for a snappy "slide down
    // the list" feel; load() below reconciles with server truth.
    const optimisticStatus = action === "approve" ? "pending" : "fulfilled";
    setRows((prev) =>
      prev.map((r) =>
        ids.includes(r.id) ? { ...r, status: optimisticStatus } : r,
      ),
    );
    try {
      const r = await authFetch(
        `/api/school-store/redemptions/bulk-${action}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids }),
        },
      );
      const j = (await r.json().catch(() => ({}))) as {
        error?: string;
        summary?: { ok: number; failed: number };
      };
      if (!r.ok) {
        setNotice(j.error ?? "Bulk action failed.");
      } else if (j.summary && j.summary.failed > 0) {
        setNotice(
          `${j.summary.ok} done, ${j.summary.failed} skipped (already changed).`,
        );
      }
    } catch {
      setNotice("Bulk action failed.");
    } finally {
      setConfirming(null);
      setSelected(new Set());
      setBulkBusy(false);
      await load();
    }
  }

  async function act(redemptionId: number, action: "approve" | "fulfill") {
    setBusyId(redemptionId);
    try {
      const r = await authFetch(
        `/api/school-store/redemptions/${redemptionId}/${action}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: action === "fulfill" ? JSON.stringify({}) : undefined,
        },
      );
      if (r.ok) await load();
    } finally {
      setBusyId(null);
    }
  }

  const selectStyle: React.CSSProperties = {
    padding: "0.4rem 0.6rem",
    borderRadius: 8,
    border: "1px solid var(--border, #e2e8f0)",
    background: "var(--card, #fff)",
    color: "var(--text, #0f172a)",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: "0.78rem", color: "var(--muted, #64748b)" }}>
            Item
          </span>
          <select
            value={itemId}
            onChange={(e) => setItemId(e.target.value)}
            style={selectStyle}
          >
            <option value="">All items</option>
            {catalog.map((c) => (
              <option key={c.id} value={String(c.id)}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: "0.78rem", color: "var(--muted, #64748b)" }}>
            Status
          </span>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            style={selectStyle}
          >
            <option value="">All statuses</option>
            <option value="pending_approval">Needs approval</option>
            <option value="pending">Ready to prep</option>
            <option value="fulfilled">Fulfilled</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </label>
      </div>

      {notice && (
        <div
          style={{
            ...card,
            padding: "0.6rem 0.9rem",
            borderColor: "#fcd34d",
            background: "#fffbeb",
            color: "#92400e",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "0.75rem",
          }}
        >
          <span style={{ fontSize: "0.88rem" }}>{notice}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            style={{
              border: "none",
              background: "transparent",
              color: "#92400e",
              cursor: "pointer",
              fontWeight: 700,
            }}
          >
            ✕
          </button>
        </div>
      )}

      {someActionableSelected && (
        <div
          style={{
            position: "sticky",
            top: 8,
            zIndex: 5,
            ...card,
            padding: "0.6rem 0.9rem",
            background: "var(--card, #fff)",
            boxShadow: "0 4px 12px rgba(15,23,42,0.08)",
            display: "flex",
            alignItems: "center",
            gap: "0.75rem",
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontWeight: 600 }}>
            {selected.size} selected
          </span>
          {confirming === null ? (
            <>
              {approvableSelected.length > 0 && (
                <button
                  type="button"
                  disabled={bulkBusy}
                  onClick={() => setConfirming("approve")}
                  style={{
                    padding: "0.4rem 0.9rem",
                    borderRadius: 8,
                    border: "none",
                    background: "#2563eb",
                    color: "#fff",
                    fontWeight: 600,
                    cursor: bulkBusy ? "wait" : "pointer",
                  }}
                >
                  Approve {approvableSelected.length}
                </button>
              )}
              {fulfillableSelected.length > 0 && (
                <button
                  type="button"
                  disabled={bulkBusy}
                  onClick={() => setConfirming("fulfill")}
                  style={{
                    padding: "0.4rem 0.9rem",
                    borderRadius: 8,
                    border: "none",
                    background: "#15803d",
                    color: "#fff",
                    fontWeight: 600,
                    cursor: bulkBusy ? "wait" : "pointer",
                  }}
                >
                  Mark {fulfillableSelected.length} fulfilled
                </button>
              )}
              <button
                type="button"
                disabled={bulkBusy}
                onClick={() => setSelected(new Set())}
                style={{
                  padding: "0.4rem 0.8rem",
                  borderRadius: 8,
                  border: "1px solid var(--border, #e2e8f0)",
                  background: "transparent",
                  color: "var(--text, #0f172a)",
                  cursor: "pointer",
                }}
              >
                Clear
              </button>
            </>
          ) : (
            <>
              <span style={{ fontWeight: 600 }}>
                {confirming === "approve"
                  ? `Approve ${approvableSelected.length} redemption${approvableSelected.length === 1 ? "" : "s"}?`
                  : `Mark ${fulfillableSelected.length} redemption${fulfillableSelected.length === 1 ? "" : "s"} fulfilled?`}
              </span>
              <button
                type="button"
                disabled={bulkBusy}
                onClick={() => void runBulk(confirming)}
                style={{
                  padding: "0.4rem 0.9rem",
                  borderRadius: 8,
                  border: "none",
                  background: confirming === "approve" ? "#2563eb" : "#15803d",
                  color: "#fff",
                  fontWeight: 600,
                  cursor: bulkBusy ? "wait" : "pointer",
                }}
              >
                {bulkBusy ? "Working…" : "Confirm"}
              </button>
              <button
                type="button"
                disabled={bulkBusy}
                onClick={() => setConfirming(null)}
                style={{
                  padding: "0.4rem 0.8rem",
                  borderRadius: 8,
                  border: "1px solid var(--border, #e2e8f0)",
                  background: "transparent",
                  color: "var(--text, #0f172a)",
                  cursor: bulkBusy ? "wait" : "pointer",
                }}
              >
                Cancel
              </button>
            </>
          )}
        </div>
      )}

      {loading ? (
        <p style={{ color: "var(--muted, #64748b)" }}>Loading…</p>
      ) : error ? (
        <div style={card}>
          <p style={{ margin: 0, color: "#b91c1c" }}>{error}</p>
        </div>
      ) : rows.length === 0 ? (
        <div style={card}>
          <p style={{ margin: 0 }}>No redemptions match these filters.</p>
        </div>
      ) : (
        <div style={{ ...card, padding: 0, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr
                style={{
                  textAlign: "left",
                  color: "var(--muted, #64748b)",
                  fontSize: "0.82rem",
                }}
              >
                <th style={{ padding: "10px 12px", width: 36 }}>
                  <input
                    type="checkbox"
                    aria-label="Select all actionable rows"
                    checked={allActionableSelected}
                    disabled={actionableRows.length === 0}
                    ref={(el) => {
                      if (el)
                        el.indeterminate =
                          someActionableSelected && !allActionableSelected;
                    }}
                    onChange={toggleAll}
                    style={{ cursor: "pointer" }}
                  />
                </th>
                <th style={{ padding: "10px 12px" }}>Student</th>
                <th style={{ padding: "10px 12px" }}>SIS ID</th>
                <th style={{ padding: "10px 12px" }}>Item</th>
                <th style={{ padding: "10px 12px", textAlign: "right" }}>Pts</th>
                <th style={{ padding: "10px 12px" }}>Date</th>
                <th style={{ padding: "10px 12px" }}>Status</th>
                <th style={{ padding: "10px 12px" }}>Deliver to</th>
                <th style={{ padding: "10px 12px", textAlign: "right" }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  style={{
                    borderTop: "1px solid var(--border, #e2e8f0)",
                    background: selected.has(r.id)
                      ? "rgba(37,99,235,0.06)"
                      : undefined,
                  }}
                >
                  <td style={{ padding: "10px 12px" }}>
                    {isActionable(r.status) && (
                      <input
                        type="checkbox"
                        aria-label={`Select ${r.studentName}`}
                        checked={selected.has(r.id)}
                        onChange={() => toggleRow(r.id)}
                        style={{ cursor: "pointer" }}
                      />
                    )}
                  </td>
                  <td style={{ padding: "10px 12px" }}>
                    {r.studentName}
                    {r.grade !== null && (
                      <span style={{ color: "var(--muted, #64748b)" }}>
                        {" "}
                        (Gr {r.grade})
                      </span>
                    )}
                  </td>
                  <td style={{ padding: "10px 12px" }}>{idLabel(r.localSisId)}</td>
                  <td style={{ padding: "10px 12px" }}>{r.itemName}</td>
                  <td style={{ padding: "10px 12px", textAlign: "right" }}>
                    {r.pointsSpent}
                  </td>
                  <td
                    style={{
                      padding: "10px 12px",
                      whiteSpace: "nowrap",
                      color: "var(--muted, #64748b)",
                    }}
                  >
                    {fmtDate(r.createdAt)}
                  </td>
                  <td style={{ padding: "10px 12px" }}>
                    <StatusPill status={r.status} />
                  </td>
                  <td style={{ padding: "10px 12px" }}>
                    {r.deliverTeacherName
                      ? `${r.deliverTeacherName}${r.deliverPeriod ? ` · ${r.deliverPeriod}` : ""}`
                      : "—"}
                  </td>
                  <td style={{ padding: "10px 12px", textAlign: "right" }}>
                    {r.status === "pending_approval" && (
                      <button
                        type="button"
                        disabled={busyId === r.id}
                        onClick={() => void act(r.id, "approve")}
                        style={{
                          padding: "0.3rem 0.7rem",
                          borderRadius: 8,
                          border: "none",
                          background: "#2563eb",
                          color: "#fff",
                          fontWeight: 600,
                          cursor: busyId === r.id ? "wait" : "pointer",
                        }}
                      >
                        {busyId === r.id ? "…" : "Approve"}
                      </button>
                    )}
                    {r.status === "pending" && (
                      <button
                        type="button"
                        disabled={busyId === r.id}
                        onClick={() => void act(r.id, "fulfill")}
                        style={{
                          padding: "0.3rem 0.7rem",
                          borderRadius: 8,
                          border: "none",
                          background: "#15803d",
                          color: "#fff",
                          fontWeight: 600,
                          cursor: busyId === r.id ? "wait" : "pointer",
                        }}
                      >
                        {busyId === r.id ? "…" : "Mark fulfilled"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
