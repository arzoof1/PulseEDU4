import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { authFetch } from "../lib/authToken";

// Self-service two-factor authentication (TOTP) enrollment + management for
// staff. Talks to the /api/auth/mfa/* endpoints. Voluntary/opt-in: enrolling
// here does not change login yet (enforcement lands in a later slice).

type Status = {
  enrolled: boolean;
  required: boolean;
  recoveryCodesRemaining: number;
};

type Props = { onClose: () => void };

const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.45)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};
const card: React.CSSProperties = {
  background: "#fff",
  borderRadius: 10,
  padding: 20,
  width: "min(460px, 92vw)",
  maxHeight: "90vh",
  overflow: "auto",
  boxShadow: "0 10px 40px rgba(0,0,0,0.25)",
};
const errorBox: React.CSSProperties = {
  background: "#fee2e2",
  color: "#991b1b",
  padding: 8,
  borderRadius: 6,
  fontSize: 13,
  marginBottom: 10,
};

export default function TwoFactorSettings({ onClose }: Props) {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<Status | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Setup flow state.
  const [setupSecret, setSetupSecret] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");
  // Recovery codes are returned exactly once (after enroll or regenerate).
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  const loadStatus = useCallback(async () => {
    setError("");
    try {
      const res = await authFetch("/api/auth/mfa/status");
      if (res.status === 404) {
        setUnavailable(true);
        return;
      }
      if (!res.ok) throw new Error(`Failed to load (${res.status})`);
      setStatus((await res.json()) as Status);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const messageFor = (err: string, status: number): string => {
    if (err === "invalid_code")
      return "That code didn't match. Enter the current 6-digit code from your authenticator app.";
    if (err === "already_enrolled")
      return "Two-factor authentication is already on.";
    return err || `Request failed (${status})`;
  };

  const beginSetup = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await authFetch("/api/auth/mfa/setup", { method: "POST" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(messageFor(j.error, res.status));
      }
      const { secret, otpauthUri } = (await res.json()) as {
        secret: string;
        otpauthUri: string;
      };
      setSetupSecret(secret);
      setQrDataUrl(await QRCode.toDataURL(otpauthUri, { margin: 1, width: 200 }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const verifySetup = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await authFetch("/api/auth/mfa/verify-setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim() }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(messageFor(j.error, res.status));
      }
      const { recoveryCodes: rc } = (await res.json()) as {
        recoveryCodes: string[];
      };
      setRecoveryCodes(rc);
      setSetupSecret(null);
      setQrDataUrl(null);
      setCode("");
      await loadStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const stepUpAction = async (
    path: string,
    promptText: string,
    onCodes?: (codes: string[]) => void,
  ) => {
    const entered = window.prompt(promptText);
    if (!entered) return;
    setBusy(true);
    setError("");
    try {
      const res = await authFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: entered.trim() }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(messageFor(j.error, res.status));
      }
      const j = await res.json().catch(() => ({}));
      if (onCodes && Array.isArray(j.recoveryCodes)) onCodes(j.recoveryCodes);
      await loadStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const copyCodes = () => {
    if (recoveryCodes) {
      void navigator.clipboard?.writeText(recoveryCodes.join("\n"));
    }
  };

  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <div role="dialog" aria-modal="true" style={overlay} onClick={onClose}>
      <div style={card} onClick={stop}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 12,
          }}
        >
          <h3 style={{ margin: 0 }}>Two-factor authentication</h3>
          <button type="button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {error && (
          <div role="alert" style={errorBox}>
            {error}
          </div>
        )}

        {loading ? (
          <div style={{ fontSize: 14, color: "#555" }}>Loading…</div>
        ) : unavailable ? (
          <div style={{ fontSize: 14, color: "#555" }}>
            Two-factor authentication isn't enabled on this server yet.
          </div>
        ) : recoveryCodes ? (
          // ---- Recovery codes (shown once) ------------------------------
          <div>
            <p style={{ fontSize: 14, marginTop: 0 }}>
              <strong>Save your recovery codes.</strong> Each can be used once
              if you lose access to your authenticator app. They won't be shown
              again.
            </p>
            <pre
              style={{
                background: "#f8fafc",
                border: "1px solid #e2e8f0",
                borderRadius: 8,
                padding: 12,
                fontSize: 14,
                lineHeight: 1.7,
                letterSpacing: 1,
              }}
            >
              {recoveryCodes.join("\n")}
            </pre>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" onClick={copyCodes}>
                Copy codes
              </button>
              <button type="button" onClick={() => setRecoveryCodes(null)}>
                Done
              </button>
            </div>
          </div>
        ) : status?.enrolled ? (
          // ---- Enrolled state -------------------------------------------
          <div>
            <p style={{ fontSize: 14, marginTop: 0 }}>
              ✅ Two-factor authentication is <strong>on</strong> for your
              account.
            </p>
            <p style={{ fontSize: 13, color: "#555" }}>
              Recovery codes remaining: {status.recoveryCodesRemaining}
            </p>
            <div
              style={{
                display: "flex",
                gap: 8,
                justifyContent: "flex-end",
                flexWrap: "wrap",
              }}
            >
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  stepUpAction(
                    "/api/auth/mfa/recovery-codes/regenerate",
                    "Enter a current 6-digit code to regenerate recovery codes:",
                    (codes) => setRecoveryCodes(codes),
                  )
                }
              >
                Regenerate recovery codes
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  stepUpAction(
                    "/api/auth/mfa/disable",
                    "Enter a current 6-digit code (or a recovery code) to turn off two-factor:",
                  )
                }
              >
                Turn off
              </button>
            </div>
          </div>
        ) : setupSecret ? (
          // ---- Setup: scan + verify -------------------------------------
          <div>
            <p style={{ fontSize: 14, marginTop: 0 }}>
              Scan this with an authenticator app (Google Authenticator, Authy,
              1Password…), then enter the 6-digit code it shows.
            </p>
            {qrDataUrl && (
              <div style={{ textAlign: "center", margin: "8px 0" }}>
                <img
                  src={qrDataUrl}
                  alt="Authenticator QR code"
                  width={200}
                  height={200}
                />
              </div>
            )}
            <p style={{ fontSize: 12, color: "#555", wordBreak: "break-all" }}>
              Can't scan? Enter this key manually: <code>{setupSecret}</code>
            </p>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              style={{
                width: "100%",
                padding: "8px 10px",
                fontSize: 18,
                letterSpacing: 4,
                textAlign: "center",
                margin: "8px 0",
              }}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setSetupSecret(null);
                  setQrDataUrl(null);
                  setCode("");
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy || code.length !== 6}
                onClick={verifySetup}
              >
                {busy ? "Verifying…" : "Verify & turn on"}
              </button>
            </div>
          </div>
        ) : (
          // ---- Not enrolled: intro --------------------------------------
          <div>
            <p style={{ fontSize: 14, marginTop: 0 }}>
              Add a second step at sign-in using an authenticator app — a strong
              protection for your account.
            </p>
            {status?.required && (
              <div
                style={{
                  background: "#fef9c3",
                  color: "#854d0e",
                  padding: 8,
                  borderRadius: 6,
                  fontSize: 13,
                  marginBottom: 10,
                }}
              >
                Your district requires two-factor authentication for your role.
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button type="button" disabled={busy} onClick={beginSetup}>
                {busy ? "Starting…" : "Set up two-factor"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
