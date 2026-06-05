import { useEffect, useState, type CSSProperties } from "react";
import { authFetch } from "../lib/authToken";
import { HowToUseHelp, HowToSection, RoleSection } from "./HowToUseHelp";

type SectionKey =
  | "showRecognition"
  | "showAttendance"
  | "showHallPasses"
  | "showAccommodations"
  | "showFastScores"
  | "showCommHistory"
  | "showPullouts"
  | "showInterventions"
  | "showStaffNotes"
  | "showIss"
  | "showMtss"
  | "showReteach"
  | "allowWeeklyEmail";

type Settings = Partial<Record<SectionKey, boolean>> & {
  id?: number;
  schoolId?: number;
};

interface SectionDef {
  key: SectionKey;
  label: string;
  description: string;
  sensitive?: boolean;
}

const SECTIONS: SectionDef[] = [
  {
    key: "showRecognition",
    label: "PBIS recognition",
    description:
      "Weekly positive vs. negative point totals and the recent praise feed.",
  },
  {
    key: "showAttendance",
    label: "Attendance",
    description: "Tardies, check-ins, check-outs, and absence patterns.",
  },
  {
    key: "showHallPasses",
    label: "Hall pass activity",
    description: "Weekly hall pass count and any unusual durations.",
  },
  {
    key: "showAccommodations",
    label: "Accommodations",
    description:
      "Active 504 / IEP / ELL accommodations on file (no plan documents).",
  },
  {
    key: "showFastScores",
    label: "FAST scores",
    description:
      "PM1 / PM2 / PM3 ELA + Math results once they're posted in district systems.",
  },
  {
    key: "showCommHistory",
    label: "Communication history",
    description: "Recent emails and calls between school staff and family.",
  },
  {
    key: "showPullouts",
    label: "Pullouts",
    description:
      "Scheduled academic supports the student is pulled from class for.",
  },
  {
    key: "showInterventions",
    label: "Interventions",
    description:
      "Tier 2 / Tier 3 interventions logged by staff. Sensitive — off by default.",
    sensitive: true,
  },
  {
    key: "showStaffNotes",
    label: "Staff notes",
    description:
      "Free-form notes left by teachers, counselors, or administrators. Sensitive — off by default.",
    sensitive: true,
  },
  {
    key: "showIss",
    label: "ISS (in-school suspension)",
    description:
      "ISS placements and durations. Sensitive — off by default.",
    sensitive: true,
  },
  {
    key: "showMtss",
    label: "MTSS plans",
    description:
      "Active MTSS plan tier, goals, and progress notes. Sensitive — off by default.",
    sensitive: true,
  },
  {
    key: "showReteach",
    label: "Extra Support — Focused Reteach",
    description:
      "Per-benchmark count of 1:1 and small-group reteach moments logged this school year. Teacher notes and strategy are NEVER surfaced — counts + benchmark codes only. Also requires a per-student opt-in on each student's profile. Sensitive — off by default.",
    sensitive: true,
  },
  {
    key: "allowWeeklyEmail",
    label: "Allow weekly Sunday email",
    description:
      "Lets parents opt in to a weekly PDF snapshot delivered Sunday evening.",
  },
];

const cardStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "0.85rem",
  padding: "0.85rem 1rem",
  border: "1px solid var(--border, #e5e7eb)",
  borderRadius: 10,
  background: "var(--surface, #fff)",
  marginBottom: "0.6rem",
};

const labelStyle: CSSProperties = {
  fontWeight: 600,
  color: "var(--text, #0f172a)",
  display: "flex",
  alignItems: "center",
  gap: "0.4rem",
};

const descStyle: CSSProperties = {
  fontSize: 13,
  color: "var(--text-muted, #64748b)",
  marginTop: 2,
  lineHeight: 1.4,
};

const sensitiveTagStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--accent, #ef4444)",
  border: "1px solid var(--accent, #ef4444)",
  borderRadius: 4,
  padding: "1px 6px",
  background: "transparent",
};

