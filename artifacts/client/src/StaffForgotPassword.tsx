import { useState } from "react";

const APP_ROOT = import.meta.env.BASE_URL || "/";

export default function StaffForgotPassword() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setBusy(true);
    setError("");
    try {
      // Always 200 — the server intentionally doesn't reveal whether the
      // email matches a real account. Show the same "check your inbox"
      // screen either way.
      const res = await fetch("/api/auth/request-reset", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      if (!res.ok) {
        setError(`Could not submit request (${res.status})`);
        return;
      }
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  if (submitted) {
    return (
      <Centered>
        <div style={{ ...cardStyle, textAlign: "center", gap: "0.75rem" }}>
          <div style={{ fontSize: "1.4rem", fontWeight: 700 }}>
            Check your inbox
          </div>
          <div style={{ fontSize: "0.9rem", opacity: 0.8, lineHeight: 1.5 }}>
            If <strong>{email}</strong> matches a staff account, we just sent a
            link to reset your password. The link is good for 1 hour.
          </div>
          <div style={{ fontSize: "0.8rem", opacity: 0.6, marginTop: 4 }}>
            Didn't get it? Check your spam folder, or ask your school admin to
            confirm the email on file.
          </div>
          <button
            onClick={() => {
              window.location.href = APP_ROOT;
            }}
            style={primaryButtonStyle(false)}
          >
            Back to sign-in
          </button>
        </div>
      </Centered>
    );
  }

  return (
    <Centered>
      <form onSubmit={handleSubmit} style={cardStyle}>
        <div style={{ textAlign: "center", marginBottom: "0.5rem" }}>
          <div
            style={{
              fontSize: "1.5rem",
              fontWeight: 700,
              letterSpacing: "0.02em",
            }}
          >
            Pulse<span style={{ color: "#3b82f6" }}>EDU</span>
          </div>
          <div style={{ fontSize: "0.9rem", opacity: 0.7, marginTop: 4 }}>
            Reset your password
          </div>
          <div
            style={{
              fontSize: "0.8rem",
              opacity: 0.6,
              marginTop: 6,
              lineHeight: 1.4,
            }}
          >
            Enter the email your school has on file. We'll send you a link to
            choose a new password.
          </div>
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontSize: "0.85rem", opacity: 0.85 }}>Email</span>
          <input
            type="email"
            autoComplete="username"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
            style={inputStyle}
          />
        </label>

        {error && <div style={errorStyle}>{error}</div>}

        <button
          type="submit"
          disabled={busy || !email.trim()}
          style={primaryButtonStyle(busy || !email.trim())}
        >
          {busy ? "Sending…" : "Send reset link"}
        </button>

        <button
          type="button"
          onClick={() => {
            window.location.href = APP_ROOT;
          }}
          style={linkButtonStyle}
        >
          Back to sign-in
        </button>
      </form>
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "linear-gradient(180deg, #0f172a 0%, #1e293b 100%)",
        color: "#fff",
        fontFamily: "system-ui, sans-serif",
        padding: "2rem",
      }}
    >
      {children}
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 12,
  padding: "2rem",
  width: "min(420px, 92vw)",
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
};

const inputStyle: React.CSSProperties = {
  background: "rgba(15,23,42,0.6)",
  border: "1px solid rgba(255,255,255,0.2)",
  color: "#fff",
  borderRadius: 8,
  padding: "0.65rem 0.85rem",
  fontSize: "1rem",
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};

const errorStyle: React.CSSProperties = {
  background: "rgba(239,68,68,0.15)",
  border: "1px solid rgba(239,68,68,0.4)",
  color: "#fecaca",
  padding: "0.6rem 0.9rem",
  borderRadius: 8,
  fontSize: "0.9rem",
};

function primaryButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    background: disabled ? "rgba(59,130,246,0.4)" : "#3b82f6",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "0.75rem 1rem",
    fontSize: "1rem",
    fontWeight: 600,
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

const linkButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "rgba(255,255,255,0.6)",
  fontSize: "0.85rem",
  cursor: "pointer",
  textDecoration: "underline",
  textUnderlineOffset: 2,
};

export {
  Centered,
  cardStyle,
  inputStyle,
  errorStyle,
  primaryButtonStyle,
  linkButtonStyle,
};
