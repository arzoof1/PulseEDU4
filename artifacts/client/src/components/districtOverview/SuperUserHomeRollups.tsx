// SuperUser Home — live cross-district rollup tiles. Replaces the
// placeholder PlaceholderCard grid. Three layers:
//   1) Four headline stat tiles (Districts / Schools / Students / Staff).
//   2) "Onboard a District" CTA that opens OnboardDistrictModal.
//   3) Per-district summary cards (school count, student count, staff
//      count, last-activity timestamp).
//
// Roadmap cards (Cross-District Reports, Global Feature Flags, Audit &
// Health) stay accessible inside a collapsed <details> below — the
// landing page leads with what works today.

import { useCallback, useEffect, useState } from "react";
import { authFetch } from "../../lib/authToken";
import OnboardDistrictModal from "./OnboardDistrictModal";

type DistrictSummary = {
  id: number;
  name: string;
  slug: string;
  stateDistrictCode: string | null;
  timezone: string;
  active: boolean;
  schoolCount: number;
  studentCount: number;
  staffCount: number;
  lastActivityAt: string | null;
};

type Overview = {
  totals: {
    districts: number;
    schools: number;
    students: number;
    staff: number;
  };
  districts: DistrictSummary[];
};

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div
      style={{
        border: "1px solid var(--border, #e2e8f0)",
        borderRadius: "var(--radius-sm, 8px)",
        background: "var(--surface, #fff)",
        padding: "0.85rem 1rem",
      }}
    >
      <div
        style={{
          fontSize: "0.75rem",
          color: "var(--text-subtle)",
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: "1.75rem", fontWeight: 700, marginTop: 4 }}>
        {value.toLocaleString()}
      </div>
    </div>
  );
}

function formatLastActivity(iso: string | null): string {
  if (!iso) return "No recent activity";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "No recent activity";
  const ms = Date.now() - d.getTime();
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  return d.toLocaleDateString();
}

export default function SuperUserHomeRollups() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showOnboard, setShowOnboard] = useState(false);

  const reload = useCallback(async () => {
    try {
      const res = await authFetch("/api/superuser/overview");
      if (!res.ok) throw new Error(`overview → ${res.status}`);
      setData((await res.json()) as Overview);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (error) {
    return (
      <div style={{ color: "#b91c1c", marginTop: "0.5rem" }}>
        Failed to load overview: {error}
      </div>
    );
  }
  if (!data) {
    return (
      <div style={{ color: "var(--text-subtle)", marginTop: "0.5rem" }}>
        Loading overview…
      </div>
    );
  }

  return (
    <div style={{ marginTop: "1rem" }}>
      {/* Headline stat tiles */}
      <div
        style={{
          display: "grid",
          gap: "0.75rem",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
        }}
      >
        <StatTile label="Districts" value={data.totals.districts} />
        <StatTile label="Schools" value={data.totals.schools} />
        <StatTile label="Students" value={data.totals.students} />
        <StatTile label="Staff" value={data.totals.staff} />
      </div>

      {/* Onboard CTA */}
      <div style={{ marginTop: "1rem", display: "flex", gap: "0.5rem" }}>
        <button
          type="button"
          onClick={() => setShowOnboard(true)}
          style={{
            padding: "0.55rem 1rem",
            border: "none",
            borderRadius: 6,
            background: "var(--primary, #2563eb)",
            color: "#fff",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          + Onboard a District
        </button>
        <button
          type="button"
          onClick={() => void reload()}
          style={{
            padding: "0.55rem 1rem",
            border: "1px solid var(--border, #e2e8f0)",
            borderRadius: 6,
            background: "var(--surface, #fff)",
            cursor: "pointer",
          }}
        >
          Refresh
        </button>
      </div>

      {/* Per-district summary cards */}
      <h3 style={{ marginTop: "1.5rem", marginBottom: "0.5rem" }}>Districts</h3>
      {data.districts.length === 0 ? (
        <p style={{ color: "var(--text-subtle)" }}>
          No districts yet. Click "Onboard a District" to create the first.
        </p>
      ) : (
        <div
          style={{
            display: "grid",
            gap: "0.75rem",
            gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          }}
        >
          {data.districts.map((d) => (
            <div
              key={d.id}
              style={{
                border: "1px solid var(--border, #e2e8f0)",
                borderRadius: "var(--radius-sm, 8px)",
                background: "var(--surface, #fff)",
                padding: "0.85rem 1rem",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <div style={{ fontWeight: 600 }}>{d.name}</div>
                {!d.active && (
                  <span
                    style={{
                      fontSize: "0.7rem",
                      color: "#b91c1c",
                      background: "#fee2e2",
                      padding: "0.1rem 0.4rem",
                      borderRadius: 4,
                    }}
                  >
                    Inactive
                  </span>
                )}
              </div>
              <div
                style={{
                  fontSize: "0.75rem",
                  color: "var(--text-subtle)",
                  marginTop: 2,
                }}
              >
                {d.slug}
                {d.stateDistrictCode ? ` · code ${d.stateDistrictCode}` : ""}
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(3, 1fr)",
                  gap: 8,
                  marginTop: "0.75rem",
                }}
              >
                <div>
                  <div style={{ fontSize: "0.7rem", color: "var(--text-subtle)" }}>
                    Schools
                  </div>
                  <div style={{ fontSize: "1.15rem", fontWeight: 600 }}>
                    {d.schoolCount.toLocaleString()}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: "0.7rem", color: "var(--text-subtle)" }}>
                    Students
                  </div>
                  <div style={{ fontSize: "1.15rem", fontWeight: 600 }}>
                    {d.studentCount.toLocaleString()}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: "0.7rem", color: "var(--text-subtle)" }}>
                    Staff
                  </div>
                  <div style={{ fontSize: "1.15rem", fontWeight: 600 }}>
                    {d.staffCount.toLocaleString()}
                  </div>
                </div>
              </div>
              <div
                style={{
                  marginTop: "0.75rem",
                  fontSize: "0.75rem",
                  color: "var(--text-subtle)",
                }}
              >
                Last activity: {formatLastActivity(d.lastActivityAt)}
              </div>
            </div>
          ))}
        </div>
      )}

      {showOnboard && (
        <OnboardDistrictModal
          onClose={() => setShowOnboard(false)}
          onCreated={() => {
            setShowOnboard(false);
            void reload();
          }}
        />
      )}
    </div>
  );
}
