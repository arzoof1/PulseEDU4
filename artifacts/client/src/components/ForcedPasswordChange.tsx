// Full-screen, non-dismissible "choose your password" wall.
//
// Shown when authUser.mustSetPassword is set — the account is signed in with a
// credential an admin issued (a bulk-generated temp password handed over on
// paper/CSV, or a roster-sync placeholder). The server enforces the same state
// via passwordSetupGate, which 403s every route except this one, so this screen
// is the UI half of a server-authoritative wall — not a courtesy prompt. There
// is deliberately no Cancel; the only ways out are setting a password or
// signing out.
//
// Posts to the existing POST /api/auth/change-password, which already clears
// must_set_password, enforces the policy, and rotates the auth token version.

import { useState } from "react";
import { authFetch } from "../lib/authToken";

// Mirrors meetsStaffPasswordPolicy on the server (auth.ts). Checked here so the
// user gets a specific, actionable message instead of the server's single
// catch-all 400 string.
const RULES: Array<{ label: string; test: (v: string) => boolean }> = [
  { label: "At least 8 characters", test: (v) => v.length >= 8 },
  { label: "An uppercase letter", test: (v) => /[A-Z]/.test(v) },
  { label: "A lowercase letter", test: (v) => /[a-z]/.test(v) },
  { label: "A number", test: (v) => /\d/.test(v) },
  { label: "A special character", test: (v) => /[^A-Za-z0-9]/.test(v) },
];

export default function ForcedPasswordChange({
  displayName,
  onDone,
}: {
  displayName?: string | null;
  onDone: () => void;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const failedRules = RULES.filter((r) => !r.test(newPassword));
  const mismatch = confirmPassword.length > 0 && confirmPassword !== newPassword;
  const canSubmit =
    !busy &&
    currentPassword.length > 0 &&
    failedRules.length === 0 &&
    newPassword === confirmPassword;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setErr("");
    try {
      const res = await authFetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(body.error || `Could not set password (${res.status})`);
      }
      onDone();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    try {
      await authFetch("/api/auth/logout", { method: "POST" });
    } catch {
      // Ignore — reloading lands on the login screen either way.
    }
    window.location.reload();
  }

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 8,
    border: "1px solid var(--border, #d1d5db)",
    fontSize: 15,
    marginTop: 6,
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        background: "var(--surface-2, #f3f4f6)",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <form
        onSubmit={submit}
        style={{
          width: "100%",
          maxWidth: 460,
          background: "var(--surface, #fff)",
          borderRadius: 12,
          padding: 28,
          boxShadow: "0 20px 45px rgba(15, 23, 42, 0.15)",
        }}
      >
        <h1 style={{ margin: "0 0 6px", fontSize: 22 }}>Choose your password</h1>
        <p
          style={{
            margin: "0 0 20px",
            fontSize: 14,
            color: "var(--muted, #6b7280)",
            lineHeight: 1.5,
          }}
        >
          {displayName ? `Welcome, ${displayName}. ` : ""}
          You signed in with a temporary password issued by your administrator.
          Pick your own password to finish setting up your account.
        </p>

        <label style={{ display: "block", marginBottom: 14, fontSize: 14 }}>
          Temporary password
          <input
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            style={inputStyle}
          />
        </label>

        <label style={{ display: "block", marginBottom: 14, fontSize: 14 }}>
          New password
          <input
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            style={inputStyle}
          />
        </label>

        <label style={{ display: "block", marginBottom: 14, fontSize: 14 }}>
          Confirm new password
          <input
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            style={{
              ...inputStyle,
              borderColor: mismatch ? "#dc2626" : inputStyle.borderColor,
            }}
          />
        </label>

        <ul
          style={{
            listStyle: "none",
            padding: 0,
            margin: "0 0 18px",
            fontSize: 13,
          }}
        >
          {RULES.map((r) => {
            const ok = r.test(newPassword);
            return (
              <li
                key={r.label}
                style={{
                  color: ok ? "#15803d" : "var(--muted, #6b7280)",
                  padding: "2px 0",
                }}
              >
                {ok ? "✓" : "•"} {r.label}
              </li>
            );
          })}
          {mismatch && (
            <li style={{ color: "#b91c1c", padding: "2px 0" }}>
              • Passwords do not match
            </li>
          )}
        </ul>

        {err && (
          <div
            role="alert"
            style={{
              marginBottom: 16,
              padding: "10px 12px",
              borderRadius: 8,
              background: "#fef2f2",
              border: "1px solid #fecaca",
              color: "#991b1b",
              fontSize: 13,
            }}
          >
            {err}
          </div>
        )}

        <button
          type="submit"
          disabled={!canSubmit}
          style={{
            width: "100%",
            padding: "11px 14px",
            borderRadius: 8,
            border: "none",
            background: canSubmit ? "#2563eb" : "#9ca3af",
            color: "#fff",
            fontWeight: 600,
            fontSize: 15,
            cursor: canSubmit ? "pointer" : "not-allowed",
          }}
        >
          {busy ? "Saving…" : "Set password and continue"}
        </button>

        <button
          type="button"
          onClick={() => void signOut()}
          style={{
            width: "100%",
            marginTop: 10,
            padding: "9px 14px",
            borderRadius: 8,
            border: "none",
            background: "transparent",
            color: "var(--muted, #6b7280)",
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          Sign out instead
        </button>
      </form>
    </div>
  );
}
