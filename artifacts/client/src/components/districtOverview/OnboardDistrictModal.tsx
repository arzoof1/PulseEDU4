// Onboard-a-District modal. SuperUser-only end-to-end form: district +
// first school + first admin in one transactional call to
// POST /api/tenancy/onboard-district. The server generates a one-time
// temp password and returns it in the success response; we surface that
// password ONCE in a "saved" panel so the SuperUser can copy it out
// before closing the modal.

import { useState } from "react";
import { authFetch } from "../../lib/authToken";
import { usePlans } from "./usePlans";

type Props = {
  onClose: () => void;
  onCreated: () => void;
};

type SuccessPayload = {
  district: { id: number; name: string; slug: string };
  school: { id: number; name: string; shortName: string | null };
  admin: { id: number; email: string; displayName: string };
  tempPassword: string;
};

// Reasonable defaults for the timezone select. Schools outside Eastern can
// pick from the dropdown; if their IANA isn't listed they can extend later.
const TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Phoenix",
  "America/Anchorage",
  "Pacific/Honolulu",
];

function autoSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export default function OnboardDistrictModal({ onClose, onCreated }: Props) {
  const [districtName, setDistrictName] = useState("");
  const [districtSlug, setDistrictSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [stateDistrictCode, setStateDistrictCode] = useState("");
  const [timezone, setTimezone] = useState("America/New_York");
  const [schoolName, setSchoolName] = useState("");
  const [schoolShortName, setSchoolShortName] = useState("");
  const [stateSchoolCode, setStateSchoolCode] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [adminFirstName, setAdminFirstName] = useState("");
  const [adminLastName, setAdminLastName] = useState("");
  const [planKey, setPlanKey] = useState("enterprise");
  const { plans, error: plansError } = usePlans();

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<SuccessPayload | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await authFetch("/api/tenancy/onboard-district", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          districtName,
          districtSlug,
          stateDistrictCode: stateDistrictCode || undefined,
          timezone,
          schoolName,
          schoolShortName: schoolShortName || undefined,
          stateSchoolCode: stateSchoolCode || undefined,
          adminEmail,
          adminFirstName,
          adminLastName,
          planKey,
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
          maxWidth: 560,
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
          <h2 style={{ margin: 0 }}>
            {success ? "District created" : "Onboard a District"}
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

        {success ? (
          <div>
            <p style={{ color: "var(--text-subtle)", marginTop: 0 }}>
              {success.district.name} → {success.school.name} →{" "}
              {success.admin.displayName} ({success.admin.email}).
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
                Copy this now — it is not stored on the server and cannot
                be retrieved later. Hand it to the new admin in band; they
                can change it on first login.
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
            <h3 style={{ marginTop: 0, marginBottom: "0.5rem" }}>District</h3>
            {field(
              "District name",
              districtName,
              (v) => {
                setDistrictName(v);
                if (!slugTouched) setDistrictSlug(autoSlug(v));
              },
              { required: true, placeholder: "Hernando County School District" },
            )}
            {field(
              "Slug (URL identifier)",
              districtSlug,
              (v) => {
                setDistrictSlug(v);
                setSlugTouched(true);
              },
              { required: true, placeholder: "hernando" },
            )}
            {field(
              "State district code (optional)",
              stateDistrictCode,
              setStateDistrictCode,
              { placeholder: "27" },
            )}
            <label style={{ display: "block", marginBottom: "0.75rem" }}>
              <span
                style={{
                  display: "block",
                  fontSize: "0.8rem",
                  fontWeight: 600,
                  marginBottom: 4,
                }}
              >
                Timezone
              </span>
              <select
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                style={{
                  width: "100%",
                  padding: "0.5rem 0.6rem",
                  border: "1px solid var(--border, #e2e8f0)",
                  borderRadius: 6,
                  font: "inherit",
                  boxSizing: "border-box",
                  background: "var(--surface, #fff)",
                }}
              >
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
            </label>

            <h3 style={{ marginTop: "1.25rem", marginBottom: "0.5rem" }}>
              First School
            </h3>
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

            <label style={{ display: "block", marginBottom: "0.75rem" }}>
              <span
                style={{
                  display: "block",
                  fontSize: "0.8rem",
                  fontWeight: 600,
                  marginBottom: 4,
                }}
              >
                Plan
              </span>
              <select
                value={planKey}
                onChange={(e) => setPlanKey(e.target.value)}
                disabled={plans === null}
                style={{
                  width: "100%",
                  padding: "0.5rem 0.6rem",
                  border: "1px solid var(--border, #e2e8f0)",
                  borderRadius: 6,
                  font: "inherit",
                  boxSizing: "border-box",
                  background: "var(--surface, #fff)",
                }}
              >
                {plans === null ? (
                  <option value="enterprise">Loading…</option>
                ) : (
                  plans.map((p) => (
                    <option key={p.id} value={p.key}>
                      {p.label} ({p.key})
                    </option>
                  ))
                )}
              </select>
              {plansError && (
                <span style={{ fontSize: "0.7rem", color: "#b91c1c" }}>
                  Could not load plans: {plansError}
                </span>
              )}
            </label>

            <h3 style={{ marginTop: "1.25rem", marginBottom: "0.5rem" }}>
              First Admin
            </h3>
            {field("Admin email", adminEmail, setAdminEmail, {
              required: true,
              type: "email",
              placeholder: "principal@whms.k12.fl.us",
            })}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
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
                {submitting ? "Creating…" : "Create district"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
