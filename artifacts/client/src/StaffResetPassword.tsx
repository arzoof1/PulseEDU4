import { useEffect, useState } from "react";
import { setAuthToken } from "./lib/authToken";
import {
  Centered,
  cardStyle,
  inputStyle,
  errorStyle,
  primaryButtonStyle,
} from "./StaffForgotPassword";

const APP_ROOT = import.meta.env.BASE_URL || "/";

interface ResetInfo {
  email: string;
  displayName: string;
}

export default function StaffResetPassword({ token }: { token: string }) {
  const [loading, setLoading] = useState(true);
  const [info, setInfo] = useState<ResetInfo | null>(null);
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/auth/reset/${encodeURIComponent(token)}`,
          { credentials: "include" },
        );
        if (cancelled) return;
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(body.error ?? "This reset link is no longer valid.");
        } else {
          setInfo((await res.json()) as ResetInfo);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Network error");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/reset", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword: password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setError(body.error ?? `Could not reset password (${res.status})`);
        return;
      }
      const body = (await res.json()) as { authToken?: string };
      if (body.authToken) setAuthToken(body.authToken);
      // Hard-redirect to the app root — /auth/me will pick up the fresh
      // bearer token and land the user in the app, signed in.
      window.location.href = APP_ROOT;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <Centered>
        <div style={{ opacity: 0.7, fontSize: "0.9rem" }}>Loading…</div>
      </Centered>
    );
  }

  if (!info) {
    return (
      <Centered>
        <div style={{ ...cardStyle, textAlign: "center", gap: "0.75rem" }}>
          <div style={{ fontSize: "1.2rem", fontWeight: 600 }}>
            Reset link unavailable
          </div>
          <div style={{ fontSize: "0.9rem", opacity: 0.8 }}>
            {error || "This reset link is no longer valid."}
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
            <button
              onClick={() => {
                window.location.href = `${APP_ROOT}forgot-password`;
              }}
              style={primaryButtonStyle(false)}
            >
              Request a new link
            </button>
            <button
              onClick={() => {
                window.location.href = APP_ROOT;
              }}
              style={{
                ...primaryButtonStyle(false),
                background: "rgba(255,255,255,0.12)",
              }}
            >
              Sign in
            </button>
          </div>
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
            Choose a new password
          </div>
        </div>

        <div
          style={{
            background: "rgba(15,23,42,0.4)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 8,
            padding: "0.6rem 0.8rem",
            fontSize: "0.9rem",
          }}
        >
          <div style={{ fontSize: "0.75rem", opacity: 0.6 }}>Account</div>
          <div style={{ fontWeight: 600 }}>{info.email}</div>
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontSize: "0.85rem", opacity: 0.85 }}>
            New password
          </span>
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            style={inputStyle}
          />
          <span style={{ fontSize: "0.75rem", opacity: 0.55 }}>
            Minimum 8 characters.
          </span>
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontSize: "0.85rem", opacity: 0.85 }}>
            Confirm password
          </span>
          <input
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            disabled={busy}
            style={inputStyle}
          />
        </label>

        {error && <div style={errorStyle}>{error}</div>}

        <button
          type="submit"
          disabled={busy || password.length < 8}
          style={primaryButtonStyle(busy || password.length < 8)}
        >
          {busy ? "Saving…" : "Set new password"}
        </button>
      </form>
    </Centered>
  );
}
