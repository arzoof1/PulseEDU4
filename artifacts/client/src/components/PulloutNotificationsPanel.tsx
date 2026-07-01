import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { authFetch } from "../lib/authToken";
import { HowToUseHelp, HowToSection, RoleSection } from "./HowToUseHelp";

// Admin no-code control for Request Pullout dispatch notifications:
//   1. An SMS on/off toggle (texts the same recipients; off by default).
//   2. Extra recipients — any staff member, regardless of role, who should
//      also receive the dispatch email/text (e.g. a reading coach who helps
//      with pullouts but stays a reading coach).
// Role-based recipients (Admin / Dean / MTSS Coordinator / ISS Teacher) are
// always notified and shown read-only.

interface NotifyStaff {
  id: number;
  displayName: string;
  roleLabels: string[];
  isActive: boolean;
  isAutoRecipient: boolean;
  hasEmail: boolean;
  hasCell: boolean;
  isExtra: boolean;
}

interface NotifyConfig {
  smsEnabled: boolean;
  extraRecipientStaffIds: number[];
  staff: NotifyStaff[];
}

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

const tagStyle: CSSProperties = {
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

const autoTagStyle: CSSProperties = {
  ...tagStyle,
  color: "var(--primary, #0e7490)",
  borderColor: "var(--primary, #0e7490)",
};

const warnTagStyle: CSSProperties = {
  ...tagStyle,
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

export default function PulloutNotificationsPanel() {
  const [config, setConfig] = useState<NotifyConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingSms, setSavingSms] = useState(false);
  const [savingId, setSavingId] = useState<number | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    authFetch("/api/pullouts/notify-config")
      .then(async (r) => {
        if (!r.ok) {
          const j = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `HTTP ${r.status}`);
        }
        return r.json() as Promise<NotifyConfig>;
      })
      .then((c) => {
        if (cancelled) return;
        setConfig(c);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(
          err instanceof Error
            ? err.message
            : "Failed to load pullout notification settings",
        );
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const autoRecipients = useMemo(
    () =>
      config
        ? config.staff.filter((s) => s.isAutoRecipient && s.isActive)
        : [],
    [config],
  );
  const extraRecipients = useMemo(
    () => (config ? config.staff.filter((s) => s.isExtra) : []),
    [config],
  );
  const pickable = useMemo(() => {
    if (!config) return [];
    const q = query.trim().toLowerCase();
    return config.staff
      .filter((s) => !s.isAutoRecipient)
      .filter((s) => (q ? s.displayName.toLowerCase().includes(q) : true));
  }, [config, query]);

  async function save(body: Record<string, unknown>): Promise<NotifyConfig> {
    const res = await authFetch("/api/pullouts/notify-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(j.error ?? `HTTP ${res.status}`);
    }
    return res.json() as Promise<NotifyConfig>;
  }

  // Reconcile the server-echoed write (smsEnabled / extraRecipientStaffIds)
  // into local state, recomputing each staff row's isExtra flag.
  function applyEcho(
    cur: NotifyConfig,
    echo: { smsEnabled?: boolean; extraRecipientStaffIds?: number[] },
  ): NotifyConfig {
    const nextExtra = echo.extraRecipientStaffIds ?? cur.extraRecipientStaffIds;
    return {
      smsEnabled:
        typeof echo.smsEnabled === "boolean" ? echo.smsEnabled : cur.smsEnabled,
      extraRecipientStaffIds: nextExtra,
      staff: cur.staff.map((s) => ({ ...s, isExtra: nextExtra.includes(s.id) })),
    };
  }

  async function toggleSms() {
    if (!config) return;
    const next = !config.smsEnabled;
    setSavingSms(true);
    setError(null);
    setConfig({ ...config, smsEnabled: next });
    try {
      const echo = await save({ smsEnabled: next });
      setConfig((cur) => (cur ? applyEcho(cur, echo) : cur));
    } catch (err) {
      setConfig((cur) => (cur ? { ...cur, smsEnabled: !next } : cur));
      setError(
        err instanceof Error ? err.message : "Failed to update — please retry",
      );
    } finally {
      setSavingSms(false);
    }
  }

  async function toggleExtra(staff: NotifyStaff) {
    if (!config) return;
    const has = config.extraRecipientStaffIds.includes(staff.id);
    const nextIds = has
      ? config.extraRecipientStaffIds.filter((id) => id !== staff.id)
      : [...config.extraRecipientStaffIds, staff.id];
    const previous = config;
    setSavingId(staff.id);
    setError(null);
    setConfig(applyEcho(config, { extraRecipientStaffIds: nextIds }));
    try {
      const echo = await save({ extraRecipientStaffIds: nextIds });
      setConfig((cur) => (cur ? applyEcho(cur, echo) : cur));
    } catch (err) {
      setConfig(previous);
      setError(
        err instanceof Error ? err.message : "Failed to update — please retry",
      );
    } finally {
      setSavingId(null);
    }
  }

  if (loading) {
    return (
      <div className="card">
        <p style={{ color: "var(--text-muted, #64748b)" }}>
          Loading pullout notification settings…
        </p>
      </div>
    );
  }
  if (error && !config) {
    return (
      <div className="card">
        <p style={{ color: "var(--accent, #ef4444)" }}>{error}</p>
      </div>
    );
  }
  if (!config) return null;

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <h2 style={{ marginTop: 0 }}>Pullout Notifications</h2>
      <HowToUseHelp title="How to use Pullout Notifications">
        <HowToSection title="Who is notified">
          When a teacher requests a pullout, PulseED emails the people who can
          dispatch it. Admins, Deans, MTSS Coordinators, and ISS Teachers are
          always included by role. Use the list below to add anyone else — for
          example a reading coach who helps with pullouts — without changing
          their role.
        </HowToSection>
        <RoleSection for={["admin"]} title="Text messages (SMS)">
          Turn on the SMS switch to also text dispatch recipients who have a
          cell number on file. Texts never include the student's name or ID —
          recipients open PulseED to see the details.
        </RoleSection>
      </HowToUseHelp>

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

      {/* SMS toggle */}
      <div style={cardStyle}>
        <button
          type="button"
          aria-pressed={config.smsEnabled}
          aria-label={`${config.smsEnabled ? "Disable" : "Enable"} pullout text alerts`}
          onClick={toggleSms}
          disabled={savingSms}
          style={{
            ...switchTrackStyle(config.smsEnabled),
            opacity: savingSms ? 0.5 : 1,
          }}
        >
          <span style={switchThumbStyle(config.smsEnabled)} />
        </button>
        <div style={{ flex: 1 }}>
          <div style={labelStyle}>Also text dispatch recipients (SMS)</div>
          <div style={descStyle}>
            When on, recipients with a cell number on file also get a text for
            each new pullout request. Email always sends regardless. Texts carry
            no student name or ID.
          </div>
        </div>
      </div>

      {/* Always-notified (role-based) */}
      <h3 style={{ marginBottom: "0.4rem" }}>Always notified (by role)</h3>
      <p style={{ ...descStyle, marginTop: 0, marginBottom: "0.6rem" }}>
        These staff receive every pullout dispatch because of their role. To
        change this, update their role in Staff &amp; Roles.
      </p>
      {autoRecipients.length === 0 ? (
        <p style={{ ...descStyle, marginBottom: "0.8rem" }}>
          No Admin / Dean / MTSS Coordinator / ISS Teacher is set up yet. Add
          extra recipients below so requests are not missed.
        </p>
      ) : (
        <div style={{ marginBottom: "1rem" }}>
          {autoRecipients.map((s) => (
            <div key={s.id} style={cardStyle}>
              <div style={{ flex: 1 }}>
                <div style={labelStyle}>
                  {s.displayName}
                  {s.roleLabels.map((r) => (
                    <span key={r} style={autoTagStyle}>
                      {r}
                    </span>
                  ))}
                  {!s.hasEmail && (
                    <span style={warnTagStyle} title="No email on file">
                      No email
                    </span>
                  )}
                  {config.smsEnabled && !s.hasCell && (
                    <span style={warnTagStyle} title="No cell number on file">
                      No cell
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Extra recipients picker */}
      <h3 style={{ marginBottom: "0.4rem" }}>Extra recipients</h3>
      <p style={{ ...descStyle, marginTop: 0, marginBottom: "0.6rem" }}>
        Add any staff member who should also be notified, regardless of role.
        {extraRecipients.length > 0 &&
          ` Currently added: ${extraRecipients.length}.`}
      </p>
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search staff by name…"
        style={{
          width: "100%",
          maxWidth: 360,
          padding: "0.5rem 0.7rem",
          borderRadius: 8,
          border: "1px solid var(--border, #e5e7eb)",
          marginBottom: "0.6rem",
          fontSize: 14,
        }}
      />
      {pickable.length === 0 ? (
        <p style={descStyle}>No matching staff.</p>
      ) : (
        <div style={{ maxHeight: 360, overflowY: "auto" }}>
          {pickable.map((s) => {
            const on = config.extraRecipientStaffIds.includes(s.id);
            const isSaving = savingId === s.id;
            return (
              <div key={s.id} style={cardStyle}>
                <button
                  type="button"
                  aria-pressed={on}
                  aria-label={`${on ? "Remove" : "Add"} ${s.displayName} as an extra recipient`}
                  onClick={() => toggleExtra(s)}
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
                    {s.displayName}
                    {on && <span style={autoTagStyle}>Added</span>}
                    {!s.isActive && (
                      <span style={warnTagStyle} title="No longer active staff">
                        Inactive
                      </span>
                    )}
                    {!s.hasEmail && (
                      <span style={warnTagStyle} title="No email on file">
                        No email
                      </span>
                    )}
                    {on && config.smsEnabled && !s.hasCell && (
                      <span style={warnTagStyle} title="No cell number on file">
                        No cell
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
