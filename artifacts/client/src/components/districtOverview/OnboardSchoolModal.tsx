// Onboard-a-School modal. SuperUser-only. Adds a school under an
// EXISTING district (district preselected from the card the user
// clicked). Mirrors OnboardDistrictModal's UX:
//   * required fields validated client-side
//   * one transactional POST /api/tenancy/onboard-school
//   * success view surfaces a one-time temp password the SuperUser
//     copies in band — the server does not retain it

import { useState } from "react";
import { authFetch } from "../../lib/authToken";

type Props = {
  district: { id: number; name: string };
  onClose: () => void;
  onCreated: () => void;
};

type SuccessPayload = {
  district: { id: number; name: string; slug: string };
  school: { id: number; name: string; shortName: string | null };
  admin: { id: number; email: string; displayName: string };
  tempPassword: string;
};

export default function OnboardSchoolModal({
  district,
  onClose,
  onCreated,
}: Props) {
  const [schoolName, setSchoolName] = useState("");
  const [schoolShortName, setSchoolShortName] = useState("");
  const [stateSchoolCode, setStateSchoolCode] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [adminFirstName, setAdminFirstName] = useState("");
  const [adminLastName, setAdminLastName] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<SuccessPayload | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await authFetch("/api/tenancy/onboard-school", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          districtId: district.id,
          schoolName,
          schoolShortName: schoolShortName || undefined,
          stateSchoolCode: stateSchoolCode || undefined,
          adminEmail,
          adminFirstName,
          adminLastName,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setSuccess((await res.json()) as SuccessPayload);
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
    opts: { required?: boolean; placeholder?: string; type?: string } = {},
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
          type={opts.type ?? "text"}
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
          maxWidth: 520,
          padding: "1.25rem 1.5rem",
          boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "0.25rem",
          }}
        >
          <h2 style={{ margin: 0 }}>
            {success ? "School added" : "Add a school"}
          </h2>
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
        <p
          style={{
            margin: "0 0 1rem",
            color: "var(--text-subtle)",
            fontSize: "0.85rem",
          }}
        >
          District: <strong>{district.name}</strong>
        </p>

        {success ? (
          <div>
            <p style={{ color: "var(--text-subtle)", marginTop: 0 }}>
              {success.school.name} → {success.admin.displayName} (
              {success.admin.email}).
            </p>
            <div
              style={{
                marginTop: "1rem",
                padding: "0.75rem",
                background: "#fef3c7",
                border: "1px solid #f59e0b",
                borderRadius: 6,
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                One-time temp password
              </div>
              <div style={{ fontSize: "0.75rem", marginBottom: 6 }}>
                Copy this now — it is not stored on the server and cannot be
                retrieved later. Hand it to the new admin in band; they can
                change it on first login.
              </div>
              <code
                style={{
                  display: "block",
                  padding: "0.5rem",
                  background: "#fff",
                  border: "1px solid #fde68a",
                  borderRadius: 4,
                  fontFamily: "ui-monospace, monospace",
                  fontSize: "0.95rem",
                  userSelect: "all",
                }}
              >
                {success.tempPassword}
              </code>
            </div>
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
                onClick={onCreated}
                style={{
                  padding: "0.55rem 1rem",
                  border: "none",
                  borderRadius: 6,
                  background: "var(--primary, #2563eb)",
                  color: "#fff",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={submit}>
            <h3 style={{ marginTop: 0, marginBottom: "0.5rem" }}>School</h3>
            {field("School name", schoolName, setSchoolName, {
              required: true,
              placeholder: "West Hernando Middle School",
            })}
            {field(
              "Short name (optional)",
              schoolShortName,
              setSchoolShortName,
              { placeholder: "WHMS" },
            )}
            {field(
              "State school code (optional)",
              stateSchoolCode,
              setStateSchoolCode,
              { placeholder: "0271" },
            )}

            <h3 style={{ marginTop: "1.25rem", marginBottom: "0.5rem" }}>
              First Admin
            </h3>
            {field("Admin email", adminEmail, setAdminEmail, {
              required: true,
              type: "email",
              placeholder: "principal@whms.k12.fl.us",
            })}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 8,
              }}
            >
              {field("First name", adminFirstName, setAdminFirstName, {
                required: true,
              })}
              {field("Last name", adminLastName, setAdminLastName, {
                required: true,
              })}
            </div>

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
                {submitting ? "Creating…" : "Add school"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
