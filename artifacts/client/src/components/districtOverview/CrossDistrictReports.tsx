// CrossDistrictReports — Phase 5 SuperUser Home tile that surfaces 7-day
// activity rollups per district. Backed by
// GET /api/superuser/cross-district-reports. Gracefully degrades to a
// single-district report when ALLOW_CROSS_DISTRICT_SUPERUSER is not set.

import { useEffect, useState } from "react";
import { authFetch } from "../../lib/authToken";

type DistrictReport = {
  id: number;
  name: string;
  schoolCount: number;
  pbisPoints7d: number;
  hallPasses7d: number;
  issDays7d: number;
  interventions7d: number;
};

type ReportResponse = {
  windowDays: number;
  crossDistrict: boolean;
  perDistrict: DistrictReport[];
};

const fmt = (n: number) => n.toLocaleString();

export function CrossDistrictReports() {
  const [data, setData] = useState<ReportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    authFetch("/api/superuser/cross-district-reports")
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as ReportResponse;
      })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div
        style={{
          marginTop: "1.25rem",
          padding: "0.75rem 1rem",
          border: "1px solid var(--border, #e2e8f0)",
          borderRadius: 8,
          color: "#a00",
          fontSize: "0.85rem",
        }}
      >
        Cross-District Reports failed to load: {error}
      </div>
    );
  }
  if (!data) {
    return (
      <div
        style={{
          marginTop: "1.25rem",
          padding: "0.75rem 1rem",
          color: "var(--text-subtle)",
          fontSize: "0.85rem",
        }}
      >
        Loading cross-district reports…
      </div>
    );
  }

  return (
    <div
      style={{
        marginTop: "1.25rem",
        border: "1px solid var(--border, #e2e8f0)",
        borderRadius: 8,
        background: "var(--surface, #fff)",
        padding: "0.85rem 1rem",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: "1rem" }}>
          Cross-District Reports
        </h3>
        <span style={{ fontSize: "0.75rem", color: "var(--text-subtle)" }}>
          last {data.windowDays} days
          {!data.crossDistrict && " · single district (set ALLOW_CROSS_DISTRICT_SUPERUSER=1 to span all)"}
        </span>
      </div>

      {data.perDistrict.length === 0 ? (
        <div
          style={{
            marginTop: "0.5rem",
            color: "var(--text-subtle)",
            fontSize: "0.85rem",
          }}
        >
          No districts to report on.
        </div>
      ) : (
        <div style={{ overflowX: "auto", marginTop: "0.5rem" }}>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: "0.85rem",
            }}
          >
            <thead>
              <tr style={{ textAlign: "left", color: "var(--text-subtle)" }}>
                <th style={{ padding: "0.4rem 0.5rem" }}>District</th>
                <th style={{ padding: "0.4rem 0.5rem", textAlign: "right" }}>Schools</th>
                <th style={{ padding: "0.4rem 0.5rem", textAlign: "right" }}>PBIS pts</th>
                <th style={{ padding: "0.4rem 0.5rem", textAlign: "right" }}>Hall passes</th>
                <th style={{ padding: "0.4rem 0.5rem", textAlign: "right" }}>ISS days</th>
                <th style={{ padding: "0.4rem 0.5rem", textAlign: "right" }}>Interventions</th>
              </tr>
            </thead>
            <tbody>
              {data.perDistrict.map((d) => (
                <tr
                  key={d.id}
                  style={{ borderTop: "1px solid var(--border, #e2e8f0)" }}
                >
                  <td style={{ padding: "0.4rem 0.5rem" }}>{d.name}</td>
                  <td style={{ padding: "0.4rem 0.5rem", textAlign: "right" }}>{fmt(d.schoolCount)}</td>
                  <td style={{ padding: "0.4rem 0.5rem", textAlign: "right" }}>{fmt(d.pbisPoints7d)}</td>
                  <td style={{ padding: "0.4rem 0.5rem", textAlign: "right" }}>{fmt(d.hallPasses7d)}</td>
                  <td style={{ padding: "0.4rem 0.5rem", textAlign: "right" }}>{fmt(d.issDays7d)}</td>
                  <td style={{ padding: "0.4rem 0.5rem", textAlign: "right" }}>{fmt(d.interventions7d)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default CrossDistrictReports;
