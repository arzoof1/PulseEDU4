import { useEffect, useState, type CSSProperties } from "react";
import { authFetch } from "../lib/authToken";
import { HowToUseHelp, HowToSection, RoleSection } from "./HowToUseHelp";

// Each row is one automated/recurring PARENT notification. The panel writes
// to whichever endpoint already owns the underlying switch — new master
// switches live on school_settings; HeartBEAT reuses heartbeat-settings;
// Family Messages + Store + Tour reuse existing school_settings flags. No
// switch is duplicated.
type Route = "settings" | "heartbeat";

interface NotifyRow {
  field: string; // body key sent to the route
  route: Route;
  label: string;
  description: string;
  // When set, the row's underlying feature must be available at the district
  // (SuperUser) tier before an admin can enable it.
  requiresSuper?: string;
  // Reused (vs. a dedicated parent-notification switch) — surfaced as a hint
  // so admins know the same switch lives elsewhere too.
  reusedNote?: string;
}

const ROWS: NotifyRow[] = [
  {
    field: "allowWeeklyEmail",
    route: "heartbeat",
    label: "Weekly HeartBEAT email",
    description:
      "The Sunday-evening weekly PDF snapshot families can opt into for their student.",
    reusedNote: "Also in Parent Portal sections.",
  },
  {
    field: "notifyParentEligibility",
    route: "settings",
    label: "Eligibility notices",
    description:
      "Emails to families when a student is at risk of, or has lost, athletics / activity eligibility. Coach, principal, and AD copies are unaffected.",
  },
  {
    field: "notifyParentPbisMilestone",
    route: "settings",
    label: "PBIS milestone celebrations",
    description:
      "Positive emails home when a student reaches a PBIS point milestone.",
  },
  {
    field: "notifyParentTardy",
    route: "settings",
    label: "Tardy alerts",
    description:
      "Parent notification when a student is logged tardy (parent SMS scaffold).",
  },
  {
    field: "featureSchoolStoreNotify",
    route: "settings",
    label: "Store item ready for pickup",
    description:
      "Email families when a redeemed School Store item has been fulfilled and is ready.",
    requiresSuper: "superFeatureSchoolStoreNotify",
    reusedNote: "Also in School Store settings.",
  },
  {
    field: "featureFamilyComm",
    route: "settings",
    label: "Family Messages broadcasts",
    description:
      "Staff-sent announcements to families. This is the Family Messages module master switch — turning it off hides the whole module, not just the email nudge.",
    requiresSuper: "superFeatureFamilyComm",
    reusedNote: "Same switch as the Family Communication feature flag.",
  },
  {
    field: "notifyParentEventTickets",
    route: "settings",
    label: "Event ticket emails",
    description:
      "Emailed QR tickets when a student is granted free tickets for an event.",
  },
  {
    field: "notifyParentEsign",
    route: "settings",
    label: "E-sign signing requests",
    description:
      "Email a family the secure link to review and sign a document. Staff can always copy the link manually when this is off.",
  },
  {
    field: "tourFamilyNurtureEnabled",
    route: "settings",
    label: "Tour family nurture cadence",
    description:
      "Automated pre-tour reminder, post-tour thank-you + survey, and gentle follow-up emails for enrollment leads. Off by default.",
    reusedNote: "Also in School Tours settings.",
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
  flexWrap: "wrap",
};

const descStyle: CSSProperties = {
  fontSize: 13,
  color: "var(--text-muted, #64748b)",
  marginTop: 2,
  lineHeight: 1.4,
};

const reuseTagStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "var(--text-muted, #64748b)",
  border: "1px solid var(--border-strong, #cbd5e1)",
  borderRadius: 4,
  padding: "1px 6px",
  background: "transparent",
};

