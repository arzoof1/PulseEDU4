// "My Interventions This Week" page. Lists every (student, tier) row
// the signed-in teacher still owes a log on for the current Mon-Fri
// week (Tier 2 weekly check-in + Tier 3 day-of-week scoring). Each
// row has a "Log now" button that opens the matching form via the
// LogInterventionLauncher (which the parent renders).
//
// Refreshing is delegated to the parent via onLogged so the bell badge
// also stays in sync.
import { useEffect, useState } from "react";
import { authFetch } from "../lib/authToken";
import { HowToUseHelp, HowToSection, RoleSection, howtoListStyle } from "./HowToUseHelp";

interface Tier2Row {
  studentId: string;
  studentName: string;
  grade: string | null;
  subType: string | null;
  planId: number;
}

interface Tier3Row {
  studentId: string;
  studentName: string;
  grade: string | null;
  planId: number;
  weekStartDate: string;
  missingDayCount: number;
}

interface OwedPayload {
  visible: boolean;
  todayDate: string;
  weekStartDate: string;
  tier2: Tier2Row[];
  tier3: Tier3Row[];
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
        // See InterventionsBell for why `cache: "no-store"` matters —
        // browser ETag revalidation otherwise yields a 304 with empty
        // body on re-mount and breaks the load.
        const r = await authFetch("/api/interventions/owed-today", {
          cache: "no-store",
        });
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

  const tier2 = payload?.tier2 ?? [];
  const tier3 = payload?.tier3 ?? [];
  const totalOwed = tier2.length + tier3.length;

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
        <h2 style={{ margin: 0 }}>My Interventions This Week</h2>
        <button type="button" onClick={onBack}>
          ← Back
        </button>
      </div>

      <HowToUseHelp title="How to use this week's interventions">
        <HowToSection title="What this page is">
          Your to-do list for the current Mon–Fri week. Each row is one
          (student, tier) combination you still owe a log on — Tier 2
          weekly check-ins and Tier 3 day-of-week scoring. Logging here
          marks the row complete and clears the bell badge.
        </HowToSection>
        <HowToSection title="How to log">
          <ul style={howtoListStyle}>
            <li>Click <strong>Log now</strong> next to any row to open the matching form.</li>
            <li>Tier 2 needs one entry per week per student; Tier 3 needs one per day per student.</li>
            <li>The page refreshes itself after each log so the count goes down in real time.</li>
          </ul>
        </HowToSection>
        <RoleSection for="teacher" title="If a row looks wrong">
          Talk to your MTSS Coordinator — they're the ones who assigned
          you the plan. Don't ignore the row; if a student transferred
          out, ask the coordinator to close the plan so it stops nagging.
        </RoleSection>
      </HowToUseHelp>

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

      {!loading && payload && totalOwed === 0 && (
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
          <h3 style={{ margin: "0 0 0.4rem 0" }}>
            Tier 2 — weekly check-in
            {payload?.weekStartDate
              ? ` · week of ${payload.weekStartDate}`
              : ""}
          </h3>
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
                  <div style={{ fontWeight: 600 }}>
                    {r.studentName}
                    {r.grade ? (
                      <span
                        style={{
                          color: "#64748b",
                          fontWeight: 400,
                          marginLeft: 6,
                        }}
                      >
                        · Grade {r.grade}
                      </span>
                    ) : null}
                  </div>
                  <div style={{ fontSize: "0.8rem", color: "#64748b" }}>
                    Tier 2 weekly
                    {r.subType
                      ? ` · ${r.subType === "cico" ? "Check-In/Check-Out" : "Behavior Group"}`
                      : ""}
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
                  <div style={{ fontWeight: 600 }}>
                    {r.studentName}
                    {r.grade ? (
                      <span
                        style={{
                          color: "#64748b",
                          fontWeight: 400,
                          marginLeft: 6,
                        }}
                      >
                        · Grade {r.grade}
                      </span>
                    ) : null}
                  </div>
                  <div style={{ fontSize: "0.8rem", color: "#64748b" }}>
                    Tier 3 weekly · week of {r.weekStartDate}
                    {r.missingDayCount > 0
                      ? ` · ${r.missingDayCount} day${r.missingDayCount === 1 ? "" : "s"} unscored`
                      : ""}
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
