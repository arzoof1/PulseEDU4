// =============================================================================
// HousesPanel — admin tooling for PBIS house placement.
//
// Two sub-tabs on top of the existing live "House Rankings" signage screen
// (mounted by the parent caller in App.tsx):
//   1. Bulk sort — preview / commit / 24h undo of an even house re-balance
//      across the school's roster. Keeps siblings together by default.
//   2. Recent changes — append-only audit log of who moved which student
//      to which house, when, and why (or the bulk sort job tag).
//
// All endpoints under /api/houses/sort/* and /api/houses/changes are
// admin/superuser-only on the server; this panel mirrors that with a
// soft-fail empty state so non-admins accidentally pointed here see a
// friendly message instead of a 403 toast.
// =============================================================================
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/authToken";

type House = { id: number; name: string; color: string };

type PreviewResp = {
  ok: boolean;
  includeAssigned: boolean;
  keepSiblings: boolean;
  houses: House[];
  currentCounts: Record<string, number>;
  proposedCounts: Record<string, number>;
  totalEligible: number;
  totalChanged: number;
};

type ChangesResp = {
  rows: Array<{
    id: number;
    studentDbId: number;
    fromHouseId: number | null;
    toHouseId: number;
    reason: string;
    source: "manual" | "bulk_sort" | "undo";
    sortJobId: number | null;
    changedAt: string;
    changedByStaffId: number;
  }>;
  houses: House[];
  staff: Array<{ id: number; displayName: string }>;
  students: Array<{
    id: number;
    studentId: string;
    firstName: string;
    lastName: string;
  }>;
  undoable: {
    jobId: number;
    committedAt: string;
    affectedCount: number;
    expiresAt: string;
  } | null;
};

function pillStyle(color: string): React.CSSProperties {
  return {
    display: "inline-block",
    padding: "0.15rem 0.55rem",
    borderRadius: 999,
    background: color || "#e5e7eb",
    color: "#0f172a",
    fontSize: "0.78rem",
    fontWeight: 700,
    border: "1px solid rgba(15,23,42,0.12)",
  };
}

export default function HousesPanel(): React.ReactElement {
  const [tab, setTab] = useState<"sort" | "audit">("sort");
  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: "1rem" }}>
        <button
          type="button"
          className={tab === "sort" ? "btn primary" : "btn"}
          onClick={() => setTab("sort")}
        >
          Bulk sort
        </button>
        <button
          type="button"
          className={tab === "audit" ? "btn primary" : "btn"}
          onClick={() => setTab("audit")}
        >
          Recent changes
        </button>
      </div>
      {tab === "sort" ? <SortTab /> : <AuditTab />}
    </div>
  );
}