const lockedTagStyle: CSSProperties = {
  ...reuseTagStyle,
  color: "var(--accent, #ef4444)",
  borderColor: "var(--accent, #ef4444)",
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

type BoolMap = Record<string, boolean>;

export default function ParentNotificationsPanel() {
  const [vals, setVals] = useState<BoolMap | null>(null);
  const [supers, setSupers] = useState<BoolMap>({});
  const [savingField, setSavingField] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      authFetch("/api/school-settings").then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<Record<string, unknown>>;
      }),
      authFetch("/api/heartbeat-settings").then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<Record<string, unknown>>;
      }),
    ])
      .then(([settings, heartbeat]) => {
        if (cancelled) return;
        const next: BoolMap = {};
        for (const row of ROWS) {
          const src = row.route === "heartbeat" ? heartbeat : settings;
          // HeartBEAT allowWeeklyEmail defaults TRUE; the new parent-notify
          // columns default TRUE; feature flags carry their own defaults.
          next[row.field] = src[row.field] !== false;
        }
        const sup: BoolMap = {};
        for (const row of ROWS) {
          if (row.requiresSuper) {
            sup[row.requiresSuper] = settings[row.requiresSuper] !== false;
          }
        }
        setVals(next);
        setSupers(sup);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(
          err instanceof Error
            ? err.message
            : "Failed to load parent notification settings",
        );
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggle(row: NotifyRow) {
    if (!vals) return;
    const next = !vals[row.field];
    const previous = vals[row.field];
    setSavingField(row.field);
    setError(null);
    setVals({ ...vals, [row.field]: next });
    try {
      const url =
        row.route === "heartbeat"
          ? "/api/heartbeat-settings"
          : "/api/school-settings";
      const res = await authFetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [row.field]: next }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const updated = (await res.json()) as Record<string, unknown>;
      // Trust the server's echoed value (it may differ, e.g. a blocked
      // feature enable), but only for this field.
      if (Object.prototype.hasOwnProperty.call(updated, row.field)) {
        setVals((cur) =>
          cur ? { ...cur, [row.field]: updated[row.field] !== false } : cur,
        );
      }
    } catch (err) {
      setVals((cur) => (cur ? { ...cur, [row.field]: previous } : cur));
      setError(
        err instanceof Error ? err.message : "Failed to update — please retry",
      );
    } finally {
      setSavingField(null);
    }
  }

  if (loading) {
    return (
      <div className="card">
        <p style={{ color: "var(--text-muted, #64748b)" }}>
          Loading parent notification settings…
        </p>
      </div>
    );
  }
  if (error && !vals) {
    return (
      <div className="card">
        <p style={{ color: "var(--accent, #ef4444)" }}>{error}</p>
      </div>
    );
  }
  if (!vals) return null;

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <h2 style={{ marginTop: 0 }}>Parent Notifications</h2>
      <HowToUseHelp title="How to use Parent Notifications">
        <HowToSection title="Defaults preserve today's behavior">
          Every switch starts where your school is today — nothing changes
          until you flip something. Turning a switch off stops that one
          automated message to families; staff-facing copies (coaches,
          principals, digests) are not affected.
        </HowToSection>
        <RoleSection for={["admin"]} title="Always-on by design">
          Portal invitations and password-reset emails are never listed
          here — families need them to access the portal at all, so they
          always send.
        </RoleSection>
      </HowToUseHelp>
      <p style={{ color: "var(--text-muted, #64748b)", marginTop: 0 }}>
        Choose which automated, recurring emails this school sends to families.
        Changes save instantly.
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
        {ROWS.map((row) => {
          const locked =
            row.requiresSuper !== undefined && !supers[row.requiresSuper];
          const on = Boolean(vals[row.field]) && !locked;
          const isSaving = savingField === row.field;
          return (
            <div key={row.field} style={cardStyle}>
              <button
                type="button"
                aria-pressed={on}
                aria-label={`${on ? "Disable" : "Enable"} ${row.label}`}
                onClick={() => toggle(row)}
                disabled={isSaving || locked}
                style={{
                  ...switchTrackStyle(on),
                  opacity: isSaving || locked ? 0.5 : 1,
                  cursor: locked ? "not-allowed" : "pointer",
                }}
              >
                <span style={switchThumbStyle(on)} />
              </button>
              <div style={{ flex: 1 }}>
                <div style={labelStyle}>
                  {row.label}
                  {locked && <span style={lockedTagStyle}>Not licensed</span>}
                  {row.reusedNote && !locked && (
                    <span style={reuseTagStyle} title={row.reusedNote}>
                      Reused
                    </span>
                  )}
                </div>
                <div style={descStyle}>
                  {row.description}
                  {locked && (
                    <>
                      {" "}
                      This feature isn't enabled for your school at the district
                      level.
                    </>
                  )}
                  {row.reusedNote && !locked && (
                    <span
                      style={{
                        display: "block",
                        marginTop: 2,
                        fontStyle: "italic",
                      }}
                    >
                      {row.reusedNote}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <p
        style={{
          color: "var(--text-muted, #64748b)",
          fontSize: 12,
          marginBottom: 0,
        }}
      >
        Portal invitations and password-reset emails are access-critical and
        always send — they are intentionally not listed here.
      </p>
    </div>
  );
}
