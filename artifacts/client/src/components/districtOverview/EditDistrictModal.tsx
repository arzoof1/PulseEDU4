// Edit-a-District modal. SuperUser-only. Calls
// PATCH /api/tenancy/districts/:id with only the fields the user
// changed. Deactivate / reactivate is a separate inline button on the
// parent card, not a checkbox here.

import { useState } from "react";
import { authFetch } from "../../lib/authToken";

type Props = {
  district: {
    id: number;
    name: string;
    slug: string;
    stateDistrictCode: string | null;
    timezone: string;
  };
  onClose: () => void;
  onSaved: () => void;
};

// Small curated list — matches the dropdown in OnboardDistrictModal.
const TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Anchorage",
  "America/Phoenix",
  "Pacific/Honolulu",
];

export default function EditDistrictModal({
  district,
  onClose,
  onSaved,
}: Props) {
  const [name, setName] = useState(district.name);
  const [slug, setSlug] = useState(district.slug);
  const [stateDistrictCode, setStateDistrictCode] = useState(
    district.stateDistrictCode ?? "",
  );
  const [timezone, setTimezone] = useState(district.timezone);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const patch: Record<string, unknown> = {};
      if (name.trim() !== district.name) patch.name = name.trim();
      if (slug.trim() !== district.slug) patch.slug = slug.trim();
      if (stateDistrictCode !== (district.stateDistrictCode ?? "")) {
        patch.stateDistrictCode = stateDistrictCode.trim() || null;
      }
      if (timezone !== district.timezone) patch.timezone = timezone;
      if (Object.keys(patch).length === 0) {
        onClose();
        return;
      }
      const res = await authFetch(`/api/tenancy/districts/${district.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.5)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "3rem 1rem",
        zIndex: 1000,
        overflowY: "auto",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--surface, #fff)",
          borderRadius: 10,
          width: "100%",
          maxWidth: 480,
          padding: "1.25rem 1.5rem",
          boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "0.75rem",
          }}
        >
          <h2 style={{ margin: 0 }}>Edit district</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "transparent",
              border: "none",
              fontSize: "1.5rem",
              cursor: "pointer",
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>
        <form onSubmit={submit}>
          <Field label="District name" required>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={inputStyle}
            />
          </Field>
          <Field label="Slug" required hint="lowercase letters, digits, hyphens">
            <input
              type="text"
              required
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              style={inputStyle}
            />
          </Field>
          <Field label="State district code" hint="(optional)">
            <input
              type="text"
              value={stateDistrictCode}
              onChange={(e) => setStateDistrictCode(e.target.value)}
              style={inputStyle}
            />
          </Field>
          <Field label="Timezone">
            <select
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              style={inputStyle}
            >
              {!TIMEZONES.includes(timezone) && (
                <option value={timezone}>{timezone}</option>
              )}
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </Field>

          {error && (
            <div
              style={{
                marginTop: "0.5rem",
                padding: "0.5rem 0.75rem",
                background: "#fee2e2",
                border: "1px solid #fca5a5",
                borderRadius: 6,
                color: "#991b1b",
                fontSize: "0.85rem",
              }}
            >
              {error}
            </div>
          )}

          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: "0.5rem",
              marginTop: "1rem",
            }}
          >
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              style={{
                padding: "0.55rem 1rem",
                border: "1px solid var(--border, #e2e8f0)",
                borderRadius: 6,
                background: "var(--surface, #fff)",
                cursor: submitting ? "not-allowed" : "pointer",
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              style={{
                padding: "0.55rem 1rem",
                border: "none",
                borderRadius: 6,
                background: "var(--primary, #2563eb)",
                color: "#fff",
                fontWeight: 600,
                cursor: submitting ? "not-allowed" : "pointer",
                opacity: submitting ? 0.6 : 1,
              }}
            >
              {submitting ? "Saving…" : "Save changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "block", marginBottom: "0.75rem" }}>
      <span
        style={{
          display: "block",
          fontSize: "0.8rem",
          fontWeight: 600,
          marginBottom: 4,
        }}
      >
        {label}
        {required && <span style={{ color: "#b91c1c" }}> *</span>}
        {hint && (
          <span
            style={{
              fontWeight: 400,
              color: "var(--text-subtle)",
              marginLeft: 6,
            }}
          >
            {hint}
          </span>
        )}
      </span>
      {children}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "0.5rem 0.6rem",
  border: "1px solid var(--border, #e2e8f0)",
  borderRadius: 6,
  font: "inherit",
  boxSizing: "border-box",
};