function SortTab(): React.ReactElement {
  const [includeAssigned, setIncludeAssigned] = useState(false);
  const [keepSiblings, setKeepSiblings] = useState(true);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResp | null>(null);
  const [committing, setCommitting] = useState(false);
  const [lastCommit, setLastCommit] = useState<{
    affectedCount: number;
    jobId: number | null;
  } | null>(null);

  const runPreview = useCallback(async () => {
    setLoading(true);
    setErr(null);
    setLastCommit(null);
    try {
      const res = await authFetch("/api/houses/sort/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ includeAssigned, keepSiblings }),
      });
      const body = (await res.json()) as PreviewResp & { error?: string };
      if (!res.ok) {
        setErr(body.error ?? `Preview failed (${res.status})`);
        setPreview(null);
        return;
      }
      setPreview(body);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Preview failed");
    } finally {
      setLoading(false);
    }
  }, [includeAssigned, keepSiblings]);

  const runCommit = useCallback(async () => {
    if (!preview) return;
    if (
      !window.confirm(
        `Apply this sort? ${preview.totalChanged} student${
          preview.totalChanged === 1 ? "" : "s"
        } will be reassigned. You'll have 24 hours to undo.`,
      )
    )
      return;
    setCommitting(true);
    setErr(null);
    try {
      const res = await authFetch("/api/houses/sort/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ includeAssigned, keepSiblings }),
      });
      const body = (await res.json()) as {
        ok: boolean;
        affectedCount: number;
        jobId: number | null;
        error?: string;
      };
      if (!res.ok) {
        setErr(body.error ?? `Commit failed (${res.status})`);
        return;
      }
      setLastCommit({
        affectedCount: body.affectedCount,
        jobId: body.jobId,
      });
      setPreview(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Commit failed");
    } finally {
      setCommitting(false);
    }
  }, [preview, includeAssigned, keepSiblings]);

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Bulk house placement</h3>
      <p style={{ color: "#475569", marginTop: 0 }}>
        Re-balance students across PBIS houses. Preview the proposed sort,
        then commit. You can undo any commit within 24 hours from the
        Recent changes tab.
      </p>
      <div
        style={{
          display: "flex",
          gap: "1.25rem",
          flexWrap: "wrap",
          margin: "0.75rem 0",
        }}
      >
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type="checkbox"
            checked={includeAssigned}
            onChange={(e) => setIncludeAssigned(e.target.checked)}
          />
          Include students already assigned to a house
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type="checkbox"
            checked={keepSiblings}
            onChange={(e) => setKeepSiblings(e.target.checked)}
          />
          Keep siblings together
        </label>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          className="btn primary"
          disabled={loading}
          onClick={runPreview}
        >
          {loading ? "Computing…" : "Preview sort"}
        </button>
        {preview && preview.totalChanged > 0 && (
          <button
            type="button"
            className="btn primary"
            disabled={committing}
            onClick={runCommit}
            style={{ background: "#0f766e" }}
          >
            {committing ? "Applying…" : `Commit (${preview.totalChanged})`}
          </button>
        )}
      </div>
      {err && (
        <div
          style={{
            marginTop: "0.75rem",
            color: "#991b1b",
            background: "#fee2e2",
            border: "1px solid #fecaca",
            padding: "0.5rem 0.75rem",
            borderRadius: 6,
          }}
        >
          {err}
        </div>
      )}
      {lastCommit && (
        <div
          style={{
            marginTop: "0.75rem",
            color: "#166534",
            background: "#dcfce7",
            border: "1px solid #bbf7d0",
            padding: "0.5rem 0.75rem",
            borderRadius: 6,
          }}
        >
          Reassigned {lastCommit.affectedCount} student
          {lastCommit.affectedCount === 1 ? "" : "s"}. Undo available for
          24 hours on the Recent changes tab.
        </div>
      )}
      {preview && (
        <div style={{ marginTop: "1rem" }}>
          <h4 style={{ marginBottom: "0.5rem" }}>
            Proposed counts &middot; {preview.totalChanged} change
            {preview.totalChanged === 1 ? "" : "s"} out of{" "}
            {preview.totalEligible} eligible
          </h4>
          {preview.houses.length === 0 ? (
            <p style={{ color: "#475569" }}>
              No PBIS houses configured for this school yet.
            </p>
          ) : (
            <table
              style={{
                borderCollapse: "collapse",
                width: "100%",
                maxWidth: 520,
              }}
            >
              <thead>
                <tr style={{ textAlign: "left", color: "#475569" }}>
                  <th style={{ padding: "4px 8px" }}>House</th>
                  <th style={{ padding: "4px 8px" }}>Current</th>
                  <th style={{ padding: "4px 8px" }}>Proposed</th>
                  <th style={{ padding: "4px 8px" }}>Δ</th>
                </tr>
              </thead>
              <tbody>
                {preview.houses.map((h) => {
                  const cur = preview.currentCounts[h.id] ?? 0;
                  const nxt = preview.proposedCounts[h.id] ?? 0;
                  const delta = nxt - cur;
                  return (
                    <tr key={h.id} style={{ borderTop: "1px solid #e5e7eb" }}>
                      <td style={{ padding: "6px 8px" }}>
                        <span style={pillStyle(h.color)}>{h.name}</span>
                      </td>
                      <td style={{ padding: "6px 8px" }}>{cur}</td>
                      <td style={{ padding: "6px 8px" }}>{nxt}</td>
                      <td
                        style={{
                          padding: "6px 8px",
                          color:
                            delta > 0
                              ? "#166534"
                              : delta < 0
                                ? "#991b1b"
                                : "#475569",
                          fontWeight: 600,
                        }}
                      >
                        {delta > 0 ? `+${delta}` : delta}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

function AuditTab(): React.ReactElement {
  const [data, setData] = useState<ChangesResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [undoing, setUndoing] = useState(false);
  // Recent-changes filter: empty string = "All houses". Server-side
  // ?houseId=X narrows to bulk + manual moves that landed in that
  // house; "All" returns the unfiltered 200-row feed.
  const [houseFilter, setHouseFilter] = useState<string>("");
  // Snapshot of all houses for the filter dropdown. Loaded once
  // from /api/houses (separate from /houses/changes, which only
  // returns the houses referenced by the visible rows).
  const [houseOptions, setHouseOptions] = useState<House[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const url = houseFilter
        ? `/api/houses/changes?houseId=${encodeURIComponent(houseFilter)}`
        : "/api/houses/changes";
      const res = await authFetch(url);
      const body = (await res.json()) as ChangesResp & { error?: string };
      if (!res.ok) {
        setErr(body.error ?? `Load failed (${res.status})`);
        return;
      }
      setData(body);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, [houseFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  // Load the full house list once for the filter dropdown.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await authFetch("/api/houses");
        if (!res.ok) return;
        const body = (await res.json()) as { houses?: House[] };
        if (!cancelled && body.houses) setHouseOptions(body.houses);
      } catch {
        // non-fatal — filter just won't render
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const lookups = useMemo(() => {
    if (!data) {
      return {
        house: new Map<number, House>(),
        staff: new Map<number, string>(),
        student: new Map<
          number,
          { studentId: string; firstName: string; lastName: string }
        >(),
      };
    }
    return {
      house: new Map(data.houses.map((h) => [h.id, h])),
      staff: new Map(data.staff.map((s) => [s.id, s.displayName])),
      student: new Map(
        data.students.map((s) => [
          s.id,
          {
            studentId: s.studentId,
            firstName: s.firstName,
            lastName: s.lastName,
          },
        ]),
      ),
    };
  }, [data]);

  const undoLast = useCallback(async () => {
    if (!data?.undoable) return;
    const u = data.undoable;
    if (
      !window.confirm(
        `Undo the last bulk sort? ${u.affectedCount} student${
          u.affectedCount === 1 ? "" : "s"
        } will be restored to their previous house.`,
      )
    )
      return;
    setUndoing(true);
    setErr(null);
    try {
      const res = await authFetch(`/api/houses/sort/undo/${u.jobId}`, {
        method: "POST",
      });
      const body = (await res.json()) as {
        ok: boolean;
        restored: number;
        error?: string;
      };
      if (!res.ok) {
        setErr(body.error ?? `Undo failed (${res.status})`);
        return;
      }
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Undo failed");
    } finally {
      setUndoing(false);
    }
  }, [data, load]);

  if (loading) return <div className="card">Loading audit log…</div>;
  if (err)
    return (
      <div
        className="card"
        style={{ color: "#991b1b", background: "#fee2e2" }}
      >
        {err}
      </div>
    );
  if (!data) return <div className="card">No data.</div>;

  return (
    <div className="card">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          flexWrap: "wrap",
          gap: "1rem",
        }}
      >
        <div>
          <h3 style={{ marginTop: 0 }}>Recent house changes</h3>
          <p style={{ color: "#475569", marginTop: 0 }}>
            Most recent 200 entries. Manual changes show the reason
            entered by the editor; bulk sorts are tagged with the sort
            job they belong to.
          </p>
          {houseOptions.length > 0 && (
            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.5rem",
                fontSize: "0.875rem",
                color: "#475569",
              }}
            >
              Filter by house:
              <select
                value={houseFilter}
                onChange={(e) => setHouseFilter(e.target.value)}
                style={{
                  padding: "4px 8px",
                  border: "1px solid #cbd5e1",
                  borderRadius: 4,
                }}
              >
                <option value="">All houses</option>
                {houseOptions.map((h) => (
                  <option key={h.id} value={String(h.id)}>
                    {h.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {data.undoable && (
          <button
            type="button"
            className="btn"
            disabled={undoing}
            onClick={undoLast}
            style={{
              background: "#fef3c7",
              border: "1px solid #fcd34d",
              color: "#78350f",
              fontWeight: 600,
            }}
          >
            {undoing
              ? "Undoing…"
              : `Undo last sort (${data.undoable.affectedCount}, expires ${new Date(
                  data.undoable.expiresAt,
                ).toLocaleString()})`}
          </button>
        )}
      </div>
      {data.rows.length === 0 ? (
        <p style={{ color: "#475569" }}>No house changes recorded yet.</p>
      ) : (
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#475569" }}>
              <th style={{ padding: "6px 8px" }}>When</th>
              <th style={{ padding: "6px 8px" }}>Student</th>
              <th style={{ padding: "6px 8px" }}>From → To</th>
              <th style={{ padding: "6px 8px" }}>Reason</th>
              <th style={{ padding: "6px 8px" }}>By</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => {
              const stu = lookups.student.get(r.studentDbId);
              const from =
                r.fromHouseId == null
                  ? null
                  : (lookups.house.get(r.fromHouseId) ?? null);
              const to = lookups.house.get(r.toHouseId) ?? null;
              const by = lookups.staff.get(r.changedByStaffId) ?? "—";
              return (
                <tr key={r.id} style={{ borderTop: "1px solid #e5e7eb" }}>
                  <td
                    style={{
                      padding: "6px 8px",
                      whiteSpace: "nowrap",
                      color: "#475569",
                    }}
                  >
                    {new Date(r.changedAt).toLocaleString()}
                  </td>
                  <td style={{ padding: "6px 8px" }}>
                    {stu
                      ? `${stu.firstName} ${stu.lastName} (${stu.studentId})`
                      : `#${r.studentDbId}`}
                  </td>
                  <td style={{ padding: "6px 8px" }}>
                    {from ? (
                      <span style={pillStyle(from.color)}>{from.name}</span>
                    ) : (
                      <span style={{ color: "#94a3b8" }}>— none —</span>
                    )}
                    <span style={{ margin: "0 6px", color: "#94a3b8" }}>→</span>
                    {to ? (
                      <span style={pillStyle(to.color)}>{to.name}</span>
                    ) : (
                      <span style={{ color: "#94a3b8" }}>—</span>
                    )}
                  </td>
                  <td style={{ padding: "6px 8px" }}>
                    {r.reason}
                    {r.source === "bulk_sort" && r.sortJobId != null && (
                      <span style={{ color: "#94a3b8" }}>
                        {" "}
                        · job #{r.sortJobId}
                      </span>
                    )}
                    {r.source === "undo" && (
                      <span style={{ color: "#94a3b8" }}> · undo</span>
                    )}
                  </td>
                  <td style={{ padding: "6px 8px" }}>{by}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
