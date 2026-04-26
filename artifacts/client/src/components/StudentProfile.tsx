// Student Profile — eduCLIMBER-style whole-child page. Header (name,
// grade, demographics, MTSS tier), 5 pillar cards (academics, behavior,
// flow, supports, family), and a risk callout rail.
//
// Backed by GET /api/insights/students/:studentId/profile. The server
// enforces visibility (roster ∪ trusted-adult ∪ core team) and returns
// 403 if the caller can't see this student. We surface that gracefully.

import { useEffect, useState } from "react";
import { authFetch } from "../lib/authToken";

type WindowKey = "3" | "7" | "15" | "30" | "custom";

interface ProfilePayload {
  header: {
    studentId: string;
    firstName: string;
    lastName: string;
    grade: number;
    gender: string | null;
    flags: {
      ell: boolean;
      ese: boolean;
      is504: boolean;
      ctEla: boolean;
      ctMath: boolean;
    };
    mtssTier: number;
    activeMtssPlanCount: number;
    visibilityPath: "core" | "roster" | "trusted_adult";
  };
  window: { from: string; to: string; label: string; days: number | null };
  pillars: {
    academics: {
      fastScores: Array<{
        subject: string;
        pm1: number | null;
        pm2: number | null;
        pm3: number | null;
        priorYearScore: number | null;
        priorYearBq: boolean;
      }>;
      assessments: Array<{
        name: string;
        score: number | null;
        scoreLevel: string | null;
        administeredAt: string;
        source: string | null;
      }>;
    };
    behavior: {
      pbisPositiveCount: number;
      pbisNegativeCount: number;
      supportNoteCount: number;
      recentSupportNotes: Array<{
        noteType: string;
        noteText: string;
        staffName: string;
        createdAt: string;
      }>;
      recentPbis: Array<{
        polarity: string;
        reason: string;
        staffName: string;
        createdAt: string;
        points: number;
      }>;
    };
    flow: {
      tardyCount: number;
      recentTardies: Array<{
        period: string;
        reason: string;
        createdAt: string;
      }>;
      issDayCount: number;
      recentIssDays: Array<{ day: string; source: string; notes: string | null }>;
      hallPassCount: number;
      hallPassSchoolAvg: number;
      recentPullouts: Array<{
        requestedAt: string;
        reason: string;
        status: string;
        referringTeacherName: string;
      }>;
    };
    supports: {
      activeAccommodationCount: number;
      accommodations: Array<{ id: number; label: string | null; assignedAt: string }>;
      recentInterventions: Array<{
        interventionType: string;
        note: string | null;
        staffName: string;
        createdAt: string;
      }>;
      activeMtssPlans: Array<{
        id: number;
        title: string;
        tier: number;
        openedAt: string;
        goals: string;
      }>;
      trustedAdults: Array<{ id: number; staffId: number; staffName: string | null }>;
    };
    family: {
      parentName: string | null;
      parentEmail: string | null;
      parentPhone: string | null;
      linkedParentAccountCount: number;
    };
  };
  riskFlags: Array<{
    code: string;
    severity: "info" | "watch" | "high";
    label: string;
  }>;
}

const SEVERITY_STYLES: Record<
  "info" | "watch" | "high",
  { background: string; color: string; border: string }
> = {
  high: { background: "#fee2e2", color: "#991b1b", border: "#fca5a5" },
  watch: { background: "#fef3c7", color: "#92400e", border: "#fcd34d" },
  info: { background: "#e0e7ff", color: "#3730a3", border: "#c7d2fe" },
};

function Chip({
  label,
  sev,
}: {
  label: string;
  sev: "info" | "watch" | "high";
}) {
  const s = SEVERITY_STYLES[sev];
  return (
    <span
      style={{
        display: "inline-block",
        padding: "0.15rem 0.55rem",
        background: s.background,
        color: s.color,
        border: `1px solid ${s.border}`,
        borderRadius: 999,
        fontSize: "0.75rem",
        fontWeight: 600,
        marginRight: 4,
        marginBottom: 4,
      }}
    >
      {label}
    </span>
  );
}

