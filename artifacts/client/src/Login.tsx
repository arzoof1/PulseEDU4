import { useState } from "react";
import { setAuthToken } from "./lib/authToken";
import { setCsrfToken } from "./lib/csrf";

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
  const initialResetToken = (() => {
    const marker = "/reset-password/";
    const path = window.location.pathname;
    const idx = path.indexOf(marker);
    if (idx < 0) return "";
    return decodeURIComponent(path.slice(idx + marker.length));
  })();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [forgotEmail, setForgotEmail] = useState("");
  const [resetPassword, setResetPassword] = useState("");
  const [resetConfirm, setResetConfirm] = useState("");
  const [mode, setMode] = useState<"login" | "forgot" | "reset">(
    initialResetToken ? "reset" : "login",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const passwordPolicyOk = (value: string) =>
    value.length >= 8 &&
    /[A-Z]/.test(value) &&
    /[a-z]/.test(value) &&
    /\d/.test(value) &&
    /[^A-Za-z0-9]/.test(value);

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
      const user: AuthUser & { authToken?: string; csrfToken?: string } =
        await res.json();
      if (user.authToken) setAuthToken(user.authToken);
      if (user.csrfToken) setCsrfToken(user.csrfToken);
      onLogin(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  async function handleForgotPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!forgotEmail.trim()) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: forgotEmail.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? `Request failed (${res.status})`);
        return;
      }
      setMessage(
        body.message ??
          "If an active staff account exists for that email, a password reset link has been sent.",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  async function handleResetPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!initialResetToken || !passwordPolicyOk(resetPassword)) return;
    if (resetPassword !== resetConfirm) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: initialResetToken,
          newPassword: resetPassword,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? `Reset failed (${res.status})`);
        return;
      }
      setMessage("Password updated. You can now sign in.");
      setResetPassword("");
      setResetConfirm("");
      window.history.replaceState({}, "", "/");
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
        onSubmit={
          mode === "forgot"
            ? handleForgotPassword
            : mode === "reset"
              ? handleResetPassword
              : handleSubmit
        }
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
            {mode === "forgot"
              ? "Reset your staff password"
              : mode === "reset"
                ? "Choose a new staff password"
                : "Sign in to continue"}
          </div>
        </div>

        {mode === "forgot" ? (
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: "0.85rem", opacity: 0.85 }}>
              Staff email
            </span>
            <input
              type="email"
              autoComplete="username"
              autoFocus
              value={forgotEmail}
              onChange={(e) => setForgotEmail(e.target.value)}
              disabled={busy}
              style={inputStyle}
            />
          </label>
        ) : mode === "reset" ? (
          <>
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ fontSize: "0.85rem", opacity: 0.85 }}>
                New password
              </span>
              <input
                type="password"
                autoComplete="new-password"
                autoFocus
                value={resetPassword}
                onChange={(e) => setResetPassword(e.target.value)}
                disabled={busy || !!message}
                style={inputStyle}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ fontSize: "0.85rem", opacity: 0.85 }}>
                Confirm new password
              </span>
              <input
                type="password"
                autoComplete="new-password"
                value={resetConfirm}
                onChange={(e) => setResetConfirm(e.target.value)}
                disabled={busy || !!message}
                style={inputStyle}
              />
            </label>
            <div style={{ fontSize: "0.8rem", opacity: 0.75 }}>
              Use at least 8 characters with uppercase, lowercase, number, and
              special character.
            </div>
          </>
        ) : (
          <>
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
              <span style={{ fontSize: "0.85rem", opacity: 0.85 }}>
                Password
              </span>
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={busy}
                style={inputStyle}
              />
            </label>
          </>
        )}

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
        {message && (
          <div
            style={{
              background: "rgba(34,197,94,0.15)",
              border: "1px solid rgba(34,197,94,0.4)",
              color: "#bbf7d0",
              padding: "0.6rem 0.9rem",
              borderRadius: 8,
              fontSize: "0.9rem",
            }}
          >
            {message}
          </div>
        )}

        <button
          type="submit"
          disabled={
            busy ||
            (mode === "login" && (!email.trim() || !password)) ||
            (mode === "forgot" && !forgotEmail.trim()) ||
            (mode === "reset" &&
              (!passwordPolicyOk(resetPassword) ||
                resetPassword !== resetConfirm ||
                !!message))
          }
          style={{
            background:
              busy ||
              (mode === "login" && (!email.trim() || !password)) ||
              (mode === "forgot" && !forgotEmail.trim()) ||
              (mode === "reset" &&
                (!passwordPolicyOk(resetPassword) ||
                  resetPassword !== resetConfirm ||
                  !!message))
                ? "rgba(59,130,246,0.4)"
                : "#3b82f6",
            color: "#fff",
            border: "none",
            borderRadius: 8,
            padding: "0.75rem 1rem",
            fontSize: "1rem",
            fontWeight: 600,
            cursor:
              busy ||
              (mode === "login" && (!email.trim() || !password)) ||
              (mode === "forgot" && !forgotEmail.trim()) ||
              (mode === "reset" &&
                (!passwordPolicyOk(resetPassword) ||
                  resetPassword !== resetConfirm ||
                  !!message))
                ? "not-allowed"
                : "pointer",
          }}
        >
          {busy
            ? mode === "login"
              ? "Signing in…"
              : "Saving…"
            : mode === "forgot"
              ? "Send reset link"
              : mode === "reset"
                ? "Update password"
                : "Sign in"}
        </button>
        {mode === "login" ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setMode("forgot");
              setError("");
              setMessage("");
              setForgotEmail(email);
            }}
            style={linkButtonStyle}
          >
            Forgot password?
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setMode("login");
              setError("");
              setMessage("");
              window.history.replaceState({}, "", "/");
            }}
            style={linkButtonStyle}
          >
            Back to sign in
          </button>
        )}

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
          {" · "}
          <a
            href="/sms-policy"
            style={{ color: "#93c5fd", textDecoration: "none" }}
          >
            SMS policy
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

const linkButtonStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "#bfdbfe",
  cursor: "pointer",
  fontSize: "0.9rem",
  padding: 0,
  textDecoration: "underline",
};
