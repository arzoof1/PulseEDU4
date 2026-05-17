// Edit-a-School modal. SuperUser-only. Calls
// PATCH /api/tenancy/schools/:id with only the fields the user changed.
// Deactivate / reactivate is a separate inline button in the parent
// table, not a checkbox here — fewer accidental toggles.

import { useState } from "react";
import { authFetch } from "../../lib/authToken";

type Props = {
  school: {
    id: number;
    name: string;
    shortName: string | null;
    stateSchoolCode: string | null;
  };
  onClose: () => void;
  onSaved: () => void;
};

export default function EditSchoolModal({ school, onClose, onSaved }: Props) {
  const [name, setName] = useState(school.name);
  const [shortName, setShortName] = useState(school.shortName ?? "");
  const [stateSchoolCode, setStateSchoolCode] = useState(
    school.stateSchoolCode ?? "",
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      // Send only changed fields. Empty string for the optional fields
      // means "clear it" (the server normalizes "" → null).
      const patch: Record<string, unknown> = {};
      if (name.trim() !== school.name) patch.name = name.trim();
      if (shortName !== (school.shortName ?? "")) {
        patch.shortName = shortName.trim() || null;
      }
      if (stateSchoolCode !== (school.stateSchoolCode ?? "")) {
        patch.stateSchoolCode = stateSchoolCode.trim() || null;
      }
      if (Object.keys(patch).length === 0) {
        onClose();
        return;
      }
      const res = await authFetch(`/api/tenancy/schools/${school.id}`, {
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

  function field(
    label: string,
    value: string,
    onChange: (v: string) => void,
    opts: { required?: boolean; placeholder?: string } = {},
  ) {
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
          {opts.required && <span style={{ color: "#b91c1c" }}> *</span>}
        </span>
        <input
          type="text"
          value={value}
          required={opts.required}
          placeholder={opts.placeholder}
          onChange={(e) => onChange(e.target.value)}
          style={{
            width: "100%",
            padding: "0.5rem 0.6rem",
            border: "1px solid var(--border, #e2e8f0)",
            borderRadius: 6,
            font: "inherit",
            boxSizing: "border-box",
          }}
        />
      </label>
    );
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
          <h2 style={{ margin: 0 }}>Edit school</h2>
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
          {field("School name", name, setName, { required: true })}
          {field("Short name", shortName, setShortName, {
            placeholder: "(optional)",
          })}
          {field("State school code", stateSchoolCode, setStateSchoolCode, {
            placeholder: "(optional)",
          })}

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