function Card({
  title,
  children,
  empty,
}: {
  title: string;
  children: React.ReactNode;
  empty?: boolean;
}) {
  return (
    <div
      style={{
        background: "white",
        border: "1px solid #e5e7eb",
        borderRadius: 8,
        padding: "1rem",
      }}
    >
      <h3 style={{ marginTop: 0, marginBottom: "0.5rem", fontSize: "1rem" }}>
        {title}
      </h3>
      {empty ? (
        <div style={{ color: "#9ca3af", fontSize: "0.9rem" }}>
          No data in this window.
        </div>
      ) : (
        children
      )}
    </div>
  );
}

interface Props {
  studentId: string;
  onBack: () => void;
}

export default function StudentProfile({ studentId, onBack }: Props) {
  const [data, setData] = useState<ProfilePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [windowKey, setWindowKey] = useState<WindowKey>("30");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  useEffect(() => {
    setLoading(true);
    setError("");
    let cancelled = false;
    const params = new URLSearchParams();
    params.set("window", windowKey);
    if (windowKey === "custom") {
      if (customFrom) params.set("from", customFrom);
      if (customTo) params.set("to", customTo);
    }
    authFetch(
      `/api/insights/students/${encodeURIComponent(studentId)}/profile?${params.toString()}`,
    )
      .then(async (r) => {
        if (r.status === 403) throw new Error("You don't have access to this student.");
        if (r.status === 404) throw new Error("Student not found.");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((p: ProfilePayload) => {
        if (!cancelled) setData(p);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message ?? "Failed to load profile");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [studentId, windowKey, customFrom, customTo]);

  if (loading) {
    return (
      <div className="card" style={{ marginBottom: "1rem" }}>
        <button type="button" onClick={onBack} style={{ marginBottom: "0.5rem" }}>
          ← Back to Watchlist
        </button>
        <p style={{ color: "var(--text-subtle)" }}>Loading profile…</p>
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="card" style={{ marginBottom: "1rem" }}>
        <button type="button" onClick={onBack} style={{ marginBottom: "0.5rem" }}>
          ← Back to Watchlist
        </button>
        <p style={{ color: "#991b1b" }}>{error ?? "Failed to load."}</p>
      </div>
    );
  }

  const { header, pillars, riskFlags, window: win } = data;

  return (
    <div style={{ display: "grid", gap: "0.75rem", marginBottom: "1rem" }}>
      {/* Top bar — back + window picker */}
      <div className="card" style={{ marginBottom: 0 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "0.5rem",
          }}
        >
          <button
            type="button"
            onClick={onBack}
            style={{
              background: "transparent",
              border: "1px solid #d1d5db",
              padding: "0.3rem 0.75rem",
              borderRadius: 6,
              cursor: "pointer",
            }}
          >
            ← Back to Watchlist
          </button>
          <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
            <span style={{ color: "#6b7280", fontSize: "0.85rem" }}>Window:</span>
            {(["3", "7", "15", "30", "custom"] as WindowKey[]).map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => setWindowKey(w)}
                style={{
                  padding: "0.2rem 0.55rem",
                  border: "1px solid",
                  borderColor: windowKey === w ? "#0d9488" : "#d1d5db",
                  background: windowKey === w ? "#0d9488" : "white",
                  color: windowKey === w ? "white" : "#374151",
                  borderRadius: 999,
                  fontSize: "0.78rem",
                  cursor: "pointer",
                  fontWeight: 600,
                }}
              >
                {w === "custom" ? "Custom" : `${w}d`}
              </button>
            ))}
            {windowKey === "custom" && (
              <>
                <input
                  type="date"
                  value={customFrom}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  style={{ padding: "0.15rem" }}
                />
                <span>→</span>
                <input
                  type="date"
                  value={customTo}
                  onChange={(e) => setCustomTo(e.target.value)}
                  style={{ padding: "0.15rem" }}
                />
              </>
            )}
            <span style={{ color: "#6b7280", fontSize: "0.78rem" }}>({win.label})</span>
          </div>
        </div>
      </div>

      {/* Header card */}
      <div className="card" style={{ marginBottom: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "1rem" }}>
          <div>
            <h2 style={{ margin: 0 }}>
              {header.firstName} {header.lastName}
            </h2>
            <div style={{ color: "#6b7280", marginBottom: 6 }}>
              Grade {header.grade}
              {header.gender && <> &middot; {header.gender}</>}
              <> &middot; {header.studentId}</>
            </div>
            <div>
              {header.flags.ell && <Chip label="ELL" sev="info" />}
              {header.flags.ese && <Chip label="ESE" sev="info" />}
              {header.flags.is504 && <Chip label="504" sev="info" />}
              {header.flags.ctEla && <Chip label="CT ELA" sev="info" />}
              {header.flags.ctMath && <Chip label="CT Math" sev="info" />}
              {header.mtssTier === 1 ? (
                <Chip label="Tier 1 (no plan)" sev="info" />
              ) : (
                <Chip label={`MTSS Tier ${header.mtssTier}`} sev={header.mtssTier === 3 ? "high" : "watch"} />
              )}
              {header.activeMtssPlanCount > 0 && (
                <Chip
                  label={`${header.activeMtssPlanCount} active plan${header.activeMtssPlanCount === 1 ? "" : "s"}`}
                  sev="watch"
                />
              )}
            </div>
          </div>
          <div style={{ fontSize: "0.78rem", color: "#9ca3af", textAlign: "right" }}>
            Visibility:{" "}
            {header.visibilityPath === "core"
              ? "Core team"
              : header.visibilityPath === "roster"
              ? "Your class roster"
              : "Trusted-adult assignment"}
          </div>
        </div>
      </div>

      {/* Risk callout rail */}
      {riskFlags.length > 0 && (
        <div className="card" style={{ marginBottom: 0 }}>
          <h3 style={{ margin: "0 0 0.5rem 0", fontSize: "1rem" }}>Things to know</h3>
          <div>
            {riskFlags.map((f) => (
              <Chip key={f.code} label={f.label} sev={f.severity} />
            ))}
          </div>
        </div>
      )}

      {/* Pillars grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: "0.75rem",
        }}
      >
        <Card title="Academics" empty={pillars.academics.fastScores.length === 0 && pillars.academics.assessments.length === 0}>
          {pillars.academics.fastScores.length > 0 && (
            <div style={{ marginBottom: "0.5rem" }}>
              <div style={{ fontWeight: 600, fontSize: "0.85rem", marginBottom: 4 }}>
                FAST PM
              </div>
              <table style={{ width: "100%", fontSize: "0.85rem" }}>
                <thead>
                  <tr style={{ color: "#6b7280" }}>
                    <th style={{ textAlign: "left" }}>Subject</th>
                    <th style={{ textAlign: "right" }}>PM1</th>
                    <th style={{ textAlign: "right" }}>PM2</th>
                    <th style={{ textAlign: "right" }}>PM3</th>
                    <th style={{ textAlign: "right" }}>Prior Yr</th>
                  </tr>
                </thead>
                <tbody>
                  {pillars.academics.fastScores.map((s) => (
                    <tr key={s.subject}>
                      <td style={{ textTransform: "uppercase" }}>{s.subject}</td>
                      <td style={{ textAlign: "right" }}>{s.pm1 ?? "—"}</td>
                      <td style={{ textAlign: "right" }}>{s.pm2 ?? "—"}</td>
                      <td style={{ textAlign: "right" }}>{s.pm3 ?? "—"}</td>
                      <td style={{ textAlign: "right" }}>
                        {s.priorYearScore ?? "—"}
                        {s.priorYearBq && (
                          <span style={{ color: "#991b1b", marginLeft: 4 }}>(BQ)</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {pillars.academics.assessments.length > 0 && (
            <div>
              <div style={{ fontWeight: 600, fontSize: "0.85rem", marginBottom: 4 }}>
                Recent assessments ({pillars.academics.assessments.length})
              </div>
              <ul style={{ margin: 0, paddingLeft: "1.2rem", fontSize: "0.85rem" }}>
                {pillars.academics.assessments.slice(0, 6).map((a, i) => (
                  <li key={i}>
                    <strong>{a.name}</strong>:{" "}
                    {a.score != null ? a.score : a.scoreLevel ?? "—"}{" "}
                    <span style={{ color: "#6b7280" }}>
                      ({new Date(a.administeredAt).toLocaleDateString()})
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>

        <Card
          title="Behavior"
          empty={
            pillars.behavior.pbisPositiveCount === 0 &&
            pillars.behavior.pbisNegativeCount === 0 &&
            pillars.behavior.supportNoteCount === 0
          }
        >
          <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.5rem", flexWrap: "wrap" }}>
            <Chip label={`+${pillars.behavior.pbisPositiveCount} PBIS`} sev="info" />
            {pillars.behavior.pbisNegativeCount > 0 && (
              <Chip label={`-${pillars.behavior.pbisNegativeCount} PBIS`} sev="watch" />
            )}
            {pillars.behavior.supportNoteCount > 0 && (
              <Chip label={`${pillars.behavior.supportNoteCount} notes`} sev="watch" />
            )}
          </div>
          {pillars.behavior.recentSupportNotes.length > 0 && (
            <div style={{ marginBottom: "0.5rem" }}>
              <div style={{ fontWeight: 600, fontSize: "0.85rem" }}>Recent notes</div>
              <ul style={{ margin: 0, paddingLeft: "1.2rem", fontSize: "0.85rem" }}>
                {pillars.behavior.recentSupportNotes.slice(0, 5).map((n, i) => (
                  <li key={i}>
                    <strong>{n.noteType}</strong>: {n.noteText.slice(0, 120)}
                    <span style={{ color: "#6b7280" }}> — {n.staffName}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {pillars.behavior.recentPbis.length > 0 && (
            <div>
              <div style={{ fontWeight: 600, fontSize: "0.85rem" }}>Recent PBIS</div>
              <ul style={{ margin: 0, paddingLeft: "1.2rem", fontSize: "0.85rem" }}>
                {pillars.behavior.recentPbis.slice(0, 5).map((p, i) => (
                  <li key={i}>
                    <span
                      style={{
                        color: p.polarity === "negative" ? "#991b1b" : "#0d9488",
                      }}
                    >
                      {p.polarity === "negative" ? "−" : "+"}
                      {p.points}
                    </span>{" "}
                    {p.reason}{" "}
                    <span style={{ color: "#6b7280" }}>— {p.staffName}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>

        <Card
          title="Attendance & Flow"
          empty={
            pillars.flow.tardyCount === 0 &&
            pillars.flow.issDayCount === 0 &&
            pillars.flow.hallPassCount === 0 &&
            pillars.flow.recentPullouts.length === 0
          }
        >
          <div style={{ display: "flex", gap: "0.4rem", marginBottom: "0.5rem", flexWrap: "wrap" }}>
            {pillars.flow.tardyCount > 0 && (
              <Chip label={`${pillars.flow.tardyCount} tardies`} sev={pillars.flow.tardyCount >= 5 ? "high" : "watch"} />
            )}
            {pillars.flow.issDayCount > 0 && (
              <Chip label={`${pillars.flow.issDayCount} ISS days`} sev="high" />
            )}
            {pillars.flow.hallPassCount > 0 && (
              <Chip
                label={`${pillars.flow.hallPassCount} hall passes (peer avg ${pillars.flow.hallPassSchoolAvg.toFixed(1)})`}
                sev={
                  pillars.flow.hallPassSchoolAvg > 0 &&
                  pillars.flow.hallPassCount > pillars.flow.hallPassSchoolAvg * 2
                    ? "watch"
                    : "info"
                }
              />
            )}
          </div>
          {pillars.flow.recentPullouts.length > 0 && (
            <div>
              <div style={{ fontWeight: 600, fontSize: "0.85rem" }}>Recent pullouts</div>
              <ul style={{ margin: 0, paddingLeft: "1.2rem", fontSize: "0.85rem" }}>
                {pillars.flow.recentPullouts.slice(0, 5).map((p, i) => (
                  <li key={i}>
                    <span style={{ color: "#6b7280" }}>
                      {new Date(p.requestedAt).toLocaleDateString()}
                    </span>{" "}
                    {p.reason} — {p.referringTeacherName} <em>({p.status})</em>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>

        <Card
          title="Supports"
          empty={
            pillars.supports.activeAccommodationCount === 0 &&
            pillars.supports.activeMtssPlans.length === 0 &&
            pillars.supports.recentInterventions.length === 0 &&
            pillars.supports.trustedAdults.length === 0
          }
        >
          {pillars.supports.activeMtssPlans.length > 0 && (
            <div style={{ marginBottom: "0.5rem" }}>
              <div style={{ fontWeight: 600, fontSize: "0.85rem" }}>
                Active MTSS plans
              </div>
              <ul style={{ margin: 0, paddingLeft: "1.2rem", fontSize: "0.85rem" }}>
                {pillars.supports.activeMtssPlans.map((p) => (
                  <li key={p.id}>
                    <strong>Tier {p.tier}</strong>: {p.title}{" "}
                    <span style={{ color: "#6b7280" }}>
                      (opened {new Date(p.openedAt).toLocaleDateString()})
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {pillars.supports.activeAccommodationCount > 0 && (
            <div style={{ marginBottom: "0.5rem" }}>
              <div style={{ fontWeight: 600, fontSize: "0.85rem" }}>
                Active accommodations ({pillars.supports.activeAccommodationCount})
              </div>
              <ul style={{ margin: 0, paddingLeft: "1.2rem", fontSize: "0.85rem" }}>
                {pillars.supports.accommodations.slice(0, 6).map((a) => (
                  <li key={a.id}>{a.label ?? "(unnamed)"}</li>
                ))}
              </ul>
            </div>
          )}
          {pillars.supports.recentInterventions.length > 0 && (
            <div style={{ marginBottom: "0.5rem" }}>
              <div style={{ fontWeight: 600, fontSize: "0.85rem" }}>
                Recent interventions
              </div>
              <ul style={{ margin: 0, paddingLeft: "1.2rem", fontSize: "0.85rem" }}>
                {pillars.supports.recentInterventions.slice(0, 5).map((n, i) => (
                  <li key={i}>
                    {n.interventionType}{" "}
                    <span style={{ color: "#6b7280" }}>— {n.staffName}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {pillars.supports.trustedAdults.length > 0 && (
            <div>
              <div style={{ fontWeight: 600, fontSize: "0.85rem" }}>Trusted adults</div>
              <div>
                {pillars.supports.trustedAdults.map((t) => (
                  <Chip
                    key={t.id}
                    label={t.staffName ?? `Staff #${t.staffId}`}
                    sev="info"
                  />
                ))}
              </div>
            </div>
          )}
        </Card>

        <Card
          title="Family"
          empty={
            !pillars.family.parentName &&
            !pillars.family.parentEmail &&
            !pillars.family.parentPhone &&
            pillars.family.linkedParentAccountCount === 0
          }
        >
          {pillars.family.parentName && (
            <div>
              <strong>{pillars.family.parentName}</strong>
            </div>
          )}
          {pillars.family.parentEmail && (
            <div style={{ fontSize: "0.85rem" }}>
              <a href={`mailto:${pillars.family.parentEmail}`}>
                {pillars.family.parentEmail}
              </a>
            </div>
          )}
          {pillars.family.parentPhone && (
            <div style={{ fontSize: "0.85rem", color: "#6b7280" }}>
              {pillars.family.parentPhone}
            </div>
          )}
          <div style={{ marginTop: "0.4rem", fontSize: "0.8rem", color: "#6b7280" }}>
            {pillars.family.linkedParentAccountCount > 0
              ? `${pillars.family.linkedParentAccountCount} linked parent portal account${pillars.family.linkedParentAccountCount === 1 ? "" : "s"}`
              : "No parent portal account linked yet"}
          </div>
        </Card>
      </div>
    </div>
  );
}
