// District Overview — per-school rollup for the caller's district.
// Replaces the District Admin landing placeholder grid. Shows district
// header + totals plus a per-school table (students, staff, PBIS pts
// last 7d, hall passes last 7d, ISS days last 7d) with a "Switch to
// this school" button on each row that reuses /api/tenancy/switch-school.

import { useCallback, useEffect, useState } from "react";
import { authFetch } from "../../lib/authToken";

type SchoolRow = {
  id: number;
  name: string;
  shortName: string | null;
  stateSchoolCode: string | null;
  isPrimary: boolean;
  studentCount: number;
  staffCount: number;
  pbisPoints7d: number;
  pbisEntries7d: number;
  hallPasses7d: number;
  issDays7d: number;
};

type Overview = {
  district: {
    id: number;
    name: string;
    slug: string;
    timezone: string;
  };
  totals: {
    schools: number;
    students: number;
    staff: number;
  };
  schools: SchoolRow[];
  // Server tells us whether the caller is allowed to invoke
  // /api/tenancy/switch-school (SuperUser-only today). District Admins
  // who lack the bit see the row without the "Switch to" action so the
  // demo doesn't surface a 403.
  caller: { isSuperUser: boolean };
};

function StatPill({ label, value }: { label: string; value: number }) {
  return (
    <div
      style={{
        border: "1px solid var(--border, #e2e8f0)",
        borderRadius: "var(--radius-sm, 8px)",
        background: "var(--surface, #fff)",
        padding: "0.75rem 1rem",
        minWidth: 110,
      }}
    >
      <div
        style={{
          fontSize: "0.7rem",
          color: "var(--text-subtle)",
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: "1.5rem", fontWeight: 700, marginTop: 2 }}>
        {value.toLocaleString()}
      </div>
    </div>
  );
}

export default function DistrictOverviewRollups() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState<number | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await authFetch("/api/district-admin/overview");
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

  async function switchTo(schoolId: number) {
    setSwitching(schoolId);
    try {
      const res = await authFetch("/api/tenancy/switch-school", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ schoolId }),
      });
      if (!res.ok) throw new Error(`switch → ${res.status}`);
      // Full reload so every cached query refetches under the new schoolId.
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSwitching(null);
    }
  }

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
      {/* District header */}
      <div style={{ marginBottom: "0.75rem" }}>
        <div style={{ fontSize: "1.15rem", fontWeight: 700 }}>
          {data.district.name}
        </div>
        <div style={{ fontSize: "0.75rem", color: "var(--text-subtle)" }}>
          {data.district.slug} · {data.district.timezone}
        </div>
      </div>

      {/* Totals */}
      <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
        <StatPill label="Schools" value={data.totals.schools} />
        <StatPill label="Students" value={data.totals.students} />
        <StatPill label="Active Staff" value={data.totals.staff} />
      </div>

      <div
        style={{ marginTop: "0.75rem", display: "flex", gap: "0.5rem" }}
      >
        <button
          type="button"
          onClick={() => void reload()}
          style={{
            padding: "0.45rem 0.85rem",
            border: "1px solid var(--border, #e2e8f0)",
            borderRadius: 6,
            background: "var(--surface, #fff)",
            cursor: "pointer",
          }}
        >
          Refresh
        </button>
      </div>

      {/* Per-school table */}
      <h3 style={{ marginTop: "1.5rem", marginBottom: "0.5rem" }}>
        Schools (last 7 days)
      </h3>
      {data.schools.length === 0 ? (
        <p style={{ color: "var(--text-subtle)" }}>No schools in district.</p>
      ) : (
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
                <th style={th}>School</th>
                <th style={thRight}>Students</th>
                <th style={thRight}>Staff</th>
                <th style={thRight}>PBIS pts (7d)</th>
                <th style={thRight}>Hall passes (7d)</th>
                <th style={thRight}>ISS days (7d)</th>
                {data.caller.isSuperUser && <th style={th}></th>}
              </tr>
            </thead>
            <tbody>
              {data.schools.map((s) => (
                <tr
                  key={s.id}
                  style={{ borderTop: "1px solid var(--border, #e2e8f0)" }}
                >
                  <td style={td}>
                    <div style={{ fontWeight: 600 }}>{s.name}</div>
                    <div
                      style={{
                        fontSize: "0.72rem",
                        color: "var(--text-subtle)",
                      }}
                    >
                      {s.shortName ?? "—"}
                      {s.isPrimary ? " · primary" : ""}
                      {s.stateSchoolCode ? ` · ${s.stateSchoolCode}` : ""}
                    </div>
                  </td>
                  <td style={tdRight}>{s.studentCount.toLocaleString()}</td>
                  <td style={tdRight}>{s.staffCount.toLocaleString()}</td>
                  <td style={tdRight}>{s.pbisPoints7d.toLocaleString()}</td>
                  <td style={tdRight}>{s.hallPasses7d.toLocaleString()}</td>
                  <td style={tdRight}>{s.issDays7d.toLocaleString()}</td>
                  {data.caller.isSuperUser && (
                    <td style={td}>
                      <button
                        type="button"
                        onClick={() => switchTo(s.id)}
                        disabled={switching !== null}
                        style={{
                          padding: "0.35rem 0.65rem",
                          border: "1px solid var(--border, #e2e8f0)",
                          borderRadius: 5,
                          background: "var(--surface, #fff)",
                          cursor:
                            switching !== null ? "not-allowed" : "pointer",
                          fontSize: "0.8rem",
                        }}
                      >
                        {switching === s.id ? "Switching…" : "Switch to"}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const th: React.CSSProperties = {
  padding: "0.5rem 0.75rem",
  textAlign: "left",
  fontSize: "0.75rem",
  textTransform: "uppercase",
  letterSpacing: 0.5,
  color: "var(--text-subtle)",
};
const thRight: React.CSSProperties = { ...th, textAlign: "right" };
const td: React.CSSProperties = {
  padding: "0.6rem 0.75rem",
  verticalAlign: "top",
};
const tdRight: React.CSSProperties = {
  ...td,
  textAlign: "right",
  fontVariantNumeric: "tabular-nums",
};
