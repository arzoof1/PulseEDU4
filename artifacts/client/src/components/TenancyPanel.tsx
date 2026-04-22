import { useEffect, useState } from "react";
import { authFetch } from "../lib/authToken";

interface DistrictRow {
  id: number;
  name: string;
  slug: string;
  stateDistrictCode: string | null;
  timezone: string;
  active: boolean;
}

interface SchoolRow {
  id: number;
  districtId: number;
  name: string;
  shortName: string | null;
  stateSchoolCode: string | null;
  isPrimary: boolean;
  active: boolean;
}

interface TenancyStatus {
  districts: DistrictRow[];
  schools: SchoolRow[];
  counts: Record<string, number>;
  perSchool: Record<string, Record<string, number>>;
  orphans: Record<string, number>;
  totalOrphans: number;
  perSchoolBreakdownAvailable: boolean;
}

const tableLabels: Record<string, string> = {
  students: "Students",
  staff: "Staff",
  hall_passes: "Hall passes",
  tardies: "Tardies",
  pbis_entries: "PBIS entries",
  pullouts: "Pullouts",
  accommodation_logs: "Accommodation logs",
  support_notes: "Support notes",
  intervention_entries: "Intervention entries",
  iss_roster: "ISS roster entries",
};

export default function TenancyPanel() {
  const [status, setStatus] = useState<TenancyStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await authFetch("/api/tenancy/status");
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body?.error ?? `HTTP ${r.status}`);
        }
        const data = (await r.json()) as TenancyStatus;
        if (!cancelled) setStatus(data);
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Failed to load tenancy");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="card" style={{ marginBottom: "1rem" }}>
        <h2 style={{ marginTop: 0 }}>Tenancy</h2>
        <p style={{ color: "var(--text-subtle)" }}>Loading…</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="card" style={{ marginBottom: "1rem" }}>
        <h2 style={{ marginTop: 0 }}>Tenancy</h2>
        <p style={{ color: "#b91c1c" }}>{error}</p>
      </div>
    );
  }
  if (!status) return null;

  const district = status.districts[0] ?? null;
  const schoolsForDistrict = district
    ? status.schools.filter((s) => s.districtId === district.id)
    : [];
  const orphansClean = status.totalOrphans === 0;

  const cellStyle = { padding: "0.4rem", textAlign: "right" as const };
  const headStyle = {
    padding: "0.4rem",
    textAlign: "right" as const,
    fontSize: 12,
    color: "var(--text-subtle)",
  };

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <h2 style={{ marginTop: 0 }}>Tenancy</h2>
      <p style={{ color: "var(--text-subtle)", marginTop: 0 }}>
        Districts and schools registered in this PulseEDU instance.
      </p>

      {district && (
        <section style={{ marginBottom: "1.25rem" }}>
          <div
            style={{
              display: "flex",
              gap: "0.75rem",
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <h3 style={{ margin: 0 }}>{district.name}</h3>
            <span
              style={{
                background: "#ede9fe",
                color: "#6d28d9",
                borderRadius: 999,
                padding: "0.1rem 0.6rem",
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              slug: {district.slug}
            </span>
            {district.stateDistrictCode && (
              <span
                style={{
                  background: "#e0f2fe",
                  color: "#0369a1",
                  borderRadius: 999,
                  padding: "0.1rem 0.6rem",
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                state district code: {district.stateDistrictCode}
              </span>
            )}
            <span
              style={{
                background: "#dcfce7",
                color: "#166534",
                borderRadius: 999,
                padding: "0.1rem 0.6rem",
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              tz: {district.timezone}
            </span>
          </div>
        </section>
      )}

      <section style={{ marginBottom: "1.25rem" }}>
        <h3 style={{ marginBottom: "0.5rem" }}>
          Schools ({schoolsForDistrict.length})
        </h3>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: "0.92rem",
          }}
        >
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border, #2a3447)" }}>
              <th style={{ textAlign: "left", padding: "0.4rem" }}>School</th>
              <th style={{ textAlign: "left", padding: "0.4rem" }}>Short</th>
              <th style={{ textAlign: "left", padding: "0.4rem" }}>
                State code
              </th>
              <th style={{ textAlign: "left", padding: "0.4rem" }}>Primary</th>
              <th style={{ textAlign: "left", padding: "0.4rem" }}>Active</th>
            </tr>
          </thead>
          <tbody>
            {schoolsForDistrict.map((s) => (
              <tr
                key={s.id}
                style={{ borderBottom: "1px solid var(--border, #2a3447)" }}
              >
                <td style={{ padding: "0.4rem", fontWeight: 600 }}>
                  {s.name}
                </td>
                <td style={{ padding: "0.4rem" }}>{s.shortName ?? "—"}</td>
                <td style={{ padding: "0.4rem" }}>
                  {s.stateSchoolCode ?? "—"}
                </td>
                <td style={{ padding: "0.4rem" }}>
                  {s.isPrimary ? (
                    <span
                      style={{
                        background: "#0d9488",
                        color: "white",
                        borderRadius: 999,
                        padding: "0.1rem 0.55rem",
                        fontSize: 11,
                        fontWeight: 700,
                      }}
                    >
                      PRIMARY
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td style={{ padding: "0.4rem" }}>
                  {s.active ? "Yes" : "No"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section style={{ marginBottom: "1.25rem" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.6rem",
            marginBottom: "0.5rem",
          }}
        >
          <h3 style={{ margin: 0 }}>Data integrity check</h3>
          <span
            style={{
              background: orphansClean ? "#dcfce7" : "#fee2e2",
              color: orphansClean ? "#166534" : "#991b1b",
              borderRadius: 999,
              padding: "0.15rem 0.7rem",
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            {orphansClean
              ? `✓ All records assigned to a school (0 orphans)`
              : `✗ ${status.totalOrphans} orphan rows`}
          </span>
        </div>
        {!orphansClean && (
          <p style={{ color: "#991b1b", marginTop: 0, fontSize: 13 }}>
            Tables with orphans:&nbsp;
            {Object.entries(status.orphans)
              .filter(([, n]) => n > 0)
              .map(([k, n]) => `${tableLabels[k] ?? k} (${n})`)
              .join(", ")}
            .
          </p>
        )}
      </section>

      <section style={{ marginBottom: "0.5rem" }}>
        <h3 style={{ marginBottom: "0.5rem" }}>Per-school row counts</h3>
        <p style={{ color: "var(--text-subtle)", marginTop: 0, fontSize: 13 }}>
          Day 2 has assigned every existing record to{" "}
          <strong>D. S. Parrott Middle School</strong>. New schools start with
          zero rows.
        </p>
        <div style={{ overflowX: "auto" }}>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: "0.9rem",
            }}
          >
            <thead>
              <tr
                style={{
                  borderBottom: "1px solid var(--border, #2a3447)",
                }}
              >
                <th style={{ textAlign: "left", padding: "0.4rem" }}>
                  Table
                </th>
                {schoolsForDistrict.map((s) => (
                  <th key={s.id} style={headStyle}>
                    {s.shortName ?? s.name}
                    {s.isPrimary ? " ★" : ""}
                  </th>
                ))}
                <th style={headStyle}>Total</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(status.counts).map(([key, total]) => (
                <tr
                  key={key}
                  style={{
                    borderBottom: "1px solid var(--border, #2a3447)",
                  }}
                >
                  <td style={{ padding: "0.4rem", fontWeight: 600 }}>
                    {tableLabels[key] ?? key}
                  </td>
                  {schoolsForDistrict.map((s) => {
                    const n = status.perSchool[key]?.[String(s.id)] ?? 0;
                    return (
                      <td
                        key={s.id}
                        style={{
                          ...cellStyle,
                          color:
                            n === 0 ? "var(--text-subtle)" : "inherit",
                        }}
                      >
                        {n.toLocaleString()}
                      </td>
                    );
                  })}
                  <td
                    style={{
                      ...cellStyle,
                      fontWeight: 700,
                    }}
                  >
                    {total.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
