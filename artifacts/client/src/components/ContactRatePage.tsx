import React, { useCallback, useEffect, useState } from "react";
import { authFetch } from "../lib/authToken";

// Insights → Contact Rate. Core Team / admin view of family-contact coverage:
// % reached in the last N days, % YTD, tone split, and a not-contacted
// worklist by responsible-period teacher. CSV + PDF export and a one-click
// "email teachers with incomplete calls" escalation.

type Row = {
  studentId: string;
  name: string;
  localSisId: string | null;
  grade: number | null;
  teacherName: string | null;
  reachable: boolean;
  contactedWindow: boolean;
  contactedYtd: boolean;
  positive: number;
  concern: number;
  lastContactedAt: string | null;
};

type Report = {
  windowDays: number;
  responsiblePeriod: number;
  generatedAt: string;
  rows: Row[];
  summary: {
    reachableTotal: number;
    contactedWindow: number;
    contactedYtd: number;
    windowRate: number;
    ytdRate: number;
    positive: number;
    concern: number;
    excluded: number;
  };
};

const WINDOW_OPTIONS = [7, 14, 30, 60, 90];

export default function ContactRatePage({ onBack }: { onBack: () => void }) {
  const [days, setDays] = useState(30);
  const [period, setPeriod] = useState(1);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [escalating, setEscalating] = useState(false);
  const [escalateMsg, setEscalateMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setEscalateMsg(null);
    authFetch(
      `/api/communications/contact-rate?days=${days}&period=${period}`,
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((j: Report | null) => setReport(j))
      .catch(() => setReport(null))
      .finally(() => setLoading(false));
  }, [days, period]);

  useEffect(() => {
    load();
  }, [load]);

  const download = async (kind: "csv" | "pdf") => {
    const path =
      kind === "csv"
        ? `/api/communications/contact-rate.csv?days=${days}&period=${period}`
        : `/api/communications/contact-rate/pdf?days=${days}&period=${period}`;
    const res = await authFetch(path);
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `contact-rate-${days}d.${kind}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };

  const escalate = async () => {
    setEscalating(true);
    setEscalateMsg(null);
    try {
      const res = await authFetch(
        `/api/communications/contact-rate/escalate?days=${days}&period=${period}`,
        { method: "POST" },
      );
      const j = await res.json().catch(() => null);
      if (!res.ok) {
        setEscalateMsg(j?.error ?? "Could not send emails.");
        return;
      }
      if ((j?.sent ?? 0) === 0 && (j?.teachers ?? 0) === 0) {
        setEscalateMsg("No teachers have outstanding calls — nothing to send.");
      } else {
        const parts = [`Emailed ${j.sent} teacher${j.sent === 1 ? "" : "s"}`];
        if (j.skipped) parts.push(`${j.skipped} skipped (no email on file)`);
        if (j.failed) parts.push(`${j.failed} failed`);
        setEscalateMsg(parts.join(" · "));
      }
    } catch {
      setEscalateMsg("Could not send emails.");
    } finally {
      setEscalating(false);
    }
  };

  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const s = report?.summary;
  const notContacted = (report?.rows ?? []).filter(
    (r) => r.reachable && !r.contactedWindow,
  );

  const statCard = (label: string, value: string, sub?: string) => (
    <div
      style={{
        flex: "1 1 160px",
        background: "var(--surface, #fff)",
        border: "1px solid var(--border, #e2e8f0)",
        borderRadius: "0.6rem",
        padding: "0.9rem 1rem",
      }}
    >
      <div style={{ fontSize: 12, color: "var(--text-subtle)", fontWeight: 600 }}>
        {label}
      </div>
      <div style={{ fontSize: 26, fontWeight: 800, color: "var(--text)" }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 12, color: "var(--text-subtle)" }}>{sub}</div>
      )}
    </div>
  );

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.5rem",
          flexWrap: "wrap",
        }}
      >
        <h2 style={{ margin: 0 }}>☎️ Contact Rate</h2>
        <button
          type="button"
          onClick={onBack}
          style={{
            border: "1px solid var(--border, #cbd5e1)",
            background: "transparent",
            borderRadius: "0.4rem",
            padding: "0.35rem 0.8rem",
            cursor: "pointer",
            color: "var(--text)",
          }}
        >
          ← Back to Insights
        </button>
      </div>
      <p style={{ color: "var(--text-subtle)", marginTop: "0.3rem" }}>
        Family-contact coverage across the school. Students with no reachable
        phone line are excluded from the rate.
      </p>

      <div
        style={{
          display: "flex",
          gap: "1rem",
          alignItems: "flex-end",
          flexWrap: "wrap",
          marginBottom: "1rem",
        }}
      >
        <label style={{ fontSize: 13 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Window</div>
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            style={{ padding: "0.4rem 0.6rem", borderRadius: "0.4rem" }}
          >
            {WINDOW_OPTIONS.map((d) => (
              <option key={d} value={d}>
                Last {d} days
              </option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: 13 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            Responsible period
          </div>
          <input
            type="number"
            min={1}
            max={12}
            value={period}
            onChange={(e) => setPeriod(Number(e.target.value))}
            style={{
              padding: "0.4rem 0.6rem",
              borderRadius: "0.4rem",
              width: 80,
            }}
          />
        </label>
        <button
          type="button"
          onClick={() => download("csv")}
          style={btnStyle("#0f766e")}
        >
          Export CSV
        </button>
        <button
          type="button"
          onClick={() => download("pdf")}
          style={btnStyle("#1d4ed8")}
        >
          Export PDF
        </button>
        <button
          type="button"
          onClick={escalate}
          disabled={escalating}
          style={btnStyle("#b45309")}
        >
          {escalating ? "Sending…" : "Email teachers with incomplete calls"}
        </button>
      </div>

      {escalateMsg && (
        <div
          style={{
            marginBottom: "1rem",
            padding: "0.6rem 0.8rem",
            background: "#fffbeb",
            border: "1px solid #fde68a",
            borderRadius: "0.5rem",
            color: "#92400e",
            fontSize: 13,
          }}
        >
          {escalateMsg}
        </div>
      )}

      {loading ? (
        <div style={{ color: "var(--text-subtle)" }}>Loading…</div>
      ) : !report || !s ? (
        <div style={{ color: "var(--text-subtle)" }}>
          Could not load the report.
        </div>
      ) : (
        <>
          <div
            style={{
              display: "flex",
              gap: "0.75rem",
              flexWrap: "wrap",
              marginBottom: "1.25rem",
            }}
          >
            {statCard(
              `Contacted (last ${days}d)`,
              pct(s.windowRate),
              `${s.contactedWindow} of ${s.reachableTotal} reachable`,
            )}
            {statCard(
              "Contacted YTD",
              pct(s.ytdRate),
              `${s.contactedYtd} of ${s.reachableTotal} reachable`,
            )}
            {statCard(
              "Tone",
              `${s.positive} / ${s.concern}`,
              "Positive / Concern",
            )}
            {statCard(
              "Excluded",
              String(s.excluded),
              "No reachable number",
            )}
          </div>

          <h3 style={{ marginBottom: "0.5rem" }}>
            Not contacted in last {days} days ({notContacted.length})
          </h3>
          {notContacted.length === 0 ? (
            <div style={{ color: "var(--text-subtle)" }}>
              Everyone reachable has been contacted in this window. 🎉
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: 13,
                }}
              >
                <thead>
                  <tr style={{ textAlign: "left", color: "var(--text-subtle)" }}>
                    <th style={thStyle}>Student</th>
                    <th style={thStyle}>ID</th>
                    <th style={thStyle}>Grade</th>
                    <th style={thStyle}>Responsible teacher (P{period})</th>
                    <th style={thStyle}>Last contact</th>
                  </tr>
                </thead>
                <tbody>
                  {notContacted.map((r) => (
                    <tr
                      key={r.studentId}
                      style={{ borderTop: "1px solid var(--border, #e2e8f0)" }}
                    >
                      <td style={tdStyle}>{r.name}</td>
                      <td style={tdStyle}>{r.localSisId ?? "—"}</td>
                      <td style={tdStyle}>{r.grade ?? "—"}</td>
                      <td style={tdStyle}>
                        {r.teacherName ?? (
                          <span style={{ color: "#b91c1c" }}>
                            No responsible teacher
                          </span>
                        )}
                      </td>
                      <td style={tdStyle}>
                        {r.lastContactedAt
                          ? new Date(r.lastContactedAt).toLocaleDateString()
                          : "Never"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const thStyle: React.CSSProperties = {
  padding: "0.4rem 0.6rem",
  fontWeight: 600,
};
const tdStyle: React.CSSProperties = {
  padding: "0.45rem 0.6rem",
  color: "var(--text)",
};
function btnStyle(bg: string): React.CSSProperties {
  return {
    border: "none",
    background: bg,
    color: "#fff",
    borderRadius: "0.4rem",
    padding: "0.45rem 0.9rem",
    cursor: "pointer",
    fontWeight: 600,
    fontSize: 13,
  };
}
