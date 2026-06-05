// Admin-only AST Insights dashboard.
//
// Five panels in one round trip from /api/ast/insights:
//   1. Headline tiles — banked / earned YTD / used YTD
//   2. Top 5 balances + Top 5 earners YTD (side-by-side leaderboards)
//   3. By-category earned vs used (the only place admins see what kind
//      of work the AST bank is funding — categories are admin-only,
//      teachers never pick them)
//   4. By-month trend across the current school year
//   5. By role group earned vs used
//
// Visual aesthetic mirrors the other Insights pages (card grid, slate
// borders, blue accent, Recharts for the two charts).

import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { authFetch } from "../../lib/authToken";
import {
  HowToUseHelp,
  HowToSection,
  RoleSection,
  howtoListStyle,
} from "../HowToUseHelp";

type Insights = {
  schoolYearLabel: string;
  categories: readonly string[];
  totals: { bankedQh: number; earnedYtdQh: number; usedYtdQh: number };
  top5Balances: Array<{
    staffId: number;
    staffName: string;
    balanceQh: number;
  }>;
  top5Earners: Array<{
    staffId: number;
    staffName: string;
    earnedQh: number;
  }>;
  byCategory: Array<{
    category: string;
    earnedQh: number;
    usedQh: number;
  }>;
  byMonth: Array<{ month: string; earnedQh: number; usedQh: number }>;
  byRoleGroup: Array<{
    roleGroup: string;
    earnedQh: number;
    usedQh: number;
  }>;
};

const card: CSSProperties = {
  background: "white",
  border: "1px solid #e2e8f0",
  borderRadius: 10,
  padding: 16,
  marginBottom: 14,
};

function fmtHr(qh: number): string {
  return `${(qh / 4).toFixed(2)} hr`;
}

function HeadlineTile({
  label,
  qh,
  accent,
}: {
  label: string;
  qh: number;
  accent: string;
}) {
  return (
    <div
      style={{
        flex: 1,
        minWidth: 200,
        background: "white",
        border: "1px solid #e2e8f0",
        borderLeft: `4px solid ${accent}`,
        borderRadius: 10,
        padding: 16,
      }}
    >
      <div style={{ fontSize: "0.72rem", color: "#475569", letterSpacing: 0.4 }}>
        {label.toUpperCase()}
      </div>
      <div style={{ fontSize: "1.8rem", fontWeight: 700, color: "#0f172a" }}>
        {fmtHr(qh)}
      </div>
    </div>
  );
}

