// SuperUser Audit & Health panel — replaces the "Audit & Health" roadmap
// tile. Two sections:
//   1) Per-district health snapshot (schools active / inactive, active
//      staff, audit events in last 7d).
//   2) Recent activity timeline — the last 25 mutating admin events
//      across the three audit tables we keep today (feature licensing,
//      ISS admin log, interaction/case lifecycle).
//
// Data source: /api/superuser/audit-health. Scope follows the same env
// gate as /superuser/overview — defaults to the caller's district.

import { useCallback, useEffect, useState } from "react";
import { authFetch } from "../../lib/authToken";

type DistrictHealth = {
  districtId: number;
  name: string;
  schoolsActive: number;
  schoolsInactive: number;
  staffActive: number;
  auditEvents7d: number;
};

type Event = {
  at: string;
  source: "feature_licensing" | "iss_admin" | "interaction";
  action: string;
  schoolId: number;
  schoolName: string | null;
  districtId: number | null;
  districtName: string | null;
  actorStaffId: number | null;
  actorName: string | null;
};

type Payload = {
  perDistrict: DistrictHealth[];
  recentEvents: Event[];
};

const SOURCE_LABEL: Record<Event["source"], string> = {
  feature_licensing: "Feature licensing",
  iss_admin: "ISS admin",
  interaction: "Case / interaction",
};

function relativeTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const ms = Date.now() - d.getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString();
}

export default function AuditHealthPanel() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch("/api/superuser/audit-health");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as Payload);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (error) {
    return (
      <div style={{ color: "#b91c1c", marginTop: "0.5rem" }}>
        Failed to load audit & health: {error}
      </div>
    );
  }
  if (!data) {
    return (
      <div style={{ color: "var(--text-subtle)", marginTop: "0.5rem" }}>
        Loading audit & health…
      </div>
    );
  }

  return (
    <div style={{ marginTop: "1.5rem" }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: "0.5rem",
        }}
      >
        <h3 style={{ margin: 0 }}>Audit & Health</h3>
        <button
          type="button"
          onClick={() => void reload()}
          disabled={loading}
          style={{
            padding: "0.35rem 0.75rem",
            border: "1px solid var(--border, #e2e8f0)",
            borderRadius: 6,
            background: "var(--surface, #fff)",
            cursor: loading ? "not-allowed" : "pointer",
            fontSize: "0.8rem",
          }}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {/* Per-district health */}
      <div style={{ overflowX: "auto" }}>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: "0.9rem",
          }}
        >
          <thead>
            <tr style={{ background: "var(--surface-muted, #f8fafc)" }}>
              <th style={th}>District</th>
              <th style={thRight}>Schools active</th>
              <th style={thRight}>Schools inactive</th>
              <th style={thRight}>Active staff</th>
              <th style={thRight}>Admin events (7d)</th>
            </tr>
          </thead>
          <tbody>
            {data.perDistrict.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  style={{
                    ...td,
                    color: "var(--text-subtle)",
                    textAlign: "center",
                  }}
                >
                  No districts in scope.
                </td>
              </tr>
            ) : (
              data.perDistrict.map((d) => (
                <tr
                  key={d.districtId}
                  style={{ borderTop: "1px solid var(--border, #e2e8f0)" }}
                >
                  <td style={td}>{d.name}</td>
                  <td style={tdRight}>{d.schoolsActive.toLocaleString()}</td>
                  <td
                    style={{
                      ...tdRight,
                      color: d.schoolsInactive > 0 ? "#b45309" : undefined,
                    }}
                  >
                    {d.schoolsInactive.toLocaleString()}
                  </td>
                  <td style={tdRight}>{d.staffActive.toLocaleString()}</td>
                  <td style={tdRight}>{d.auditEvents7d.toLocaleString()}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Recent activity timeline */}
      <h4 style={{ marginTop: "1.25rem", marginBottom: "0.5rem" }}>
        Recent admin activity
      </h4>
      {data.recentEvents.length === 0 ? (
        <p
          style={{
            color: "var(--text-subtle)",
            fontSize: "0.85rem",
            marginTop: 0,
          }}
        >
          No audit events recorded yet.
        </p>
      ) : (
        <ul
          style={{
            listStyle: "none",
            padding: 0,
            margin: 0,
            border: "1px solid var(--border, #e2e8f0)",
            borderRadius: 8,
            background: "var(--surface, #fff)",
            maxHeight: 360,
            overflowY: "auto",
          }}
        >
          {data.recentEvents.map((e, idx) => (
            <li
              key={`${e.source}-${e.at}-${idx}`}
              style={{
                padding: "0.5rem 0.75rem",
                borderTop:
                  idx === 0 ? "none" : "1px solid var(--border, #e2e8f0)",
                display: "grid",
                gridTemplateColumns: "auto 1fr auto",
                gap: "0.75rem",
                alignItems: "baseline",
                fontSize: "0.85rem",
              }}
            >
              <span
                style={{
                  fontSize: "0.7rem",
                  color: "var(--text-subtle)",
                  fontFamily: "ui-monospace, monospace",
                  whiteSpace: "nowrap",
                }}
              >
                {relativeTime(e.at)}
              </span>
              <span>
                <span style={{ fontWeight: 600 }}>{e.action}</span>{" "}
                <span style={{ color: "var(--text-subtle)" }}>
                  · {SOURCE_LABEL[e.source]}
                </span>
                <div
                  style={{
                    fontSize: "0.75rem",
                    color: "var(--text-subtle)",
                    marginTop: 2,
                  }}
                >
                  {e.districtName ?? "—"}
                  {e.schoolName ? ` › ${e.schoolName}` : ""}
                  {e.actorName ? ` · by ${e.actorName}` : ""}
                </div>
              </span>
              <span
                style={{
                  fontSize: "0.7rem",
                  color: "var(--text-subtle)",
                  fontFamily: "ui-monospace, monospace",
                  whiteSpace: "nowrap",
                }}
                title={e.at}
              >
                {new Date(e.at).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const th: React.CSSProperties = {
  padding: "0.5rem 0.75rem",
  textAlign: "left",
  fontSize: "0.72rem",
  textTransform: "uppercase",
  letterSpacing: 0.5,
  color: "var(--text-subtle)",
};
const thRight: React.CSSProperties = { ...th, textAlign: "right" };
const td: React.CSSProperties = {
  padding: "0.55rem 0.75rem",
  verticalAlign: "top",
};
const tdRight: React.CSSProperties = {
  ...td,
  textAlign: "right",
  fontVariantNumeric: "tabular-nums",
};
