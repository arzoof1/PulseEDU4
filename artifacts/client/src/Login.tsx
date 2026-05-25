import { useState } from "react";
import { setAuthToken } from "./lib/authToken";

export interface AuthUser {
  id: number;
  email: string;
  displayName: string;
  isAdmin: boolean;
  isEseCoordinator: boolean;
  isPbisCoordinator: boolean;
  isBehaviorSpecialist: boolean;
}

export default function Login({
  onLogin,
}: {
  onLogin: (user: AuthUser) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? `Sign-in failed (${res.status})`);
        return;
      }
      const user: AuthUser & { authToken?: string } = await res.json();
      if (user.authToken) setAuthToken(user.authToken);
      onLogin(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

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
      <form
        onSubmit={handleSubmit}
        style={{
          background: "rgba(255,255,255,0.06)",
          border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: 12,
          padding: "2rem",
          width: "min(420px, 92vw)",
          display: "flex",
          flexDirection: "column",
          gap: "1rem",
        }}
      >
        <div style={{ textAlign: "center", marginBottom: "0.5rem" }}>
          <div style={{ fontSize: "1.5rem", fontWeight: 700, letterSpacing: "0.02em" }}>
            Pulse<span style={{ color: "#3b82f6" }}>EDU</span>
          </div>
          <div style={{ fontSize: "0.9rem", opacity: 0.7, marginTop: 4 }}>
            Sign in to continue
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

        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontSize: "0.85rem", opacity: 0.85 }}>Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            style={inputStyle}
          />
        </label>

        {error && (
          <div
            style={{
              background: "rgba(239,68,68,0.15)",
              border: "1px solid rgba(239,68,68,0.4)",
              color: "#fecaca",
              padding: "0.6rem 0.9rem",
              borderRadius: 8,
              fontSize: "0.9rem",
            }}
          >
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={busy || !email.trim() || !password}
          style={{
            background:
              busy || !email.trim() || !password
                ? "rgba(59,130,246,0.4)"
                : "#3b82f6",
            color: "#fff",
            border: "none",
            borderRadius: 8,
            padding: "0.75rem 1rem",
            fontSize: "1rem",
            fontWeight: 600,
            cursor:
              busy || !email.trim() || !password ? "not-allowed" : "pointer",
          }}
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>

        {/* Parent-brand footer. PulseEDU is one of several school /
            organization apps offered under Pulse Kinetics; the link
            takes prospective customers (and anyone curious about the
            company) back to the marketing site. Kept compact + low
            contrast so it doesn't compete with the sign-in form. */}
        <div
          style={{
            textAlign: "center",
            fontSize: "0.75rem",
            opacity: 0.6,
            marginTop: "0.25rem",
            lineHeight: 1.4,
          }}
        >
          A Pulse Kinetics product ·{" "}
          <a
            href="https://pulsekinetics.us"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "#93c5fd", textDecoration: "none" }}
          >
            pulsekinetics.us
          </a>
        </div>
      </form>
    </div>
  );
}

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