function Leaderboard({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ staffName: string; qh: number }>;
}) {
  return (
    <div style={{ ...card, flex: 1, minWidth: 280 }}>
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      {rows.length === 0 ? (
        <div style={{ color: "#64748b", fontSize: "0.9rem" }}>
          No data yet for this school year.
        </div>
      ) : (
        <ol style={{ paddingLeft: 20, margin: 0 }}>
          {rows.map((r, i) => (
            <li
              key={`${r.staffName}-${i}`}
              style={{
                padding: "6px 0",
                borderTop: i === 0 ? "none" : "1px solid #f1f5f9",
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
                fontSize: "0.9rem",
              }}
            >
              <span>{r.staffName}</span>
              <strong>{fmtHr(r.qh)}</strong>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export default function AstInsightsPage() {
  const [data, setData] = useState<Insights | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const r = await authFetch("/api/ast/insights", { cache: "no-store" });
      if (!r.ok) {
        if (r.status === 403) {
          setErr("You don't have permission to view AST Insights.");
          return;
        }
        throw new Error(`Failed to load (${r.status})`);
      }
      setData((await r.json()) as Insights);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (err) {
    return (
      <div style={{ padding: 16, maxWidth: 1100, margin: "0 auto" }}>
        <div
          style={{
            ...card,
            background: "#fef2f2",
            borderColor: "#fecaca",
            color: "#991b1b",
          }}
        >
          {err}
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div style={{ padding: 16, maxWidth: 1100, margin: "0 auto" }}>
        Loading…
      </div>
    );
  }

  // Convert quarter-hours to fractional hours for the charts so the
  // Y-axis reads in human units. Stored values stay integer everywhere
  // else.
  const monthData = data.byMonth.map((m) => ({
    month: m.month.slice(5), // "YYYY-MM" → "MM"
    Earned: m.earnedQh / 4,
    Used: m.usedQh / 4,
  }));
  const catData = data.byCategory.map((c) => ({
    category: c.category,
    Earned: c.earnedQh / 4,
    Used: c.usedQh / 4,
  }));
  const roleData = data.byRoleGroup.map((r) => ({
    role: r.roleGroup,
    Earned: r.earnedQh / 4,
    Used: r.usedQh / 4,
  }));

  return (
    <div style={{ padding: 16, maxWidth: 1100, margin: "0 auto" }}>
      <h1 style={{ marginTop: 0, fontSize: "1.5rem" }}>AST Insights</h1>
      <HowToUseHelp title="How to use AST Insights">
        <HowToSection title="What this page is">
          A read-only rollup of Alternate Schedule Time activity — balances,
          accrual, and usage across staff.
        </HowToSection>
        <HowToSection title="What to look for">
          <ul style={howtoListStyle}>
            <li>Outstanding balances ahead of the June 30 lapse.</li>
            <li>Accrual or usage patterns by staff group.</li>
            <li>Inputs for budgeting and bargaining-unit reporting.</li>
          </ul>
        </HowToSection>
        <RoleSection for={["admin", "coreTeam"]} title="Read-only">
          This page reports on AST — approvals still happen in the AST Approval
          Queue.
        </RoleSection>
      </HowToUseHelp>
      <p style={{ color: "#475569", marginTop: -8, fontSize: "0.9rem" }}>
        Alternate Schedule Time — school year {data.schoolYearLabel}. All
        figures are admin-only. Earned / Used totals span the current
        school year (Jul 1 → Jun 30); banked is the live bank across all
        staff.
      </p>

      {/* Headline tiles */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
        <HeadlineTile label="Banked total" qh={data.totals.bankedQh} accent="#0ea5e9" />
        <HeadlineTile label="Earned YTD" qh={data.totals.earnedYtdQh} accent="#16a34a" />
        <HeadlineTile label="Used YTD" qh={data.totals.usedYtdQh} accent="#f59e0b" />
      </div>

      {/* Leaderboards */}
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        <Leaderboard
          title="Top 5 balances (current bank)"
          rows={data.top5Balances.map((r) => ({
            staffName: r.staffName,
            qh: r.balanceQh,
          }))}
        />
        <Leaderboard
          title={`Top 5 earners (${data.schoolYearLabel})`}
          rows={data.top5Earners.map((r) => ({
            staffName: r.staffName,
            qh: r.earnedQh,
          }))}
        />
      </div>

      {/* By category */}
      <div style={card}>
        <h3 style={{ marginTop: 0 }}>By category</h3>
        <p style={{ fontSize: "0.82rem", color: "#475569", marginTop: -6 }}>
          What kinds of work the AST bank is funding this year. Set by
          admins at pre-approval time. Requests left blank or pre-dating
          this feature show as "Uncategorized".
        </p>
        {catData.length === 0 ? (
          <div style={{ color: "#64748b", fontSize: "0.9rem" }}>
            No earned or used activity yet this school year.
          </div>
        ) : (
          <div style={{ width: "100%", height: 300 }}>
            <ResponsiveContainer>
              <BarChart data={catData} margin={{ top: 8, right: 16, bottom: 24, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="category" tick={{ fontSize: 12 }} interval={0} angle={-12} textAnchor="end" height={60} />
                <YAxis tick={{ fontSize: 12 }} label={{ value: "hours", angle: -90, position: "insideLeft", fontSize: 12 }} />
                <Tooltip formatter={(v: number) => `${v.toFixed(2)} hr`} />
                <Legend />
                <Bar dataKey="Earned" fill="#16a34a" />
                <Bar dataKey="Used" fill="#f59e0b" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* By month */}
      <div style={card}>
        <h3 style={{ marginTop: 0 }}>By month</h3>
        <p style={{ fontSize: "0.82rem", color: "#475569", marginTop: -6 }}>
          Earn-confirm and use-approval activity per month so far this
          school year.
        </p>
        {monthData.length === 0 ? (
          <div style={{ color: "#64748b", fontSize: "0.9rem" }}>
            No activity yet this school year.
          </div>
        ) : (
          <div style={{ width: "100%", height: 280 }}>
            <ResponsiveContainer>
              <BarChart data={monthData} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} label={{ value: "hours", angle: -90, position: "insideLeft", fontSize: 12 }} />
                <Tooltip formatter={(v: number) => `${v.toFixed(2)} hr`} />
                <Legend />
                <Bar dataKey="Earned" fill="#16a34a" />
                <Bar dataKey="Used" fill="#f59e0b" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* By role group */}
      <div style={card}>
        <h3 style={{ marginTop: 0 }}>By role group</h3>
        <p style={{ fontSize: "0.82rem", color: "#475569", marginTop: -6 }}>
          Bucketed from staff role flags (highest-priority role wins —
          a teacher who is also a dean is grouped under "Core Team").
        </p>
        {roleData.length === 0 ? (
          <div style={{ color: "#64748b", fontSize: "0.9rem" }}>
            No activity yet this school year.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
            <thead>
              <tr style={{ background: "#f8fafc" }}>
                <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #e2e8f0" }}>Group</th>
                <th style={{ textAlign: "right", padding: 8, borderBottom: "1px solid #e2e8f0" }}>Earned</th>
                <th style={{ textAlign: "right", padding: 8, borderBottom: "1px solid #e2e8f0" }}>Used</th>
              </tr>
            </thead>
            <tbody>
              {roleData.map((r) => (
                <tr key={r.role}>
                  <td style={{ padding: 8, borderBottom: "1px solid #f1f5f9" }}>{r.role}</td>
                  <td style={{ padding: 8, textAlign: "right", borderBottom: "1px solid #f1f5f9", color: "#16a34a" }}>
                    {r.Earned.toFixed(2)} hr
                  </td>
                  <td style={{ padding: 8, textAlign: "right", borderBottom: "1px solid #f1f5f9", color: "#92400e" }}>
                    {r.Used.toFixed(2)} hr
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
