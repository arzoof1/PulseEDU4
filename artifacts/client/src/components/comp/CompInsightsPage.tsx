// Comp Time admin insights — mirror of AstInsightsPage. Shows total
// banked, paid-out 12-month total, near-cap staff count, top-5 balances,
// and a 12-month earned-vs-used trend.

import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { authFetch } from "../../lib/authToken";
import {
  HowToUseHelp,
  HowToSection,
  RoleSection,
  howtoListStyle,
} from "../HowToUseHelp";

type Insights = {
  capQuarterHours: number;
  totals: {
    bankedQh: number;
    paidOut12moQh: number;
    staffNearCap: number;
  };
  top5Balances: { staffId: number; staffName: string; balanceQh: number }[];
  byMonth: { month: string; earnedQh: number; usedQh: number }[];
};

const card: CSSProperties = {
  background: "white",
  border: "1px solid #e2e8f0",
  borderRadius: 10,
  padding: 16,
  marginBottom: 14,
};

function formatHours(qh: number): string {
  return `${(qh / 4).toFixed(2)} hr`;
}

export default function CompInsightsPage() {
  const [data, setData] = useState<Insights | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const r = await authFetch("/api/comp/insights", { cache: "no-store" });
      if (!r.ok) throw new Error(`Failed to load (${r.status})`);
      setData((await r.json()) as Insights);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!data) {
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

  const maxMonthQh = Math.max(
    1,
    ...data.byMonth.flatMap((m) => [m.earnedQh, m.usedQh]),
  );

  return (
    <div style={{ padding: 16, maxWidth: 1100, margin: "0 auto" }}>
      <h1 style={{ marginTop: 0, fontSize: "1.5rem" }}>Comp Time Insights</h1>
      <HowToUseHelp title="How to use Comp Time Insights">
        <HowToSection title="What this page is">
          A read-only rollup of compensatory-time balances, accrual, and usage
          across non-exempt staff.
        </HowToSection>
        <HowToSection title="What to look for">
          <ul style={howtoListStyle}>
            <li>Banks approaching the 240-hour cap.</li>
            <li>Accrual trends for budgeting and payroll planning.</li>
          </ul>
        </HowToSection>
        <RoleSection for={["admin", "coreTeam"]} title="Read-only">
          This page reports on comp time — approvals still happen in Comp Time
          Approvals.
        </RoleSection>
      </HowToUseHelp>
      <p style={{ color: "#475569", marginTop: -8, fontSize: "0.9rem" }}>
        Schoolwide comp-time totals, top balances, and a 12-month trend. The
        FLSA cap is {formatHours(data.capQuarterHours)} per employee.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 14,
          marginBottom: 14,
        }}
      >
        <div style={{ ...card, marginBottom: 0 }}>
          <div style={{ fontSize: "0.72rem", color: "#64748b" }}>
            TOTAL BANKED
          </div>
          <div style={{ fontSize: "1.8rem", fontWeight: 700 }}>
            {formatHours(data.totals.bankedQh)}
          </div>
        </div>
        <div style={{ ...card, marginBottom: 0 }}>
          <div style={{ fontSize: "0.72rem", color: "#64748b" }}>
            PAID OUT (LAST 12 MO)
          </div>
          <div style={{ fontSize: "1.8rem", fontWeight: 700 }}>
            {formatHours(data.totals.paidOut12moQh)}
          </div>
        </div>
        <div
          style={{
            ...card,
            marginBottom: 0,
            background: data.totals.staffNearCap > 0 ? "#fef9c3" : "white",
            borderColor: data.totals.staffNearCap > 0 ? "#fde68a" : "#e2e8f0",
          }}
        >
          <div style={{ fontSize: "0.72rem", color: "#92400e" }}>
            STAFF WITHIN 10% OF CAP
          </div>
          <div style={{ fontSize: "1.8rem", fontWeight: 700 }}>
            {data.totals.staffNearCap}
          </div>
          {data.totals.staffNearCap > 0 && (
            <div style={{ fontSize: "0.78rem", color: "#92400e" }}>
              Pay down via payroll before they hit 240 h.
            </div>
          )}
        </div>
      </div>

      <div style={card}>
        <h3 style={{ marginTop: 0 }}>Top 5 balances</h3>
        {data.top5Balances.length === 0 ? (
          <div style={{ color: "#64748b" }}>No banked balances yet.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#64748b" }}>
                <th style={{ padding: 6 }}>Staff</th>
                <th style={{ padding: 6, textAlign: "right" }}>Balance</th>
                <th style={{ padding: 6, textAlign: "right" }}>% of cap</th>
              </tr>
            </thead>
            <tbody>
              {data.top5Balances.map((r) => (
                <tr key={r.staffId} style={{ borderTop: "1px solid #f1f5f9" }}>
                  <td style={{ padding: 6 }}>{r.staffName}</td>
                  <td style={{ padding: 6, textAlign: "right" }}>
                    {formatHours(r.balanceQh)}
                  </td>
                  <td style={{ padding: 6, textAlign: "right" }}>
                    {Math.round((r.balanceQh / data.capQuarterHours) * 100)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div style={card}>
        <h3 style={{ marginTop: 0 }}>Earned vs Used — last 12 months</h3>
        {data.byMonth.length === 0 ? (
          <div style={{ color: "#64748b" }}>No activity yet.</div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "100px 1fr 1fr",
              rowGap: 4,
              fontSize: "0.82rem",
            }}
          >
            <div style={{ fontWeight: 600 }}>Month</div>
            <div style={{ fontWeight: 600, color: "#15803d" }}>Earned</div>
            <div style={{ fontWeight: 600, color: "#b91c1c" }}>Used</div>
            {data.byMonth.map((m) => (
              <div key={m.month} style={{ display: "contents" }}>
                <div>{m.month}</div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <div
                    style={{
                      background: "#86efac",
                      height: 10,
                      width: `${(m.earnedQh / maxMonthQh) * 100}%`,
                      borderRadius: 4,
                    }}
                  />
                  <span>{formatHours(m.earnedQh)}</span>
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <div
                    style={{
                      background: "#fca5a5",
                      height: 10,
                      width: `${(m.usedQh / maxMonthQh) * 100}%`,
                      borderRadius: 4,
                    }}
                  />
                  <span>{formatHours(m.usedQh)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
