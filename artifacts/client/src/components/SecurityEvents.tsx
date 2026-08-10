import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { authFetch } from "../lib/authToken";

// Security Events viewer (Section 3 — Logging & Monitoring). Read-only table
// over the server-side auth_audit_log, scoped to the admin's active school.
// Shows the authentication / privileged-action trail written by the auth + MFA
// flows (enrollment, login-challenge outcomes, recovery-code use, force-logout,
// MFA reset, policy changes). Admin-gated by the server endpoint.

type AuditEvent = {
  id: number;
  action: string;
  actorStaffId: number | null;
  actorName: string | null;
  targetStaffId: number | null;
  targetName: string | null;
  ip: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
};

type AuditResponse = { events: AuditEvent[]; actions: string[] };

// "mfa_login_success" -> "MFA login success"
function humanizeAction(action: string): string {
  const s = action.replace(/_/g, " ").replace(/\bmfa\b/gi, "MFA");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function summarizePayload(payload: Record<string, unknown> | null): string {
  if (!payload || typeof payload !== "object") return "";
  const entries = Object.entries(payload);
  if (entries.length === 0) return "";
  return entries
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(", ");
}

const th: CSSProperties = {
  textAlign: "left",
  padding: "8px 10px",
  borderBottom: "2px solid #e2e8f0",
  fontSize: 12,
  color: "#475569",
  whiteSpace: "nowrap",
};
const td: CSSProperties = {
  padding: "8px 10px",
  borderBottom: "1px solid #f1f5f9",
  fontSize: 13,
  verticalAlign: "top",
};

export default function SecurityEvents() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [actions, setActions] = useState<string[]>([]);
  const [action, setAction] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ limit: "200" });
      if (action) params.set("action", action);
      const res = await authFetch(`/api/admin/audit-log?${params.toString()}`);
      if (!res.ok) {
        throw new Error(
          res.status === 403
            ? "You don't have access to the security log."
            : `Failed to load (${res.status})`,
        );
      }
      const data = (await res.json()) as AuditResponse;
      setEvents(Array.isArray(data.events) ? data.events : []);
      // Keep the dropdown list stable across filtered reloads: only replace it
      // when we fetched the unfiltered set (server returns all actions anyway).
      if (Array.isArray(data.actions) && data.actions.length > 0) {
        setActions((prev) =>
          action ? prev : data.actions,
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, [action]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div style={{ padding: "8px 4px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 12,
        }}
      >
        <div>
          <h2 style={{ margin: 0 }}>Security Events</h2>
          <p style={{ margin: "4px 0 0", color: "#64748b", fontSize: 13 }}>
            Authentication and privileged-action audit trail for this school.
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <select
            value={action}
            onChange={(e) => setAction(e.target.value)}
            style={{ padding: "6px 8px", fontSize: 13, borderRadius: 6 }}
          >
            <option value="">All events</option>
            {actions.map((a) => (
              <option key={a} value={a}>
                {humanizeAction(a)}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            style={{ padding: "6px 12px", fontSize: 13, cursor: "pointer" }}
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          style={{
            background: "#fee2e2",
            color: "#991b1b",
            padding: 10,
            borderRadius: 6,
            fontSize: 13,
            marginBottom: 10,
          }}
        >
          {error}
        </div>
      )}

      {!error && !loading && events.length === 0 && (
        <div style={{ color: "#64748b", fontSize: 14, padding: "16px 4px" }}>
          No security events recorded yet.
        </div>
      )}

      {events.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <th style={th}>When</th>
                <th style={th}>Event</th>
                <th style={th}>Actor</th>
                <th style={th}>Target</th>
                <th style={th}>IP</th>
                <th style={th}>Details</th>
              </tr>
            </thead>
            <tbody>
              {events.map((ev) => (
                <tr key={ev.id}>
                  <td style={{ ...td, whiteSpace: "nowrap" }}>
                    {formatWhen(ev.createdAt)}
                  </td>
                  <td style={td}>{humanizeAction(ev.action)}</td>
                  <td style={td}>
                    {ev.actorName ??
                      (ev.actorStaffId ? `#${ev.actorStaffId}` : "—")}
                  </td>
                  <td style={td}>
                    {ev.targetName ??
                      (ev.targetStaffId ? `#${ev.targetStaffId}` : "—")}
                  </td>
                  <td style={{ ...td, fontFamily: "monospace", fontSize: 12 }}>
                    {ev.ip ?? "—"}
                  </td>
                  <td style={{ ...td, color: "#475569", fontSize: 12 }}>
                    {summarizePayload(ev.payload) || "—"}
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