const switchTrackStyle = (on: boolean): CSSProperties => ({
  width: 38,
  height: 22,
  borderRadius: 999,
  background: on ? "var(--primary, #0e7490)" : "var(--border-strong, #cbd5e1)",
  position: "relative",
  transition: "background 120ms",
  flexShrink: 0,
  marginTop: 2,
  cursor: "pointer",
  border: "none",
  padding: 0,
});

const switchThumbStyle = (on: boolean): CSSProperties => ({
  position: "absolute",
  top: 2,
  left: on ? 18 : 2,
  width: 18,
  height: 18,
  borderRadius: "50%",
  background: "#fff",
  transition: "left 120ms",
  boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
});

export default function HeartbeatSectionsAdmin() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [savingKey, setSavingKey] = useState<SectionKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    authFetch("/api/heartbeat-settings")
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<Settings>;
      })
      .then((data) => {
        if (cancelled) return;
        setSettings(data);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(
          err instanceof Error
            ? err.message
            : "Failed to load parent portal section settings",
        );
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggle(key: SectionKey) {
    if (!settings) return;
    const next = !(settings[key] ?? false);
    const previous = settings[key];
    setSavingKey(key);
    setError(null);
    setSettings({ ...settings, [key]: next });
    try {
      const res = await authFetch("/api/heartbeat-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: next }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const updated = (await res.json()) as Settings;
      setSettings(updated);
    } catch (err) {
      setSettings({ ...settings, [key]: previous });
      setError(
        err instanceof Error
          ? err.message
          : "Failed to update — please retry",
      );
    } finally {
      setSavingKey(null);
    }
  }

  if (loading) {
    return (
      <div className="card">
        <p style={{ color: "var(--text-muted, #64748b)" }}>
          Loading parent portal section settings…
        </p>
      </div>
    );
  }
  if (error && !settings) {
    return (
      <div className="card">
        <p style={{ color: "var(--accent, #ef4444)" }}>{error}</p>
      </div>
    );
  }
  if (!settings) return null;

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <h2 style={{ marginTop: 0 }}>Parent portal sections</h2>
      <HowToUseHelp title="How to use Parent Portal Sections">
        <HowToSection title="Default-off, school-on, parent-down">
          School controls the ceiling — you decide which HeartBEAT
          sections families can ever see. Parents control the floor —
          they can hide any section you've shown but they cannot
          reveal a section you've hidden. Sensitive categories ship
          off so a school has to deliberately turn them on.
        </HowToSection>
        <RoleSection for={["admin", "coreTeam"]} title="Recommended rollout">
          Start with PBIS Points and Hall Passes (low-risk wins).
          Hold off on Staff Notes until counselors confirm the
          phrasing in current notes is parent-appropriate.
        </RoleSection>
      </HowToUseHelp>
      <p style={{ color: "var(--text-muted, #64748b)", marginTop: 0 }}>
        Control which HeartBEAT sections this school's parents can see in their
        snapshot. Sensitive sections are off by default. A parent can hide a
        section the school has shown — they cannot reveal one the school has
        hidden.
      </p>
      {error && (
        <div
          style={{
            background: "rgba(239,68,68,0.08)",
            border: "1px solid var(--accent, #ef4444)",
            color: "var(--accent, #ef4444)",
            padding: "0.5rem 0.75rem",
            borderRadius: 6,
            marginBottom: "0.75rem",
            fontSize: 13,
          }}
          role="alert"
        >
          {error}
        </div>
      )}
      <div>
        {SECTIONS.map((s) => {
          const on = Boolean(settings[s.key]);
          const isSaving = savingKey === s.key;
          return (
            <div key={s.key} style={cardStyle}>
              <button
                type="button"
                aria-pressed={on}
                aria-label={`${on ? "Hide" : "Show"} ${s.label}`}
                onClick={() => toggle(s.key)}
                disabled={isSaving}
                style={{
                  ...switchTrackStyle(on),
                  opacity: isSaving ? 0.5 : 1,
                }}
              >
                <span style={switchThumbStyle(on)} />
              </button>
              <div style={{ flex: 1 }}>
                <div style={labelStyle}>
                  {s.label}
                  {s.sensitive && (
                    <span style={sensitiveTagStyle}>Sensitive</span>
                  )}
                </div>
                <div style={descStyle}>{s.description}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
