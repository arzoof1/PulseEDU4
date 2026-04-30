// "My Interventions Today" page. Lists every (student, tier) row the
// signed-in teacher still owes a log on for today (Tier 2) or this week
// (Tier 3 day-of-week). Each row has a "Log now" button that opens the
// matching form via the LogInterventionLauncher (which the parent
// renders).
//
// Refreshing is delegated to the parent via onLogged so the bell badge
// also stays in sync.
import { useEffect, useState } from "react";
import { authFetch } from "../lib/authToken";

interface OwedRow {
  studentId: string;
  studentName: string;
  tier: 2 | 3;
  reason: string; // "Tier 2 daily" | "Tier 3 — Mon"
  weekStartDate?: string;
}

interface OwedPayload {
  visible: boolean;
  totalOwed: number;
  rows: OwedRow[];
}

interface Props {
  refreshKey: number;
  onLog: (
    studentId: string,
    mode: "tier2" | "tier3",
    weekStartDate?: string,
  ) => void;
  onBack: () => void;
}

export default function InterventionsTodayPage({
  refreshKey,
  onLog,
  onBack,
}: Props) {
  const [payload, setPayload] = useState<OwedPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const r = await authFetch("/api/interventions/owed-today");
        if (!r.ok) throw new Error(await r.text());
        const data = (await r.json()) as OwedPayload;
        if (!cancelled) setPayload(data);
      } catch (e) {
        if (!cancelled)
          setErr(e instanceof Error ? e.message : "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const tier2 = payload?.rows.filter((r) => r.tier === 2) ?? [];
  const tier3 = payload?.rows.filter((r) => r.tier === 3) ?? [];

  return (
    <section style={{ padding: "1rem", maxWidth: 880 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "1rem",
        }}
      >
        <h2 style={{ margin: 0 }}>My Interventions Today</h2>
        <button type="button" onClick={onBack}>
          ← Back
        </button>
      </div>

      {loading && <div style={{ color: "#64748b" }}>Loading…</div>}
      {err && (
        <div
          style={{
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#b91c1c",
            padding: "0.5rem 0.7rem",
            borderRadius: 6,
            marginBottom: "0.75rem",
          }}
        >
          {err}
        </div>
      )}

      {!loading && payload && payload.totalOwed === 0 && (
        <div
          style={{
            padding: "1rem",
            background: "#ecfdf5",
            border: "1px solid #a7f3d0",
            color: "#047857",
            borderRadius: 8,
          }}
        >
          ✅ All caught up — no interventions owed right now.
        </div>
      )}

      {tier2.length > 0 && (
        <div style={{ marginBottom: "1.25rem" }}>
          <h3 style={{ margin: "0 0 0.4rem 0" }}>Tier 2 — daily</h3>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {tier2.map((r) => (
              <li
                key={`t2-${r.studentId}`}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "0.5rem 0.7rem",
                  border: "1px solid #e2e8f0",
                  borderRadius: 6,
                  marginBottom: 6,
                }}
              >
                <div>
                  <div style={{ fontWeight: 600 }}>{r.studentName}</div>
                  <div style={{ fontSize: "0.8rem", color: "#64748b" }}>
                    {r.reason}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onLog(r.studentId, "tier2")}
                  style={{
                    background: "#2563eb",
                    color: "white",
                    border: "none",
                    padding: "0.4rem 0.7rem",
                    borderRadius: 6,
                    cursor: "pointer",
                  }}
                >
                  Log now
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {tier3.length > 0 && (
        <div>
          <h3 style={{ margin: "0 0 0.4rem 0" }}>Tier 3 — weekly</h3>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {tier3.map((r) => (
              <li
                key={`t3-${r.studentId}`}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "0.5rem 0.7rem",
                  border: "1px solid #e2e8f0",
                  borderRadius: 6,
                  marginBottom: 6,
                }}
              >
                <div>
                  <div style={{ fontWeight: 600 }}>{r.studentName}</div>
                  <div style={{ fontSize: "0.8rem", color: "#64748b" }}>
                    {r.reason}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    onLog(r.studentId, "tier3", r.weekStartDate)
                  }
                  style={{
                    background: "#2563eb",
                    color: "white",
                    border: "none",
                    padding: "0.4rem 0.7rem",
                    borderRadius: 6,
                    cursor: "pointer",
                  }}
                >
                  Log now
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
