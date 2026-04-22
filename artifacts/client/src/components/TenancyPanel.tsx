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
  perSchoolBreakdownAvailable: boolean;
  note?: string;
}

const tableLabels: Record<string, string> = {
  students: "Students",
  staff: "Staff",
  hall_passes: "Hall passes (lifetime)",
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

      <section style={{ marginBottom: "1rem" }}>
        <h3 style={{ marginBottom: "0.5rem" }}>
          District-wide row counts (Day 1)
        </h3>
        <p style={{ color: "var(--text-subtle)", marginTop: 0, fontSize: 13 }}>
          Counts are global today. Day 2 adds <code>school_id</code> on every
          row and breaks these down per-school with an orphan check.
        </p>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
            gap: "0.5rem",
          }}
        >
          {Object.entries(status.counts).map(([key, n]) => (
            <div
              key={key}
              style={{
                padding: "0.6rem 0.75rem",
                border: "1px solid var(--border, #2a3447)",
                borderRadius: 8,
                background: "var(--card-bg, rgba(255,255,255,0.03))",
              }}
            >
              <div style={{ fontSize: 12, color: "var(--text-subtle)" }}>
                {tableLabels[key] ?? key}
              </div>
              <div style={{ fontSize: "1.4rem", fontWeight: 700 }}>
                {n.toLocaleString()}
              </div>
            </div>
          ))}
        </div>
      </section>

      {status.note && (
        <div
          style={{
            padding: "0.7rem 0.85rem",
            background: "#fef3c7",
            color: "#92400e",
            borderRadius: 8,
            fontSize: 13,
          }}
        >
          <strong>Next:</strong> {status.note}
        </div>
      )}
    </div>
  );
}
