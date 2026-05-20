import { useEffect, useState } from "react";
import { Heart, CheckCircle2 } from "lucide-react";
import { setParentToken, navigate, type ParentMe } from "./api";
import { setCsrfToken } from "../lib/csrf";

interface InviteInfo {
  studentFirstName: string;
  studentLastName: string;
  studentGrade: number;
  email: string;
  alreadyHasAccount: boolean;
  alreadyAccepted: boolean;
}

export default function AcceptInvite({
  token,
  onAccepted,
}: {
  token: string;
  onAccepted: (me: ParentMe) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [error, setError] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/parent-auth/invite/${encodeURIComponent(token)}`,
          { credentials: "include" },
        );
        if (cancelled) return;
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(body.error ?? "This invite link is no longer valid.");
        } else {
          setInfo((await res.json()) as InviteInfo);
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
    if (!info?.alreadyHasAccount && password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/parent-auth/accept-invite", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          password,
          displayName: displayName.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? `Could not accept invite (${res.status})`);
        return;
      }
      const body = await res.json();
      if (body.authToken) setParentToken(body.authToken);
      if (body.csrfToken) setCsrfToken(body.csrfToken);
      // Pull /me so the parent app can render with student list.
      const meRes = await fetch("/api/parent-auth/me", {
        credentials: "include",
        headers: body.authToken
          ? { Authorization: `Bearer ${body.authToken}` }
          : {},
      });
      const me = (await meRes.json()) as ParentMe;
      if (me.authToken) setParentToken(me.authToken);
      if (me.csrfToken) setCsrfToken(me.csrfToken);
      onAccepted(me);
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
        <div className="text-white/70 text-sm">Loading invite…</div>
      </Centered>
    );
  }

  if (!info) {
    return (
      <Centered>
        <div className="bg-white/[0.06] border border-white/10 rounded-2xl p-8 max-w-md w-full text-center">
          <div className="text-lg font-semibold mb-2">Invite unavailable</div>
          <div className="text-sm text-white/70 mb-4">
            {error || "This invite link is no longer valid."}
          </div>
          <button
            onClick={() => navigate("/parent/login")}
            className="bg-blue-500 hover:bg-blue-400 text-white font-semibold rounded-lg px-4 py-2 text-sm"
          >
            Go to sign-in
          </button>
        </div>
      </Centered>
    );
  }

  if (info.alreadyAccepted) {
    return (
      <Centered>
        <div className="bg-white/[0.06] border border-white/10 rounded-2xl p-8 max-w-md w-full text-center">
          <CheckCircle2 className="h-10 w-10 text-green-400 mx-auto mb-2" />
          <div className="text-lg font-semibold mb-2">
            This invite was already accepted
          </div>
          <div className="text-sm text-white/70 mb-4">
            Sign in with your existing password.
          </div>
          <button
            onClick={() => navigate("/parent/login")}
            className="bg-blue-500 hover:bg-blue-400 text-white font-semibold rounded-lg px-4 py-2 text-sm"
          >
            Go to sign-in
          </button>
        </div>
      </Centered>
    );
  }

  const sibling = info.alreadyHasAccount;

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
            {sibling
              ? `Add ${info.studentFirstName} to your existing account`
              : `Create your parent account for ${info.studentFirstName} ${info.studentLastName}`}
          </div>
        </div>

        <div className="bg-slate-900/40 border border-white/10 rounded-lg px-3 py-2 text-sm">
          <div className="text-white/60 text-xs">Student</div>
          <div className="font-medium">
            {info.studentFirstName} {info.studentLastName} · Grade{" "}
            {info.studentGrade}
          </div>
        </div>

        <div className="bg-slate-900/40 border border-white/10 rounded-lg px-3 py-2 text-sm">
          <div className="text-white/60 text-xs">Your email</div>
          <div className="font-medium">{info.email}</div>
        </div>

        {!sibling && (
          <label className="flex flex-col gap-1.5">
            <span className="text-sm text-white/80">Your name</span>
            <input
              type="text"
              autoComplete="name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              disabled={busy}
              placeholder="e.g. Sarah Rodriguez"
              className="bg-slate-900/60 border border-white/20 rounded-lg px-3 py-2.5 text-base outline-none focus:border-blue-400"
            />
          </label>
        )}

        <label className="flex flex-col gap-1.5">
          <span className="text-sm text-white/80">
            {sibling ? "Your existing password" : "Create a password"}
          </span>
          <input
            type="password"
            autoComplete={sibling ? "current-password" : "new-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            className="bg-slate-900/60 border border-white/20 rounded-lg px-3 py-2.5 text-base outline-none focus:border-blue-400"
          />
          {!sibling && (
            <span className="text-xs text-white/50">
              Minimum 8 characters.
            </span>
          )}
        </label>

        {!sibling && (
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
          {busy
            ? "Working…"
            : sibling
              ? `Add ${info.studentFirstName}`
              : "Create account"}
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
