import { useEffect, useState } from "react";
import { Heart } from "lucide-react";
import { setParentToken, navigate, type ParentMe } from "./api";

interface ResetInfo {
  email: string;
  displayName: string;
}

export default function ResetPassword({
  token,
  onReset,
}: {
  token: string;
  onReset: (me: ParentMe) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [info, setInfo] = useState<ResetInfo | null>(null);
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [otpStep, setOtpStep] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/parent-auth/reset/${encodeURIComponent(token)}`,
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
      const res = await fetch("/api/parent-auth/reset", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          newPassword: password,
          ...(otpStep ? { code: code.trim() } : {}),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          requiresOtp?: boolean;
        };
        if (body.requiresOtp) {
          setOtpStep(true);
          setError(body.error ?? "Enter your 6-digit code.");
        } else {
          setError(body.error ?? `Could not reset password (${res.status})`);
        }
        return;
      }
      const body = await res.json();
      if (body.authToken) setParentToken(body.authToken);
      // Pull /me so the dashboard renders with student list.
      const meRes = await fetch("/api/parent-auth/me", {
        credentials: "include",
        headers: body.authToken
          ? { Authorization: `Bearer ${body.authToken}` }
          : {},
      });
      const me = (await meRes.json()) as ParentMe;
      if (me.authToken) setParentToken(me.authToken);
      onReset(me);
      navigate("/parent");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <Centered>
        <div className="text-white/70 text-sm">Loading…</div>
      </Centered>
    );
  }

  if (!info) {
    return (
      <Centered>
        <div className="bg-white/[0.06] border border-white/10 rounded-2xl p-8 max-w-md w-full text-center">
          <div className="text-lg font-semibold mb-2">
            Reset link unavailable
          </div>
          <div className="text-sm text-white/70 mb-4">
            {error || "This reset link is no longer valid."}
          </div>
          <button
            onClick={() => navigate("/parent/forgot-password")}
            className="bg-blue-500 hover:bg-blue-400 text-white font-semibold rounded-lg px-4 py-2 text-sm mr-2"
          >
            Request a new link
          </button>
          <button
            onClick={() => navigate("/parent/login")}
            className="bg-white/10 hover:bg-white/20 text-white font-semibold rounded-lg px-4 py-2 text-sm"
          >
            Sign in
          </button>
        </div>
      </Centered>
    );
  }

  return (
    <Centered>
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md bg-white/[0.06] border border-white/10 rounded-2xl p-8 flex flex-col gap-4 backdrop-blur"
      >
        <div className="flex flex-col items-center gap-2 mb-2">
          <div className="h-12 w-12 rounded-full bg-gradient-to-br from-violet-500 to-teal-500 flex items-center justify-center">
            <Heart className="h-6 w-6 text-white" fill="white" />
          </div>
          <div className="text-2xl font-bold tracking-tight">
            Pulse<span className="text-blue-400">EDU</span>
          </div>
          <div className="text-sm text-white/70 text-center">
            Choose a new password
          </div>
        </div>

        <div className="bg-slate-900/40 border border-white/10 rounded-lg px-3 py-2 text-sm">
          <div className="text-white/60 text-xs">Account</div>
          <div className="font-medium">{info.email}</div>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm text-white/80">New password</span>
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            className="bg-slate-900/60 border border-white/20 rounded-lg px-3 py-2.5 text-base outline-none focus:border-blue-400"
          />
          <span className="text-xs text-white/50">Minimum 8 characters.</span>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm text-white/80">Confirm password</span>
          <input
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            disabled={busy}
            className="bg-slate-900/60 border border-white/20 rounded-lg px-3 py-2.5 text-base outline-none focus:border-blue-400"
          />
        </label>

        {otpStep && (
          <label className="flex flex-col gap-1.5">
            <span className="text-sm text-white/80">
              6-digit code from your authenticator app
            </span>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              pattern="\d{6}"
              autoFocus
              value={code}
              onChange={(e) =>
                setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
              }
              disabled={busy}
              className="bg-slate-900/60 border border-white/20 rounded-lg px-3 py-2.5 text-base outline-none focus:border-blue-400 tracking-[0.4em] text-center font-mono"
            />
          </label>
        )}

        {error && (
          <div className="bg-red-500/15 border border-red-500/40 text-red-200 px-3 py-2 rounded-lg text-sm">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={busy || password.length < 8}
          className="bg-blue-500 hover:bg-blue-400 disabled:bg-blue-500/40 disabled:cursor-not-allowed text-white font-semibold rounded-lg py-2.5 transition-colors"
        >
          {busy ? "Saving…" : "Set new password"}
        </button>
      </form>
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-slate-900 to-slate-800 text-white p-6">
      {children}
    </div>
  );
}
