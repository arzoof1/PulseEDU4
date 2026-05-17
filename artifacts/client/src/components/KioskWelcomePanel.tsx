import { useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/authToken";

// Core-Team-editable kiosk welcome messages. Lives in Settings → Kiosk
// welcome. Backed by `school_settings.kiosk_welcome_template` and
// `kiosk_welcome_messages` (JSONB house-id → template). Per-house
// overrides fall back to the default template when missing.
//
// Placeholders: {firstName} {lastName} {house} {grade}
// Anything else is preserved verbatim so a typo is visible to the
// editor instead of silently dropped.

interface House {
  id: number;
  name: string;
  color: string | null;
}

// Self-fetches current values from GET /api/school-settings so the
// settings tile can mount without threading state from App.tsx.

const PLACEHOLDER_HELP = "{firstName} · {lastName} · {house} · {grade}";
const MAX_LEN = 240;
const DEFAULT_TEMPLATE = "Welcome, {firstName}!";

function substitute(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);
}

export function KioskWelcomePanel() {
  const [template, setTemplate] = useState(DEFAULT_TEMPLATE);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [houses, setHouses] = useState<House[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    authFetch("/api/school-settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        const t =
          typeof d.kioskWelcomeTemplate === "string" && d.kioskWelcomeTemplate
            ? d.kioskWelcomeTemplate
            : DEFAULT_TEMPLATE;
        setTemplate(t);
        const m =
          d.kioskWelcomeMessages &&
          typeof d.kioskWelcomeMessages === "object" &&
          !Array.isArray(d.kioskWelcomeMessages)
            ? (d.kioskWelcomeMessages as Record<string, string>)
            : {};
        setOverrides(m);
      })
      .catch(() => {});
    authFetch("/api/houses")
      .then((r) => (r.ok ? r.json() : []))
      .then((d: House[]) => setHouses(Array.isArray(d) ? d : []))
      .catch(() => setHouses([]));
  }, []);

  const sampleVars = useMemo(
    () => ({
      firstName: "Jordan",
      lastName: "Rivera",
      house: houses[0]?.name ?? "Phoenix",
      grade: "7",
    }),
    [houses],
  );

  async function save() {
    setSaving(true);
    setError("");
    try {
      // Sanitize: drop empty overrides so the JSONB stays tidy and
      // the server's strict validator (digit keys only, length cap)
      // doesn't bounce us on a stray whitespace value.
      const cleanedOverrides: Record<string, string> = {};
      for (const [k, v] of Object.entries(overrides)) {
        const trimmed = (v ?? "").trim();
        if (!trimmed) continue;
        if (!/^\d+$/.test(k)) continue;
        cleanedOverrides[k] = trimmed.slice(0, MAX_LEN);
      }
      const body = {
        kioskWelcomeTemplate: template.slice(0, MAX_LEN),
        kioskWelcomeMessages: cleanedOverrides,
      };
      const res = await authFetch("/api/school-settings", {
        method: "PUT",
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error ?? `Save failed (${res.status})`);
      }
      setOverrides(cleanedOverrides);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <h2 style={{ marginTop: 0 }}>Kiosk Welcome Messages</h2>
      <p style={{ color: "var(--text-subtle)", marginTop: 0 }}>
        Greets each student when they sign in to class on a kiosk.
        Use the placeholders below — anything else stays as plain text.
      </p>
      <div
        style={{
          fontSize: "0.85rem",
          opacity: 0.75,
          marginBottom: "0.75rem",
        }}
      >
        Placeholders: <code>{PLACEHOLDER_HELP}</code>
      </div>

      <label
        style={{
          fontWeight: 600,
          fontSize: "0.95rem",
          display: "block",
          marginBottom: 4,
        }}
      >
        Default template
      </label>
      <textarea
        value={template}
        onChange={(e) => setTemplate(e.target.value.slice(0, MAX_LEN))}
        rows={2}
        style={{
          width: "100%",
          padding: "0.6rem",
          borderRadius: 6,
          border: "1px solid var(--border, rgba(0,0,0,0.15))",
          fontSize: "1rem",
          fontFamily: "inherit",
          boxSizing: "border-box",
        }}
        placeholder={DEFAULT_TEMPLATE}
      />
      <div
        style={{
          fontSize: "0.8rem",
          opacity: 0.6,
          marginTop: 4,
          marginBottom: "1rem",
        }}
      >
        {template.length}/{MAX_LEN} · Preview: <strong>{substitute(template || DEFAULT_TEMPLATE, sampleVars)}</strong>
      </div>

      {houses.length > 0 && (
        <details style={{ marginTop: "0.5rem", marginBottom: "0.75rem" }}>
          <summary
            style={{
              cursor: "pointer",
              fontWeight: 600,
              padding: "0.5rem 0",
            }}
          >
            Per-house overrides ({houses.length} {houses.length === 1 ? "house" : "houses"})
          </summary>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr",
              gap: "0.75rem",
              marginTop: "0.5rem",
            }}
          >
            {houses.map((h) => {
              const current = overrides[String(h.id)] ?? "";
              return (
                <div key={h.id}>
                  <label
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.5rem",
                      fontWeight: 600,
                      fontSize: "0.9rem",
                      marginBottom: 4,
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        width: 14,
                        height: 14,
                        borderRadius: 3,
                        background: h.color ?? "#888",
                        display: "inline-block",
                      }}
                    />
                    {h.name}
                  </label>
                  <input
                    type="text"
                    value={current}
                    onChange={(e) =>
                      setOverrides((prev) => ({
                        ...prev,
                        [String(h.id)]: e.target.value.slice(0, MAX_LEN),
                      }))
                    }
                    placeholder="(uses default template)"
                    style={{
                      width: "100%",
                      padding: "0.5rem",
                      borderRadius: 6,
                      border:
                        "1px solid var(--border, rgba(0,0,0,0.15))",
                      fontSize: "0.95rem",
                      boxSizing: "border-box",
                    }}
                  />
                  {current && (
                    <div
                      style={{
                        fontSize: "0.8rem",
                        opacity: 0.65,
                        marginTop: 3,
                      }}
                    >
                      Preview:{" "}
                      <strong>
                        {substitute(current, {
                          ...sampleVars,
                          house: h.name,
                        })}
                      </strong>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </details>
      )}

      {error && (
        <div
          style={{
            color: "#b91c1c",
            background: "rgba(220,38,38,0.08)",
            border: "1px solid rgba(220,38,38,0.3)",
            padding: "0.5rem 0.75rem",
            borderRadius: 6,
            marginBottom: "0.5rem",
            fontSize: "0.9rem",
          }}
        >
          {error}
        </div>
      )}
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          style={{
            background: "#2563eb",
            color: "#fff",
            border: "none",
            borderRadius: 6,
            padding: "0.6rem 1.25rem",
            fontWeight: 600,
            cursor: saving ? "not-allowed" : "pointer",
            opacity: saving ? 0.7 : 1,
          }}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {savedFlash && (
          <span style={{ color: "#15803d", fontSize: "0.9rem" }}>
            Saved.
          </span>
        )}
      </div>
    </div>
  );
}

export default KioskWelcomePanel;
