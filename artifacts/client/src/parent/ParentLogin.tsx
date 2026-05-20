import { useState } from "react";
import { Heart } from "lucide-react";
import { setParentToken, navigate, type ParentMe } from "./api";
import { setCsrfToken } from "../lib/csrf";

export default function ParentLogin({
  onLoggedIn,
  initialError,
}: {
  onLoggedIn: (me: ParentMe) => void;
  initialError?: string;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError ?? "");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/parent-auth/login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? `Sign-in failed (${res.status})`);
        return;
      }
      const body = await res.json();
      if (body.authToken) setParentToken(body.authToken);
      if (body.csrfToken) setCsrfToken(body.csrfToken);
      // Pull /me to get the linked-students list, then hand off.
      const meRes = await fetch("/api/parent-auth/me", {
        credentials: "include",
        headers: body.authToken
          ? { Authorization: `Bearer ${body.authToken}` }
          : {},
      });
      if (!meRes.ok) {
        setError("Signed in but could not load your account.");
        return;
      }
      const me = (await meRes.json()) as ParentMe;
      if (me.authToken) setParentToken(me.authToken);
      if (me.csrfToken) setCsrfToken(me.csrfToken);
      onLoggedIn(me);
      navigate("/parent");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-slate-900 to-slate-800 text-white p-6">
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
          <div className="text-sm text-white/70">Parent sign-in</div>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm text-white/80">Email</span>
          <input
            type="email"
            autoComplete="username"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
            className="bg-slate-900/60 border border-white/20 rounded-lg px-3 py-2.5 text-base outline-none focus:border-blue-400"
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm text-white/80">Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            className="bg-slate-900/60 border border-white/20 rounded-lg px-3 py-2.5 text-base outline-none focus:border-blue-400"
          />
        </label>

        {error && (
          <div className="bg-red-500/15 border border-red-500/40 text-red-200 px-3 py-2 rounded-lg text-sm">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={busy || !email.trim() || !password}
          className="bg-blue-500 hover:bg-blue-400 disabled:bg-blue-500/40 disabled:cursor-not-allowed text-white font-semibold rounded-lg py-2.5 transition-colors"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>

        <div className="text-xs text-white/60 text-center mt-2">
          Don't have an account yet? Your school sends an invite by email.
        </div>
      </form>
    </div>
  );
}
