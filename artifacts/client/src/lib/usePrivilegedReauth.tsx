import { useCallback, useState, type CSSProperties } from "react";
import { authFetch } from "./authToken";

// Client half of the privileged step-up reauth (Section 1.15). A sensitive
// action (bulk export, Safety Plan viewing) hits an endpoint that 403s with
// { error: "reauth_required" } when the session has no recent step-up. This
// hook shows a modal that POSTs /api/auth/reauth to open the window, then the
// caller retries. One confirmation covers a short server-side window, so the
// user is not prompted on every click.

type Pending = { resolve: (ok: boolean) => void } | null;

export function usePrivilegedReauth() {
  const [pending, setPending] = useState<Pending>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const ensureReauth = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        setPassword("");
        setCode("");
        setError("");
        setBusy(false);
        setPending({ resolve });
      }),
    [],
  );

  function finish(ok: boolean) {
    setPending((p) => {
      p?.resolve(ok);
      return null;
    });
  }

  async function submit() {
    if (!password.trim()) {
      setError("Enter your current password.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await authFetch("/api/auth/reauth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: password,
          code: code.trim() || undefined,
        }),
      });
      if (res.ok) {
        finish(true);
        return;
      }
      const j = await res.json().catch(() => ({}) as { error?: string });
      if (j.error === "mfa_code_required") {
        setError("Enter your MFA code or a recovery code.");
      } else if (res.status === 401) {
        setError("Incorrect password or code.");
      } else {
        setError(j.error || "Verification failed. Try again.");
      }
    } catch {
      setError("Verification failed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const reauthModal = pending ? (
    <div style={overlay} role="dialog" aria-modal="true">
      <div style={box}>
        <h3 style={{ margin: "0 0 8px" }}>Confirm it's you</h3>
        <p style={{ margin: "0 0 12px", fontSize: 13, color: "#444" }}>
          This is a sensitive action. Re-enter your current password (and your
          MFA code if your account uses two-factor) to continue.
        </p>
        <label style={labelStyle}>
          <span>Current password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
            style={inputStyle}
            autoFocus
          />
        </label>
        <label style={labelStyle}>
          <span>MFA code or recovery code</span>
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
            placeholder="If your account uses two-factor"
            style={inputStyle}
          />
        </label>
        {error && (
          <div style={{ color: "#991b1b", fontSize: 12, marginTop: 6 }}>
            {error}
          </div>
        )}
        <div style={actionsStyle}>
          <button type="button" onClick={() => finish(false)} disabled={busy}>
            Cancel
          </button>
          <button type="button" onClick={() => void submit()} disabled={busy}>
            {busy ? "Verifying…" : "Confirm"}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return { ensureReauth, reauthModal };
}

// Run a fetch; if it 403s with reauth_required, prompt for step-up and retry
// once. Returns the (possibly retried) Response, or null if the user cancels.
export async function fetchWithReauth(
  ensureReauth: () => Promise<boolean>,
  doFetch: () => Promise<Response>,
): Promise<Response | null> {
  let res = await doFetch();
  if (res.status === 403) {
    const body = (await res
      .clone()
      .json()
      .catch(() => ({}))) as { error?: string };
    if (body?.error === "reauth_required") {
      const ok = await ensureReauth();
      if (!ok) return null;
      res = await doFetch();
    }
  }
  return res;
}

const overlay: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.4)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 10000,
};
const box: CSSProperties = {
  background: "#fff",
  color: "#111",
  borderRadius: 10,
  padding: 20,
  width: 360,
  maxWidth: "90vw",
  boxShadow: "0 10px 40px rgba(0,0,0,0.25)",
};
const labelStyle: CSSProperties = {
  display: "grid",
  gap: 3,
  fontSize: 12,
  marginTop: 8,
};
const inputStyle: CSSProperties = {
  width: "100%",
  padding: "6px 8px",
  boxSizing: "border-box",
};
const actionsStyle: CSSProperties = {
  display: "flex",
  gap: 8,
  justifyContent: "flex-end",
  marginTop: 14,
};
